import {
  checkDatabase,
  createAssetsRepository,
  createPool,
  createPresentationsRepository,
  createRetrievalRepository,
  createTravelPlansRepository,
  loadDbConfig,
} from '@tps/db';
import {
  FakeLlmClient,
  LocalHashingEmbeddingClient,
  createImageClient,
  createLlmClient,
  loadImageConfig,
  loadLlmConfig,
} from '@tps/llm';
import {
  metricsContentType,
  metricsText,
  registerDefaultMetrics,
  loadTracingConfig,
  startTracing,
} from '@tps/observability';
import {
  DEFAULT_JOB_OPTIONS,
  GenerationJobPayloadSchema,
  PLAN_QUEUE_NAME,
  RedisAssetLock,
  RedisCounterStore,
  RedisDeadLetterQueue,
  RedisJobLock,
  createQueueRedis,
  createRedis,
  withRestoredTrace,
} from '@tps/queue';
import { S3ObjectStorage, loadAssetsStorageConfig } from '@tps/storage';
import { loadQuotaConfig, optionalInt, quotaFor, requireString, runWorker } from '@tps/shared';
import { UnrecoverableError, Worker } from 'bullmq';

import { AiImageBudget, DEFAULT_AI_IMAGE_DAILY_BUDGET } from './assets/ai-budget.js';
import { isUnrecoverable } from './retry-policy.js';
import { renderFakeGeneratedImage } from './assets/fake-image.js';
import { fixturePlanFor } from './fixture-plan.js';
import { generatePlan, type LlmClientFactory } from './generate-plan.js';

/**
 * 生成 Worker。
 *
 * 职责范围（设计稿 3.2、3.3、3.2.4、22.2）：
 *   P2  标准化读回、历史检索、LLM 生成、校验、修复、持久化
 *   P3  展示编排、素材解析
 *   P4  AI 素材兜底、并发去重、成本上限与熔断  ← 本增量
 */

const SERVICE_NAME = 'tps-generation-worker';

registerDefaultMetrics(SERVICE_NAME);

const dbPool = createPool(loadDbConfig());
const redisUrl = requireString('REDIS_URL');
const redis = createRedis(redisUrl);
const queueRedis = createQueueRedis(redisUrl);

const plans = createTravelPlansRepository(dbPool);
const retrievalRepository = createRetrievalRepository(dbPool);
const assetsRepository = createAssetsRepository(dbPool);
const presentationsRepository = createPresentationsRepository(dbPool);
const jobLock = new RedisJobLock(redis);
const assetLock = new RedisAssetLock(redis);
const deadLetters = new RedisDeadLetterQueue(redis);
const counters = new RedisCounterStore(redis);
const storage = new S3ObjectStorage(loadAssetsStorageConfig());

/*
 * `fake` 模式（默认）的录制输出按请求构造：天数、目的地、硬约束都要与
 * 请求对得上，否则每个请求都会因 V-01 / V-30 走到 REJECTED
 * —— 也就是默认配置下的 Worker 处理不了任何请求（见 fixture-plan.ts）。
 */
const llmConfig = loadLlmConfig();
const llm: LlmClientFactory | ReturnType<typeof createLlmClient> =
  llmConfig.mode === 'fake'
    ? (normalized) => new FakeLlmClient([fixturePlanFor(normalized)])
    : createLlmClient(llmConfig);
const embedding = new LocalHashingEmbeddingClient();

/*
 * 图片模型（P4）。`fake` 模式由本进程注入渲染函数 —— @tps/llm 不依赖 sharp
 * （它被所有应用引用），因此渲染必须在这里（见 assets/fake-image.ts）。
 */
const imageConfig = loadImageConfig();
const image = createImageClient(imageConfig, { renderer: renderFakeGeneratedImage });
const quotaConfig = loadQuotaConfig();
const aiDailyBudget = optionalInt('AI_IMAGE_DAILY_BUDGET', DEFAULT_AI_IMAGE_DAILY_BUDGET);

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3011,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),
  // TP-5-03：未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时返回 null，全程 no-op
  tracing: () => startTracing(loadTracingConfig(SERVICE_NAME)),

  start: (handle) => {
    handle.logger.info(
      {
        llm_mode: llmConfig.mode,
        llm_model: llmConfig.model || '(fake)',
        image_mode: imageConfig.mode,
        image_model: imageConfig.model || '(fake)',
      },
      '生成 Worker 就绪，开始消费队列',
    );

    const worker = new Worker(
      PLAN_QUEUE_NAME,
      async (job) => {
        const payload = GenerationJobPayloadSchema.parse(job.data);

        /*
         * 在 api 侧那次请求的 trace 里继续（TP-5-03，21.3）。
         *
         * `withRestoredTrace` 之内产生的每个 span（数据库、Redis、模型调用）
         * 都挂在同一个 trace 下，日志也自动带上同一个 `trace_id`
         * （见 @tps/shared 的 logger mixin）。未装配 SDK 时它只是直接执行 fn。
         *
         * 包在最外层而不是只包 `generatePlan`：锁的获取与失败分类同样属于
         * 这次消费，而「为什么这条消息被跳过了」是排查时的常见问题。
         */
        return withRestoredTrace(payload.traceContext, async () => {
          /*
           * 13.8：同一 job_id 只允许一个消费者。抢不到锁说明另一个实例正在
           * 处理 —— 直接返回而不是等待，等待会占住 BullMQ 的并发槽位。
           */
          if (!(await jobLock.acquire(payload.jobId))) {
            handle.logger.warn({ job_id: payload.jobId }, '任务已被其他实例持有，跳过');
            return;
          }

          try {
            const outcome = await generatePlan(
              {
                plans,
                retrieval: { repository: retrievalRepository, embedding },
                llm,
                embedding,
                logger: handle.logger,
                llmTimeoutMs: llmConfig.timeoutMs,
                presentation: {
                  assets: assetsRepository,
                  presentations: presentationsRepository,
                  storage,
                  embedding,
                },
                /*
                 * 每任务一个预算实例（21.4 的 3 张图与 21.2 的 2 次 Hero 都是
                 * 单任务计数），额度上限按身份取（匿名的 AI Hero 为 0，TP-4-17）。
                 */
                aiAssets: (userType) => ({
                  image,
                  assetLock,
                  imageTimeoutMs: imageConfig.timeoutMs,
                  userTypeLabel: userType,
                  budget: new AiImageBudget({
                    counters,
                    userType,
                    heroQuota: quotaFor(quotaConfig, userType).aiHero,
                    dailyBudget: aiDailyBudget,
                  }),
                }),
              },
              payload,
            );

            /*
             * 13.7 第四层：不可重试的失败以 `UnrecoverableError` 结束消费 ——
             * BullMQ 见到它就不再重试，`attempts` 不被消耗。
             *
             * 抛错而不是静默返回，是因为 BullMQ 只按「消费函数是否抛错」判定
             * 成败：静默返回会让一个失败的任务在队列里显示为成功，
             * 而排查时「任务失败了但队列说成功」是最难定位的一类不一致。
             */
            if (outcome.outcome === 'failed' && isUnrecoverable(outcome.errorCode)) {
              throw new UnrecoverableError(outcome.errorCode);
            }

            /*
             * 可重试的失败照常抛错，交给队列退避重试（13.7 第三层）。
             * 任务状态已经是 FAILED 且带错误码 —— 用户此刻能看到明确的失败，
             * 而重试成功后状态会被推回去。
             */
            if (outcome.outcome === 'failed') {
              throw new Error(outcome.errorCode);
            }
          } finally {
            await jobLock.release(payload.jobId);
          }
        });
      },
      {
        connection: queueRedis,
        /*
         * 单实例并发 2：生成的瓶颈是 LLM 的等待而不是本地 CPU，
         * 但每个在途任务都占着一个数据库连接与一份 LLM 额度。
         * 21.4 的单任务成本上限是按「一次主生成 + 最多 2 次重生成」估的，
         * 并发太高会让成本峰值失控。
         */
        concurrency: 2,
      },
    );

    /*
     * 13.7：队列重试耗尽后进入死信队列 `dlq:*`。
     *
     * 用 `failed` 事件而不是在消费函数里判断：消费函数不知道自己是第几次
     * 尝试之后就没有下一次了（`attemptsMade` 在函数内还没自增）。
     * 而漏掉最后一次的表现是「死信队列永远是空的」—— 看起来一切正常。
     */
    worker.on('failed', (job, error) => {
      if (job === undefined) return;
      const exhausted =
        error instanceof UnrecoverableError ||
        job.attemptsMade >= (job.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts ?? 1);
      if (!exhausted) return;

      const parsed = GenerationJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) return;

      void deadLetters
        .push(PLAN_QUEUE_NAME, {
          jobId: parsed.data.jobId,
          requestId: parsed.data.requestId,
          planId: parsed.data.planId,
          userId: parsed.data.userId,
          errorCode: error.message,
          attemptsMade: job.attemptsMade,
          // 时钟取 Worker 侧，与日志同源，便于按时间对齐排查
          failedAt: new Date().toISOString(),
        })
        .catch((pushError: unknown) => {
          handle.logger.error({ job_id: parsed.data.jobId }, `死信入队失败：${String(pushError)}`);
        });
    });

    return Promise.resolve(async () => {
      handle.logger.info('生成 Worker 停止领取新任务');
      // 先 pause 停止领新任务，再 close 等在途任务跑完
      await worker.pause(true);
      await worker.close();
      await redis.quit();
      await queueRedis.quit();
      await dbPool.end();
    });
  },

  checkDependencies: async () => {
    const detail = { postgres: false, redis: false };
    try {
      detail.postgres = (await checkDatabase(dbPool)).ok;
    } catch {
      detail.postgres = false;
    }
    try {
      detail.redis = (await redis.ping()) === 'PONG';
    } catch {
      detail.redis = false;
    }
    return { ok: detail.postgres && detail.redis, detail };
  },
});
