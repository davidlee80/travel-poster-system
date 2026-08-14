import { runWorker } from '@tps/shared';
import { metricsContentType, metricsText, registerDefaultMetrics } from '@tps/observability';

/**
 * 生成 Worker（P0 骨架）。
 *
 * 职责范围（设计稿 3.2、3.3、3.2.4、22.2）：
 *   P2  标准化、历史检索、LLM 生成、校验、修复、持久化
 *   P3  展示编排、脱敏投影、素材解析
 *   P4  AI 素材兜底、缓存、状态机
 *
 * P0 只建立进程骨架：探针、指标、优雅停机。队列消费在 P2 接入 BullMQ。
 */

const SERVICE_NAME = 'tps-generation-worker';

registerDefaultMetrics(SERVICE_NAME);

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3011,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),

  start: (handle) => {
    handle.logger.info('生成 Worker 骨架就绪；队列消费将在 P2（TP-2-09）接入');

    // P2 起：此处 new Worker(queueName, processor)，
    // 停止时先 worker.pause() 停止领新任务，再 worker.close() 等在途任务完成。
    return Promise.resolve(async () => {
      handle.logger.info('生成 Worker 停止领取新任务');
      await Promise.resolve();
    });
  },
});
