import { aspectRatioValue, type AspectRatio } from '@tps/schemas';
import sharp from 'sharp';

import { qualityScoreOf, type QualityBreakdown } from './quality.js';

/**
 * 图片后处理（TP-3-11，设计稿 11.2）。
 *
 * 11.2 的九步里，1～5 在这里（纯图像处理），6～7 在 `ingest.ts`（上传与落库），
 * 8 由 AI 生成路径提供（P4 的 `generation_metadata`），9 是缓存键（19.4）。
 *
 * ```text
 * 1. 检查文件是否有效     → sharp 解析元数据，失败即拒
 * 2. 检查分辨率           → 宽度低于 min_width 即拒
 * 3. 检查长宽比           → |log2(实际/需求)| > 0.5 即拒
 * 4. 转为 WebP
 * 5. 生成缩略图
 * ```
 *
 * ## 为什么「拒」而不是「修」
 *
 * 比例不符可以裁剪，分辨率不足可以放大 —— 但两者都会**降低质量却让分数
 * 变高**：裁剪后的比例完美匹配（`aspect_ratio_score` 满分），
 * 而画面主体可能被切掉一半。10.1 的评分是按素材**原始**属性算的，
 * 入库时偷偷修正等于让评分失去意义。
 *
 * 唯一例外是**缩小**：原图远大于需求时缩到合理尺寸，那不改变构图。
 */

/** 5 的缩略图宽度。卡片位约 320 逻辑像素，2 倍图取 640 */
export const THUMBNAIL_WIDTH = 640;
/** 3 的比例容差，与 10.1 的 `aspect_ratio_score` 同一口径（半个八度） */
export const ASPECT_TOLERANCE_LOG2 = 0.5;
/** 上传前的最大边长。超过只是浪费带宽，导出用不到 4K 素材 */
export const MAX_STORED_WIDTH = 2400;
/** WebP 质量。82 是肉眼无损与体积的常用折中 */
const WEBP_QUALITY = 82;

export interface ProcessImageConstraints {
  readonly aspectRatio: AspectRatio;
  readonly minWidth: number;
}

export interface ProcessedImage {
  readonly webp: Uint8Array;
  readonly thumbnail: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly thumbnailWidth: number;
  readonly thumbnailHeight: number;
  readonly quality: QualityBreakdown;
  /** 原图属性，用于排查（落库的是处理后的尺寸） */
  readonly source: { readonly width: number; readonly height: number; readonly format: string };
}

export type ProcessImageRejection =
  /** 1：不是可解析的图片 */
  | { readonly reason: 'INVALID_IMAGE'; readonly detail: string }
  /** 2：分辨率不达标 */
  | { readonly reason: 'RESOLUTION_TOO_LOW'; readonly width: number; readonly minWidth: number }
  /** 3：比例偏差超过半个八度 */
  | {
      readonly reason: 'ASPECT_RATIO_MISMATCH';
      readonly actual: number;
      readonly required: number;
      readonly deviationLog2: number;
    };

export type ProcessImageResult =
  | { readonly kind: 'ok'; readonly image: ProcessedImage }
  | { readonly kind: 'rejected'; readonly rejection: ProcessImageRejection };

export async function processImage(
  input: Uint8Array,
  constraints: ProcessImageConstraints,
): Promise<ProcessImageResult> {
  // ── 1. 有效性 ──
  let metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch (error) {
    return {
      kind: 'rejected',
      rejection: { reason: 'INVALID_IMAGE', detail: String(error) },
    };
  }

  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return {
      kind: 'rejected',
      rejection: { reason: 'INVALID_IMAGE', detail: '缺少宽高元数据' },
    };
  }

  // ── 2. 分辨率 ──
  if (width < constraints.minWidth) {
    return {
      kind: 'rejected',
      rejection: { reason: 'RESOLUTION_TOO_LOW', width, minWidth: constraints.minWidth },
    };
  }

  // ── 3. 长宽比 ──
  const actual = width / height;
  const required = aspectRatioValue(constraints.aspectRatio);
  const deviation = Math.abs(Math.log2(actual / required));
  if (deviation > ASPECT_TOLERANCE_LOG2) {
    return {
      kind: 'rejected',
      rejection: {
        reason: 'ASPECT_RATIO_MISMATCH',
        actual,
        required,
        deviationLog2: deviation,
      },
    };
  }

  /*
   * 质量评分在**原图**上算，而不是在压缩后的 WebP 上。
   * WebP 的有损压缩会平滑高频细节，拉普拉斯方差随质量参数变化 ——
   * 那样测出来的是「压缩器的行为」而不是「素材的清晰度」。
   */
  const gray = await sharp(input)
    .greyscale()
    // 统一到固定宽度：拉普拉斯方差与分辨率相关，不归一会让大图天然得高分
    .resize({ width: 512, fit: 'inside', withoutEnlargement: false })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const quality = qualityScoreOf({
    data: new Uint8Array(gray.data),
    width: gray.info.width,
    height: gray.info.height,
  });

  // ── 4. WebP（必要时缩小，不放大）──
  const stored = sharp(input).resize({
    width: Math.min(width, MAX_STORED_WIDTH),
    withoutEnlargement: true,
  });
  const webpBuffer = await stored.webp({ quality: WEBP_QUALITY }).toBuffer({
    resolveWithObject: true,
  });

  // ── 5. 缩略图 ──
  const thumbBuffer = await sharp(input)
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return {
    kind: 'ok',
    image: {
      webp: new Uint8Array(webpBuffer.data),
      thumbnail: new Uint8Array(thumbBuffer.data),
      width: webpBuffer.info.width,
      height: webpBuffer.info.height,
      aspectRatio: round5(webpBuffer.info.width / webpBuffer.info.height),
      thumbnailWidth: thumbBuffer.info.width,
      thumbnailHeight: thumbBuffer.info.height,
      quality,
      source: { width, height, format: metadata.format ?? 'unknown' },
    },
  };
}

/** `assets.aspect_ratio` 是 NUMERIC(10,5) */
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}
