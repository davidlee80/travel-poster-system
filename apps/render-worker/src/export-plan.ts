import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RENDER_PAGE_KEYS, issueRenderToken, type Logger } from '@tps/shared';
import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import type { BrowserContext } from 'playwright-core';

import {
  DEVICE_SCALE_FACTOR,
  RENDER_VIEWPORT,
  createRenderContext,
  launchBrowser,
  type DevShmStatus,
} from './browser.js';
import { capturePdf, countPdfPages, mergePdfs } from './pdf.js';
import { capturePng } from './png.js';
import { renderPage, type RenderPageResult } from './render-page.js';

/**
 * 计划导出编排（TP-1-13/14/15）。
 *
 * P1 的入口是 CLI（`render:fixture`），P4 起同一套函数由导出任务队列调用。
 * 因此这里**不碰队列、不碰数据库**，只做「给定 plan_version_id 与天数 →
 * 产出文件」这一件事。
 */

export type ExportFormat = 'html' | 'png' | 'pdf';

export interface ExportPlanRequest {
  readonly baseUrl: string;
  readonly planVersionId: string;
  readonly signingKey: string;
  /** 要导出的天号，升序。PDF 按此顺序合并 */
  readonly days: readonly number[];
  readonly formats: readonly ExportFormat[];
  readonly outputDir: string;
  readonly logger: Logger;
  /**
   * 要渲染的样式套件（R-85）。缺省取第一套。
   *
   * 本文件是本地预览与视觉基线工具，不是生产导出路径。可选是为了 P2：
   * 基线是按套件拍的，新增套件时需要能指定拍哪一套。
   */
  readonly templateId?: string;
}

export interface DayArtifact {
  readonly dayNumber: number;
  readonly round: number;
  readonly degraded: boolean;
  readonly overflowSlots: readonly string[];
  readonly pngBytes: number | null;
  readonly pngCompressionRatio: number | null;
  readonly pdfBytes: number | null;
  readonly elapsedMs: number;
}

/**
 * 产物来源记录（TP-1-16、门禁 #33）。
 *
 * 视觉基线**必须**在 Linux 容器内生成 —— 字体渲染在 Windows 与 Linux 上
 * 必然不同，开发机产出的基线会让 CI 永久失败或永久误通过（RISK-17）。
 * 光靠约定拦不住，所以把来源写进产物目录，由 `visual:update` 机械校验。
 */
export interface RenderProvenance {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly chromiumVersion: string;
  readonly devShmReason: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
}

export interface ExportPlanReport {
  readonly planVersionId: string;
  readonly provenance: RenderProvenance;
  readonly devShm: DevShmStatus;
  readonly days: readonly DayArtifact[];
  /** ALL_DAYS 合并结果；未导出 PDF 时为 null */
  readonly mergedPdf: {
    readonly file: string;
    readonly pages: number;
    readonly bytes: number;
  } | null;
  readonly degradedDays: readonly number[];
}

export async function exportPlan(request: ExportPlanRequest): Promise<ExportPlanReport> {
  const { browser, devShm } = await launchBrowser();
  request.logger.info({ devShm: devShm.reason }, 'Chromium 已启动');

  try {
    const provenance: RenderProvenance = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      chromiumVersion: browser.version(),
      devShmReason: devShm.reason,
      viewport: { width: RENDER_VIEWPORT.width, height: RENDER_VIEWPORT.height },
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    };

    const context = await createRenderContext(browser);
    try {
      return await runExport(request, context, devShm, provenance);
    } finally {
      await context.close();
    }
  } finally {
    /*
     * browser 必须在 finally 里关闭。
     *
     * 容器里 PID 1 是 tini/--init（22.3.1），能回收僵尸子进程；但 browser
     * 本身不关会一直占着 ~200MB 与若干渲染进程 —— CLI 进程退出后
     * 这些进程仍可能残留，表现是 CI 任务「完成了但不退出」。
     */
    await browser.close();
  }
}

async function runExport(
  request: ExportPlanRequest,
  context: BrowserContext,
  devShm: DevShmStatus,
  provenance: RenderProvenance,
): Promise<ExportPlanReport> {
  const wantHtml = request.formats.includes('html');
  const wantPng = request.formats.includes('png');
  const wantPdf = request.formats.includes('pdf');

  await mkdir(request.outputDir, { recursive: true });

  const artifacts: DayArtifact[] = [];
  const pdfParts: Buffer[] = [];

  /*
   * 逐天顺序渲染，不并发。
   *
   * 21.2 的「1 browser + 3 page」是队列 Worker 的吞吐配置（P4）。这里刻意
   * 串行：并发渲染会共享字体与图片缓存，第一个页面与后续页面的首帧状态
   * 因此不同 —— 而这条链路的产物要给视觉基线（TP-1-16）当输入，
   * 需要的是可复现，不是快。
   */
  for (const dayNumber of request.days) {
    const rendered = await renderDay(request, context, dayNumber);

    try {
      if (wantHtml) {
        const html = await rendered.page.content();
        await writeFile(dayFile(request.outputDir, dayNumber, 'html'), html, 'utf8');
      }

      let pngBytes: number | null = null;
      let ratio: number | null = null;
      if (wantPng) {
        const png = await capturePng(rendered.page);
        await writeFile(dayFile(request.outputDir, dayNumber, 'png'), png.buffer);
        pngBytes = png.compressedBytes;
        ratio = 1 - png.compressedBytes / png.rawBytes;
      }

      let pdfBytes: number | null = null;
      if (wantPdf) {
        const pdf = await capturePdf(rendered.page);
        pdfParts.push(pdf);
        pdfBytes = pdf.length;
      }

      artifacts.push({
        dayNumber,
        round: rendered.round,
        degraded: rendered.degraded,
        overflowSlots: rendered.overflow.violations.map((v) => v.slot),
        pngBytes,
        pngCompressionRatio: ratio,
        pdfBytes,
        elapsedMs: rendered.elapsedMs,
      });

      request.logger.info(
        {
          day: dayNumber,
          round: rendered.round,
          degraded: rendered.degraded,
          guarded: rendered.overflow.guardedCount,
          violations: rendered.overflow.violations.length,
          // 槽位名是排查降级的唯一线索：只报数量的话，「一直降级」这件事
          // 无法定位到具体元素，只能靠人去翻 HTML
          overflowSlots: rendered.overflow.violations.map(
            (v) =>
              `${v.slot} 溢出${v.overflowPx}px（scroll ${v.scrollHeight} / client ${v.clientHeight}，` +
              `font ${v.fontSize} / line ${v.lineHeight}）`,
          ),
          height: rendered.overflow.documentHeight,
          elapsedMs: rendered.elapsedMs,
        },
        `第 ${dayNumber} 天完成`,
      );
    } finally {
      await rendered.page.close();
    }
  }

  let mergedPdf: ExportPlanReport['mergedPdf'] = null;
  if (wantPdf && pdfParts.length > 0) {
    const merged = await mergePdfs(pdfParts);
    const file = path.join(request.outputDir, `${request.planVersionId}-all-days.pdf`);
    await writeFile(file, merged);
    mergedPdf = { file, pages: await countPdfPages(merged), bytes: merged.length };
  }

  if (wantHtml) await exportFullPlanHtml(request, context);

  await writeFile(
    path.join(request.outputDir, 'render-meta.json'),
    `${JSON.stringify({ planVersionId: request.planVersionId, provenance }, null, 2)}
`,
    'utf8',
  );

  return {
    planVersionId: request.planVersionId,
    provenance,
    devShm,
    days: artifacts,
    mergedPdf,
    degradedDays: artifacts.filter((a) => a.degraded).map((a) => a.dayNumber),
  };
}

async function renderDay(
  request: ExportPlanRequest,
  context: BrowserContext,
  dayNumber: number,
): Promise<RenderPageResult> {
  const pageKey = RENDER_PAGE_KEYS.day(dayNumber);

  return renderPage({
    context,
    baseUrl: request.baseUrl,
    path: `/render/plans/${encodeURIComponent(request.planVersionId)}/days/${dayNumber}`,
    templateId: request.templateId ?? TEMPLATE_ID_VALUES[0],
    // 每页一个新令牌：令牌与页面绑定，且 jti 唯一以支持重放检测（17.1）
    renderToken: issueRenderToken(
      { planVersionId: request.planVersionId, pageKey, jti: randomUUID() },
      request.signingKey,
    ),
  });
}

/**
 * 完整计划页（3.3.1）只导出 HTML。
 *
 * 它是响应式浏览页面，不是定宽导出物 —— 对它截图会得到一张宽度取决于
 * viewport 的图，与「每日信息图」的定宽长图不是同一类产物。
 * 因此不做 PNG/PDF，也不参与 17.3 的溢出检测（响应式布局本就允许重排）。
 */
async function exportFullPlanHtml(
  request: ExportPlanRequest,
  context: BrowserContext,
): Promise<void> {
  const token = issueRenderToken(
    {
      planVersionId: request.planVersionId,
      pageKey: RENDER_PAGE_KEYS.full(),
      jti: randomUUID(),
    },
    request.signingKey,
  );

  const rendered = await renderPage({
    context,
    baseUrl: request.baseUrl,
    path: `/render/plans/${encodeURIComponent(request.planVersionId)}/full`,
    templateId: request.templateId ?? TEMPLATE_ID_VALUES[0],
    renderToken: token,
  });

  try {
    const html = await rendered.page.content();
    await writeFile(
      path.join(request.outputDir, `${request.planVersionId}-full.html`),
      html,
      'utf8',
    );
  } finally {
    await rendered.page.close();
  }
}

/** 天号补零，保证文件名的字典序与天号顺序一致（`day-02` 而不是 `day-2`） */
function dayFile(outputDir: string, dayNumber: number, extension: string): string {
  return path.join(outputDir, `day-${String(dayNumber).padStart(2, '0')}.${extension}`);
}
