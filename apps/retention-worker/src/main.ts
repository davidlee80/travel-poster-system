import { runWorker } from '@tps/shared';
import { metricsContentType, metricsText, registerDefaultMetrics } from '@tps/observability';

/**
 * 保留期清理 Worker（P0 骨架，R-13）。
 *
 * 职责范围（设计稿 15.1）：
 *   P4  每日扫描到期匿名 users 行 → **先把 retrieval_projection 与
 *       plan_embedding 转存到 plan_knowledge** → 再分批级联删除
 *
 * 顺序不可颠倒：先删后转存会永久损失行程知识（3.2.4 的全局检索会持续失血）。
 * 清理删除的是「谁何时去哪花多少」，保留的是「杭州运河主题 5 天可以这样安排」。
 *
 * P0 只建立进程骨架。清理逻辑在 P4（TP-4-20～25）实现。
 */

const SERVICE_NAME = 'tps-retention-worker';

registerDefaultMetrics(SERVICE_NAME);

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3013,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),

  start: (handle) => {
    handle.logger.info('保留期 Worker 骨架就绪；清理与知识转存将在 P4（TP-4-21/22）接入');

    // P4 起：每日定时任务。分批 500，每批一个事务。
    // 排空时必须让当前批次完成再退出 —— 中断在"已删除 users 行但未转存知识"
    // 之间会造成不可恢复的知识损失。
    return Promise.resolve(async () => {
      handle.logger.info('保留期 Worker 停止调度新批次');
      await Promise.resolve();
    });
  },
});
