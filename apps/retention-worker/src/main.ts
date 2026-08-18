import { checkDatabase, createPool, createRetentionRepository, loadDbConfig } from '@tps/db';
import { metricsContentType, metricsText, registerDefaultMetrics } from '@tps/observability';
import { optionalInt, runWorker } from '@tps/shared';

import { PURGE_BATCH_SIZE, PURGE_GRACE_DAYS, runPurgeRound } from './purge.js';

/**
 * 保留期清理 Worker（TP-4-21/22/24，设计稿 15.1）。
 *
 * ```text
 * 每日一轮：扫描到期匿名 users 行（走 users_anon_expiry_idx）
 *   → 转存 retrieval_projection + plan_embedding 到 plan_knowledge
 *   → 再级联删除（同一事务，见 @tps/db 的 retention.ts）
 * ```
 *
 * ## 为什么是进程内定时器而不是 K8s CronJob
 *
 * CronJob 每次拉起一个新 Pod：镜像拉取 + 连接池建立 + 迁移检查，
 * 而实际工作可能只有几秒。更麻烦的是**优雅停机**：清理任务被 SIGTERM
 * 打断时必须让当前用户的事务跑完（15.1 的顺序不可颠倒），
 * 而那需要与 `GracefulShutdown` 协作 —— CronJob 里没有这套机制。
 *
 * 常驻进程 + 进程内定时器让排空信号可用（`handle.isDraining()`），
 * 代价是一个几乎全天空闲的 Pod。这个代价可接受：它与探针共用进程，
 * 内存占用是几十 MB。
 *
 * ## 单实例假设
 *
 * 多副本会让同一批到期用户被两个进程同时扫到。第二个进程的删除会改 0 行
 * （第一个已经删了），转存则可能重复插入 —— `plan_knowledge` 没有唯一约束
 * （它本来就允许同一目的地多条知识），因此重复不会报错，只会让知识库里
 * 多一份一样的行。
 *
 * 因此这个 Worker **必须单副本部署**（`replicas: 1`）。这一条写在这里
 * 而不是只写在部署清单里：它是代码的前提，而部署清单会被复制粘贴。
 */

const SERVICE_NAME = 'tps-retention-worker';

registerDefaultMetrics(SERVICE_NAME);

const dbPool = createPool(loadDbConfig());
const retention = createRetentionRepository(dbPool);

/**
 * 轮询间隔。默认 24 小时（15.1「每日一次」）。
 *
 * 可配置是为了让集成测试与预发环境能把它调短 —— 而不是为了在生产调频：
 * 调频前应当先看 `travel_anon_purge_total` 是否真的追不上（见 purge.ts）。
 */
const intervalMs = optionalInt('RETENTION_INTERVAL_MS', 24 * 60 * 60 * 1000);
const batchSize = optionalInt('RETENTION_BATCH_SIZE', PURGE_BATCH_SIZE);
const graceDays = optionalInt('ANON_RETENTION_GRACE_DAYS', PURGE_GRACE_DAYS);

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3013,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),

  start: (handle) => {
    handle.logger.info(
      { batch_size: batchSize, grace_days: graceDays },
      `保留期 Worker 就绪，每 ${Math.round(intervalMs / 1000)} 秒扫描一次`,
    );

    let running: Promise<unknown> = Promise.resolve();

    const tick = (): void => {
      if (handle.isDraining()) return;
      /*
       * 串行：上一轮没跑完就不开下一轮。清理是幂等的（到期谓词不变），
       * 但两轮并行会让同一批用户被两个事务争抢 —— 与多副本同一个问题。
       */
      running = running
        .then(() =>
          runPurgeRound({
            retention,
            logger: handle.logger,
            batchSize,
            graceDays,
            isDraining: () => handle.isDraining(),
          }),
        )
        .catch((error: unknown) => {
          /*
           * 一轮整体失败（多数是数据库不可用）不让进程退出：
           * 下一个周期会重试，而重启进程对一个每天只跑一次的任务没有意义。
           */
          handle.logger.error({}, `保留期清理整轮失败：${String(error)}`);
        });
    };

    /*
     * 启动时立刻跑一轮，而不是等第一个周期。
     * 理由是部署频率：一个每天跑一次的任务，如果每次发布都重置计时器，
     * 那么在一个发布密集的周里它可能一次都没跑过 —— 而没跑过这件事
     * 只能靠指标发现（见 retention-metrics.ts）。
     */
    tick();
    const timer = setInterval(tick, intervalMs);
    // 定时器不该拖住进程退出（停机由 GracefulShutdown 管）
    timer.unref();

    return Promise.resolve(async () => {
      handle.logger.info('保留期 Worker 停止调度新批次');
      clearInterval(timer);
      /*
       * 等当前这一轮跑完再退出。中断在「已删除 users 行但未转存知识」之间
       * 不会造成不可恢复的损失（两者同一事务），但让当前用户的事务被
       * 连接池强行关掉会留下一条需要人工确认的日志 —— 等几秒更省事。
       */
      await running;
      await dbPool.end();
    });
  },

  checkDependencies: async () => {
    const detail = { postgres: false };
    try {
      detail.postgres = (await checkDatabase(dbPool)).ok;
    } catch {
      detail.postgres = false;
    }
    return { ok: detail.postgres, detail };
  },
});
