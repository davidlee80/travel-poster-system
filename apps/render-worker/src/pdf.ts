import { PDFDocument } from 'pdf-lib';
import type { Page } from 'playwright-core';

import { RENDER_VIEWPORT } from './browser.js';

/**
 * PDF 导出与多页合并（TP-1-14、TP-1-15，设计稿 17.4）。
 */

/** 信息图定宽（17.4 viewport.width） */
const DEFAULT_CONTENT_WIDTH_PX = RENDER_VIEWPORT.width;

/** 17.4：A4 纵向，上下 12mm、左右 10mm */
const PDF_MARGIN_MM = { top: 12, bottom: 12, left: 10, right: 10 } as const;
const PDF_MARGIN = {
  top: `${PDF_MARGIN_MM.top}mm`,
  bottom: `${PDF_MARGIN_MM.bottom}mm`,
  left: `${PDF_MARGIN_MM.left}mm`,
  right: `${PDF_MARGIN_MM.right}mm`,
} as const;

/** A4 纵向宽度 */
const A4_WIDTH_MM = 210;
/** CSS 的绝对长度换算：1in = 96px = 25.4mm */
const PX_PER_MM = 96 / 25.4;

/**
 * PDF 缩放（R-16 修正 17.4 的 `scale: 1.0`）。
 *
 * ## 为什么必须缩放
 *
 * 17.4 同时要求「A4 纵向 + 左右各 10mm 页边距」与「`scale: 1.0`」。这两条
 * 在几何上不能共存：信息图定宽 1200px = 317mm（1px = 1/96in），而 A4 的
 * 可打印宽度只有 190mm。scale 为 1 时 Chromium **静默横向裁切**，
 * 每张海报右侧约 40% 直接丢失 —— 而 PDF 正常生成、页数正常、没有任何报错。
 * 实测 14 天导出得到 28 页、每页只有左侧一部分内容。
 *
 * 因此按可打印宽度反算缩放比。写成推导而不是常量：页边距改了缩放要跟着改，
 * 而漏改的表现又是静默裁切。
 */
export function fitWidthScale(contentWidthPx: number): number {
  const printableMm = A4_WIDTH_MM - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right;
  const scale = (printableMm * PX_PER_MM) / contentWidthPx;

  /*
   * Chromium 的 printToPDF 只接受 0.1～2.0。超出范围时它会报错，
   * 但那时错误信息是 "scale is out of range"，看不出是页边距配错了。
   */
  if (scale < 0.1 || scale > 2) {
    throw new Error(
      `PDF 缩放比 ${scale.toFixed(3)} 超出 Chromium 允许的 0.1～2.0。` +
        `内容宽度 ${contentWidthPx}px，A4 可打印宽度 ${printableMm}mm —— 检查页边距配置`,
    );
  }

  return scale;
}

export interface CapturePdfOptions {
  /**
   * 内容宽度（CSS px）。默认取信息图定宽 1200（17.4 viewport.width）。
   * 完整计划页是响应式的，不走 PDF 导出，所以这里没有第二种取值。
   */
  readonly contentWidthPx?: number;
}

export async function capturePdf(page: Page, options: CapturePdfOptions = {}): Promise<Buffer> {
  /*
   * 显式切到 screen 媒体（17.4）。
   *
   * Playwright 生成 PDF 时默认使用 `print` 媒体，于是 `@media print` 规则生效、
   * `@media screen` 失效 —— PDF 与用户在页面上看到的**不是同一个设计**。
   * 分页由 `@page` 与 `break-*` 控制，不依赖 print 媒体查询。
   */
  await page.emulateMedia({ media: 'screen' });

  const buffer = await page.pdf({
    format: 'A4',
    // 不设 true 会丢掉全部背景色与渐变 —— 信息图有大面积色块，等于换了个设计
    printBackground: true,
    margin: PDF_MARGIN,
    /*
     * 模板用 `@page` 声明页面尺寸，这里让它生效。
     * 与 `format: 'A4'` 并存是有意的：模板没声明 `@page` 时 A4 作为默认值。
     */
    preferCSSPageSize: true,
    // R-16：按可打印宽度反算，而不是 17.4 原文的 1.0（原因见 fitWidthScale）
    scale: fitWidthScale(options.contentWidthPx ?? DEFAULT_CONTENT_WIDTH_PX),
  });

  return buffer;
}

/**
 * 把多份单页 PDF 合并为一份（TP-1-15）。
 *
 * ## 为什么不在浏览器里一次生成 N 页
 *
 * 每一天是一张独立的定宽长图，页高各不相同。让浏览器在一个文档里排 14 天
 * 需要模板同时满足「单日导出」与「多日连排」两套分页规则 —— 而 17.3 的
 * 溢出检测是按单页做的，连排后每一天的可用高度都变了，检测结果不再有效。
 *
 * 因此：单页各自渲染并检测，最后在 PDF 层面合并。
 *
 * ## 为什么强调「单浏览器会话」
 *
 * 17.4 明确要求不启动 N 个浏览器。14 天 × 一个 Chromium 实例约 200MB，
 * 并发启动会直接打满 21.2 规定的 2Gi 内存上限，表现是 OOMKilled ——
 * 而 OOM 的日志里通常看不到是哪一步导致的。
 */
export async function mergePdfs(parts: readonly Buffer[]): Promise<Buffer> {
  if (parts.length === 0) {
    throw new Error('mergePdfs 收到空数组：没有任何页面可合并');
  }
  // 单份直接返回，避免为一页 PDF 走一遍解析与重写（也避免元数据被改写）
  if (parts.length === 1) return parts[0]!;

  /*
   * `updateMetadata: false` 在 create 与 load 两处都必须显式传。
   *
   * pdf-lib 默认会在**加载时**就重写 Producer 与 ModificationDate ——
   * 连只读地打开一份 PDF 都会改动它的元数据。默认行为下
   * setProducer('') 会被随后的 load 覆盖，而这一点只在断言字节稳定时才暴露。
   */
  const merged = await PDFDocument.create({ updateMetadata: false });

  for (const part of parts) {
    const source = await PDFDocument.load(part, { updateMetadata: false });
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }

  /*
   * 显式写入确定性元数据。
   *
   * 不写的话每次导出的 PDF 字节都不同（Producer 带 pdf-lib 版本号、
   * 时间戳是当前时刻），于是无法判断「内容是否真的变了」。
   * 时间用 epoch 0 而不是当前时刻：真实导出时间属于业务元数据，
   * 应由 `exports` 表承载，不该混进产物字节里。
   */
  merged.setProducer('');
  merged.setCreator('');
  merged.setCreationDate(new Date(0));
  merged.setModificationDate(new Date(0));

  return Buffer.from(await merged.save());
}

/**
 * 读出页数。用于验收断言：14 天必须产出 14 页。
 *
 * `updateMetadata: false` 不是可选的：默认值会让这个「只读」函数改写
 * 被检查文档的元数据。这里虽不回写文件，但同样的疏漏在别处会造成
 * 「检查一下就把产物改了」。
 */
export async function countPdfPages(pdf: Buffer): Promise<number> {
  const document = await PDFDocument.load(pdf, { updateMetadata: false });
  return document.getPageCount();
}
