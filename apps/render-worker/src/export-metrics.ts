import { createCounter, createHistogram } from '@tps/observability';

/**
 * 导出链路的指标（TP-4-12，设计稿 21.3）。
 *
 * `travel_export_total` 是验收标准 10（「HTML、PNG、PDF 至少两种可用」）的
 * 度量依据：按 `outcome` 拆开就能读出「PDF 的成功率」与「PARTIAL 占比」。
 *
 * `outcome` 用 `runExport` 的四种结局（completed / partial / failed / skipped）
 * 而不是 `exports.status`：后者还有 QUEUED / RENDERING 两个中间态，
 * 而计数器要的是**终局**。混进中间态会让「成功率」的分母包含还没跑完的任务。
 */
export const exportTotal = createCounter({
  name: 'travel_export_total',
  help: '导出任务结局',
  labelNames: ['outcome'],
});

/**
 * 21.2 的导出耗时目标：单页 PNG < 8 秒、单页 PDF < 10 秒、
 * ALL_DAYS 的 14 页 PDF 合并 < 15 秒。
 *
 * 按 `format` 与 `scope` 分开：三个目标的量级不同，混在一个直方图里
 * 读不出任何一条是否达标。
 */
export const exportDuration = createHistogram({
  name: 'travel_export_duration_seconds',
  help: '导出任务耗时（21.2 的分环节目标）',
  labelNames: ['format', 'scope', 'outcome'],
  buckets: [1, 2, 5, 8, 10, 15, 20, 30, 60, 120, 240],
});
