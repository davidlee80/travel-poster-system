import {
  checkDatabase,
  createCreditWalletRepository,
  createExportsRepository,
  createPool,
  createPresentationsRepository,
  loadDbConfig,
} from '@tps/db';
import {
  metricsContentType,
  metricsText,
  registerDefaultMetrics,
  loadTracingConfig,
  startTracing,
} from '@tps/observability';
import {
  EXPORT_QUEUE_NAME,
  ExportJobPayloadSchema,
  RedisDeadLetterQueue,
  createQueueRedis,
  createRedis,
  withRestoredTrace,
} from '@tps/queue';
import { optionalBool, optionalString, requireString, runWorker } from '@tps/shared';
import { S3ExportStorage, loadExportsStorageConfig } from '@tps/storage';
import { UnrecoverableError, Worker } from 'bullmq';

import { createBrowserHolder } from './browser-holder.js';
import { EXPORT_LABEL_NONE, exportDuration, exportTotal } from './export-metrics.js';
import { createExportBilling, type ExportBilling } from './billing.js';
import { runExport } from './run-export.js';

/**
 * 渲染 Worker（TP-4-12）。
 *
 * 独立于 generation-worker 的原因（设计稿 22.2）：本服务镜像需要 Chromium
 * 与中文字体（约 1.2GB），合并会让所有 Worker 都背上这个体积。
 *
 * 职责范围：
 *   P1  Playwright 浏览器池、就绪与字体断言、溢出检测与重渲染、PNG/PDF 导出
 *   P4  导出任务队列消费、PARTIAL 结果  ← 本增量
 *
 * ## 一个 browser，多个 context
 *
 * 21.2：「页面渲染（Playwright）：单 Worker 3 个 page，共用 1 个 browser ——
 * 启动浏览器是最贵的一步」。因此 browser 在进程启动时开一次，
 * 每个导出任务开自己的 context（`runExport` 内部），并发由 BullMQ 的
 * `concurrency` 控制。
 *
 * 容器必须以 tini/--init 作为 PID 1（22.3.1），否则 Chromium 的子进程
 * 会变成僵尸进程。
 */

const SERVICE_NAME = 'tps-render-worker';

registerDefaultMetrics(SERVICE_NAME);

const dbPool = createPool(loadDbConfig());
const redisUrl = requireString('REDIS_URL');
const redis = createRedis(redisUrl);
const queueRedis = createQueueRedis(redisUrl);

const exportsRepository = createExportsRepository(dbPool);

/*
 * CR 退款（C-4b）。默认**关闭**，与 api / generation-worker 同一个开关名。
 *
 * 只开这一侧不会出错（没有扣费记录就什么都不退），但只开 api 那一侧的话，
 * 渲染失败的导出不会退钱 —— 用户为一份拿不到的 PDF 付了费。
 * 三个进程的启动日志都打了 `credit_billing_enabled`，值不一致时能一眼看到。
 */
const billingEnabled = optionalBool('CREDIT_BILLING_ENABLED', false);
const presentations = createPresentationsRepository(dbPool);
const storage = new S3ExportStorage(loadExportsStorageConfig());
const deadLetters = new RedisDeadLetterQueue(redis);

/*
 * 渲染要访问的是 **web 服务**（17.1 的渲染路由），不是 API。
 * 与 INTERNAL_API_BASE 分开：那是 web → api 的方向，这里是 render → web。
 */
const renderBaseUrl = optionalString('RENDER_BASE_URL', 'http://localhost:3000');
const signingKey = requireString('RENDER_SIGNING_KEY');

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3012,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),
  // TP-5-03：未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时返回 null，全程 no-op
  tracing: () => startTracing(loadTracingConfig(SERVICE_NAME)),

  start: async (handle) => {
    const billing: ExportBilling | undefined = billingEnabled
      ? createExportBilling({
          wallet: createCreditWalletRepository(dbPool),
          logger: handle.logger,
        })
      : undefined;

    const browsers = createBrowserHolder({ logger: handle.logger });
    /*
     * 启动时先取一次：让「拉不起 Chromium」在就绪日志之前就暴露，
     * 而不是等第一个导出任务才发现 —— 后者会把一个启动期配置问题
     * 变成一次用户可见的导出失败。
     */
    await browsers.get();
    handle.logger.info(
      {
        devShm: browsers.devShm?.reason ?? '(未探测)',
        base_url: renderBaseUrl,
        /* 关闭时渲染失败不退款 —— 这一条必须能从启动日志里一眼看到 */
        credit_billing_enabled: billingEnabled,
      },
      '渲染 Worker 就绪，开始消费导出队列',
    );

    const worker = new Worker(
      EXPORT_QUEUE_NAME,
      async (job) => {
        const payload = ExportJobPayloadSchema.parse(job.data);

        /*
         * 在 api 侧那次导出请求的 trace 里继续（TP-5-03，21.3）。
         * 21.3 要求链路覆盖到 Playwright 与对象存储 —— 而这两段都在
         * `runExport` 里面，因此包在它外层。
         */
        return withRestoredTrace(payload.traceContext, async () => {
          const startedAt = Date.now();
          const outcome = await runExport(
            {
              exports: exportsRepository,
              presentations,
              storage,
              /*
               * 每任务取一次而不是闭包捕一个固定句柄（R-84）。
               * Chromium 崩溃后那个句柄从此是死的，而原先会让
               * **后续每一个导出都失败**，直到有人重启进程。
               */
              browser: await browsers.get(),
              baseUrl: renderBaseUrl,
              signingKey,
              logger: handle.logger,
              ...(billing === undefined ? {} : { billing }),
            },
            payload.exportId,
          );

          /*
           * 21.3 要求 `travel_export_total` 带 format / scope（验收标准 10 要
           * 按格式读成功率），R-13 再加身份维度。`skipped` 没有这些信息，
           * 用 `none` 占位 —— 理由见 export-metrics.ts。
           */
          exportTotal.inc(
            outcome.kind === 'skipped'
              ? {
                  format: EXPORT_LABEL_NONE,
                  scope: EXPORT_LABEL_NONE,
                  outcome: outcome.kind,
                  user_type: EXPORT_LABEL_NONE,
                }
              : {
                  format: outcome.format,
                  scope: outcome.scope,
                  outcome: outcome.kind,
                  user_type: outcome.userType,
                },
          );
          /*
           * 耗时只对真的跑过渲染的结局记录：`skipped` 的耗时是一次数据库查询，
           * 混进直方图会把 P95 拉低到毫秒级，而 21.2 的目标是按「渲染了」算的。
           */
          if (outcome.kind !== 'skipped') {
            exportDuration.observe(
              { format: outcome.format, scope: outcome.scope, outcome: outcome.kind },
              (Date.now() - startedAt) / 1000,
            );
          }

          /*
           * 每次导出的结局都要落一行日志。
           *
           * 在此之前这里只记指标，于是 `docker logs` 里除了两行启动信息什么
           * 都没有 —— 一次导出失败在日志中的痕迹为**零**，排查只能去翻
           * `exports` 表的 `error_detail`，而那需要先知道 export_id。
           * 指标能告诉你「失败率上升了」，日志才能告诉你「哪一次、为什么」。
           *
           * 失败用 error 级：16.3 说导出失败对用户非阻断（可退回网页版），
           * 但对运维不是 —— 它意味着渲染链路有问题。
           */
          const summary = {
            export_id: payload.exportId,
            outcome: outcome.kind,
            duration_ms: Date.now() - startedAt,
            ...(outcome.kind === 'skipped'
              ? { reason: outcome.reason }
              : { format: outcome.format, scope: outcome.scope }),
            ...(outcome.kind === 'completed' || outcome.kind === 'partial'
              ? { files: outcome.files }
              : {}),
            ...(outcome.kind === 'partial' ? { failed_days: outcome.failed } : {}),
            ...(outcome.kind === 'failed' ? { error_code: outcome.errorCode } : {}),
          };
          if (outcome.kind === 'failed') {
            handle.logger.error(summary, '导出失败');
          } else if (outcome.kind === 'partial') {
            handle.logger.warn(summary, '导出部分成功');
          } else {
            handle.logger.info(summary, '导出完成');
          }

          /*
           * 16.3：导出失败**非阻断**（重试 1 次后跳过，记 warnings）。
           * 但队列层仍要知道这次失败了 —— 否则第一次失败就被当成成功，
           * 那次重试机会白白浪费。`exports` 行此刻已经是 FAILED 且带错误码，
           * 用户能看到明确结果；重试成功后状态会被推回 COMPLETED。
           */
          if (outcome.kind === 'failed') throw new Error(outcome.errorCode);

          /*
           * `not_queued` 说明另一个消费者已经在处理（或已完成）。
           * 用 UnrecoverableError 结束：重试只会再撞一次同样的状态检查。
           */
          if (outcome.kind === 'skipped' && outcome.reason === 'not_queued') {
            throw new UnrecoverableError('EXPORT_ALREADY_PROCESSING');
          }
        });
      },
      {
        connection: queueRedis,
        /*
         * 21.2：单 Worker 3 个 page。这里的并发是**任务级**的，
         * 而一个 ALL_DAYS 任务内部是串行渲染的（见 run-export.ts），
         * 因此在途 page 数就等于并发任务数。
         */
        concurrency: 3,
      },
    );

    // 13.7：重试耗尽后进入死信队列（与生成侧同一处理，见 generation-worker）
    worker.on('failed', (job, error) => {
      if (job === undefined) return;
      const exhausted =
        error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 2);
      if (!exhausted) return;

      const parsed = ExportJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) return;

      void deadLetters
        .push(EXPORT_QUEUE_NAME, {
          jobId: parsed.data.exportId,
          /*
           * 导出的死信只有 export_id 一个标识符可用 —— 其余三个 ID 要回表才有，
           * 而死信入队发生在失败路径上，那时数据库可能正是失败原因。
           * 用同一个 ID 填满三个字段会让回捞时误以为它们有意义，因此填空串。
           */
          requestId: '',
          planId: '',
          userId: '',
          errorCode: error.message,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        })
        .catch((pushError: unknown) => {
          handle.logger.error({}, `导出死信入队失败：${String(pushError)}`);
        });
    });

    return async () => {
      handle.logger.info('渲染 Worker 停止领取新任务');
      // 先 pause 停止领新任务，再 close 等在途渲染跑完，最后关浏览器
      await worker.pause(true);
      await worker.close();
      await browsers.close();
      storage.destroy();
      await redis.quit();
      await queueRedis.quit();
      await dbPool.end();
    };
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
