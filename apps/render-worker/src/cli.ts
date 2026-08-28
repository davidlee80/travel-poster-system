#!/usr/bin/env node
import { createLogger } from '@tps/shared';

import { parseArgs } from './cli-args.js';
import { exportPlan } from './export-plan.js';
import { RenderError } from './errors.js';

/**
 * `render:fixture` CLI（P1 门禁，设计稿二十三章第一阶段）。
 *
 *   pnpm render:fixture -- --days 14 --format all
 *   pnpm render:fixture -- --days 1 --template blueprint_v1
 *
 * 目的是在引入 LLM 与数据库之前，用静态 fixture 证明
 * 「模板 → HTML → PNG/PDF」这条链路可行 —— 这是渲染链路唯一无法
 * 通过降级绕过的环节（16.3 中 RENDER_TEMPLATE_FAILED 是硬阻断）。
 *
 * 需要 web 服务已在运行。CI 与 compose 里由 `web` 服务提供，
 * 本地用 `pnpm --filter @tps/web dev`。
 */

const options = parseArgs(process.argv.slice(2), process.env);
const logger = createLogger({ service: 'tps-render-fixture' });

// fixture 的 plan_version_id 形态由渲染路由约定：`fixture-N` 指定天数
const planVersionId = `fixture-${options.days}`;

logger.info(
  {
    planVersionId,
    days: options.days,
    formats: options.formats,
    baseUrl: options.baseUrl,
    outputDir: options.outputDir,
    templateId: options.templateId,
  },
  '开始导出 fixture',
);

try {
  const report = await exportPlan({
    baseUrl: options.baseUrl,
    planVersionId,
    signingKey: options.signingKey,
    days: Array.from({ length: options.days }, (_, index) => index + 1),
    formats: options.formats,
    outputDir: options.outputDir,
    templateId: options.templateId,
    logger,
  });

  const ratios = report.days
    .map((day) => day.pngCompressionRatio)
    .filter((ratio): ratio is number => ratio !== null);

  logger.info(
    {
      days: report.days.length,
      degradedDays: report.degradedDays,
      mergedPdfPages: report.mergedPdf?.pages ?? null,
      // TP-1-21 验收：压缩率 ≥ 20%
      minPngCompressionRatio: ratios.length > 0 ? Number(Math.min(...ratios).toFixed(3)) : null,
    },
    '导出完成',
  );

  /*
   * 降级不算失败（16.3：RENDER_OVERFLOW_UNRESOLVED 不阻断），但必须显式提示 ——
   * 否则「fixture 一直是降级产出」这件事会在无人注意的情况下变成常态，
   * 而视觉基线也就锁定在降级版式上。
   */
  if (report.degradedDays.length > 0) {
    logger.warn(
      { degradedDays: report.degradedDays },
      '这些天在四轮重渲染后仍有溢出，产物已标记 DEGRADED（17.3）',
    );
  }
} catch (error) {
  if (error instanceof RenderError) {
    logger.error({ code: error.code, detail: error.detail }, error.message);
  } else {
    logger.error({ err: error }, '导出失败');
  }
  process.exitCode = 1;
}
