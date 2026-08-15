import sharp from 'sharp';
import type { Page } from 'playwright-core';

import { DEVICE_SCALE_FACTOR, RENDER_VIEWPORT } from './browser.js';

/**
 * PNG 导出（TP-1-13、TP-1-21，设计稿 17.4）。
 *
 * 17.4 规定的参数：viewport 1200 宽、`deviceScaleFactor: 2`（输出 2400px）、
 * `fullPage: true`、`type: png`、`omitBackground: false`、动画禁用。
 */

/** 17.4：2 倍图后的输出宽度。用于校验，不是配置项。 */
export const EXPECTED_PNG_WIDTH = RENDER_VIEWPORT.width * DEVICE_SCALE_FACTOR;

export interface PngResult {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly rawBytes: number;
  readonly compressedBytes: number;
}

/**
 * 用 sharp 无损压缩替代 `oxipng`（TP-1-21，22.3.2）。
 *
 * ## 为什么换掉 oxipng
 *
 * oxipng 是需要按平台分发的原生二进制。Windows 开发 + Linux 运行的组合下，
 * 它意味着要么在镜像里额外装一个二进制，要么依赖能正确解析平台的 npm 包 ——
 * 而这正是 22.3.2 点名的「pnpm 只装宿主平台可选依赖」陷阱。
 * sharp 已经因为图片处理而必须存在，用它自带的 PNG 编码器等于少一个原生依赖。
 *
 * ## 参数选择
 *
 * `compressionLevel: 9` + `effort: 10` 是无损的最高档。
 * `palette: true` 对信息图特别有效 —— 大面积纯色 + 有限配色，
 * 调色板化通常能再降 30%～50%，且**在颜色数 ≤ 256 时完全无损**。
 * 颜色数超限时 sharp 会自动退回真彩色，不会悄悄降质。
 */
async function compressPng(
  raw: Buffer,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const image = sharp(raw);
  const metadata = await image.metadata();

  const buffer = await image.png({ compressionLevel: 9, effort: 10, palette: true }).toBuffer();

  return { buffer, width: metadata.width, height: metadata.height };
}

export interface CapturePngOptions {
  /**
   * 校验输出宽度是否等于 2400。
   *
   * 默认开启：宽度不对说明 viewport 或 deviceScaleFactor 被改过，
   * 而这类产物看起来完全正常，只是打印时糊 —— 交付后才发现的成本高得多。
   */
  readonly assertWidth?: boolean;
}

export async function capturePng(page: Page, options: CapturePngOptions = {}): Promise<PngResult> {
  const raw = await page.screenshot({
    fullPage: true,
    type: 'png',
    // 保留白底：透明区域在 PDF 里会变黑（17.4）
    omitBackground: false,
    // 避免截到动画中间帧
    animations: 'disabled',
    // 光标闪烁会让同一页面的两次截图像素不同，破坏视觉基线
    caret: 'hide',
  });

  const { buffer, width, height } = await compressPng(raw);

  if ((options.assertWidth ?? true) && width !== EXPECTED_PNG_WIDTH) {
    throw new Error(
      `PNG 宽度 ${width} 不等于预期 ${EXPECTED_PNG_WIDTH}（viewport ${RENDER_VIEWPORT.width} × ${DEVICE_SCALE_FACTOR}）。` +
        '检查 createRenderContext 的 viewport 与 deviceScaleFactor 是否被覆盖',
    );
  }

  return {
    buffer,
    width,
    height,
    rawBytes: raw.length,
    compressedBytes: buffer.length,
  };
}
