import {
  checkDatabase,
  createPool,
  createRetrievalRepository,
  createTravelPlansRepository,
  loadDbConfig,
} from '@tps/db';
import {
  FakeLlmClient,
  LocalHashingEmbeddingClient,
  createLlmClient,
  loadLlmConfig,
} from '@tps/llm';
import { metricsContentType, metricsText, registerDefaultMetrics } from '@tps/observability';
import {
  GenerationJobPayloadSchema,
  PLAN_QUEUE_NAME,
  RedisJobLock,
  createQueueRedis,
  createRedis,
} from '@tps/queue';
import { requireString, runWorker } from '@tps/shared';
import { Worker } from 'bullmq';

import { fixturePlanFor } from './fixture-plan.js';
import { generatePlan, type LlmClientFactory } from './generate-plan.js';

/**
 * 生成 Worker。
 *
 * 职责范围（设计稿 3.2、3.3、3.2.4、22.2）：
 *   P2  标准化读回、历史检索、LLM 生成、校验、修复、持久化  ← 本增量
 *   P3  展示编排、素材解析
 *   P4  AI 素材兜底、缓存、导出
 *
 * P2 的任务推进到 `SAVING_PLAN` 为止，不进入 `COMPLETED`
 * （理由见 generate-plan.ts 的文件头）。
 */

const SERVICE_NAME = 'tps-generation-worker';

registerDefaultMetrics(SERVICE_NAME);

const dbPool = createPool(loadDbConfig());
const redisUrl = requireString('REDIS_URL');
const redis = createRedis(redisUrl);
const queueRedis = createQueueRedis(redisUrl);

const plans = createTravelPlansRepository(dbPool);
const retrievalRepository = createRetrievalRepository(dbPool);
const jobLock = new RedisJobLock(redis);

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

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3011,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),

  start: (handle) => {
    handle.logger.info(
      { llm_mode: llmConfig.mode, llm_model: llmConfig.model || '(fake)' },
      '生成 Worker 就绪，开始消费队列',
    );

    const worker = new Worker(
      PLAN_QUEUE_NAME,
      async (job) => {
        const payload = GenerationJobPayloadSchema.parse(job.data);

        /*
         * 13.8：同一 job_id 只允许一个消费者。抢不到锁说明另一个实例正在
         * 处理 —— 直接返回而不是等待，等待会占住 BullMQ 的并发槽位。
         */
        if (!(await jobLock.acquire(payload.jobId))) {
          handle.logger.warn({ job_id: payload.jobId }, '任务已被其他实例持有，跳过');
          return;
        }

        try {
          await generatePlan(
            {
              plans,
              retrieval: { repository: retrievalRepository, embedding },
              llm,
              embedding,
              logger: handle.logger,
              llmTimeoutMs: llmConfig.timeoutMs,
            },
            payload,
          );
        } finally {
          await jobLock.release(payload.jobId);
        }
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
