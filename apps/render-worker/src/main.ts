import { runWorker } from '@tps/shared';
import { metricsContentType, metricsText, registerDefaultMetrics } from '@tps/observability';

/**
 * 渲染 Worker（P0 骨架）。
 *
 * 独立于 generation-worker 的原因（设计稿 22.2）：本服务镜像需要 Chromium
 * 与中文字体（约 1.2GB），合并会让所有 Worker 都背上这个体积。
 *
 * 职责范围：
 *   P1  Playwright 浏览器池、就绪与字体断言、溢出检测与重渲染、PNG/PDF 导出
 *   P4  导出任务队列消费、PARTIAL 结果
 *
 * P0 只建立进程骨架。Playwright 在 P1（TP-1-10、TP-1-17～21）接入。
 */

const SERVICE_NAME = 'tps-render-worker';

registerDefaultMetrics(SERVICE_NAME);

await runWorker({
  serviceName: SERVICE_NAME,
  probePort: 3012,
  metrics: async () => ({ contentType: metricsContentType, body: await metricsText() }),

  start: (handle) => {
    handle.logger.info('渲染 Worker 骨架就绪；Playwright 将在 P1（TP-1-10）接入');

    // P1 起：此处启动 browser（全进程一个实例，见 21.2 并发模型），
    // 停止时先停止领取渲染任务，再关闭全部 page，最后 browser.close()。
    // 注意容器必须以 tini/--init 作为 PID 1，否则 Chromium 子进程会变僵尸。
    return Promise.resolve(async () => {
      handle.logger.info('渲染 Worker 停止领取新任务');
      await Promise.resolve();
    });
  },
});
