import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ASPECT_TOLERANCE_LOG2, MAX_STORED_WIDTH, THUMBNAIL_WIDTH, processImage } from './image.js';
import { exposureScore, qualityScoreOf, sharpnessScore, subjectScore } from './quality.js';

/**
 * 11.2 后处理与 10.1 的 `quality_score`（TP-3-11）。
 *
 * 用 sharp **真的生成**测试图片而不是准备二进制夹具：夹具文件让「为什么
 * 这张图会被拒」变得不可读，而这里每张图的构成都在代码里写着。
 */

/** 纯色图（无高频细节 → 清晰度接近 0） */
async function flat(width: number, height: number, gray = 128): Promise<Uint8Array> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: gray, g: gray, b: gray } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

/** 随机噪声图（高频丰富 → 清晰度高） */
async function noisy(width: number, height: number, seed = 1): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let i = 0; i < pixels.length; i += 1) {
    // 线性同余，避免用 Math.random 让测试不可复现
    state = (state * 1103515245 + 12345) % 2147483648;
    pixels[i] = state % 256;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

function grayscale(width: number, height: number, fill: (x: number, y: number) => number) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = fill(x, y);
  }
  return { data, width, height };
}

const PHOTO_CONSTRAINTS = { aspectRatio: '16:9' as const, minWidth: 800 };

describe('11.2 第 1～3 步：校验', () => {
  it('不是图片 → INVALID_IMAGE', async () => {
    const result = await processImage(new Uint8Array([1, 2, 3, 4]), PHOTO_CONSTRAINTS);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.reason).toBe('INVALID_IMAGE');
  });

  it('分辨率不足 → RESOLUTION_TOO_LOW', async () => {
    const result = await processImage(await noisy(640, 360), PHOTO_CONSTRAINTS);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection).toMatchObject({ reason: 'RESOLUTION_TOO_LOW', width: 640 });
  });

  it('比例偏差超过 log2 0.5 → ASPECT_RATIO_MISMATCH（TP-3-11 的验证点）', async () => {
    // 需求 16:9 ≈ 1.78，给一张 1:1 → |log2(1/1.78)| ≈ 0.83 > 0.5
    const result = await processImage(await noisy(1000, 1000), PHOTO_CONSTRAINTS);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.reason).toBe('ASPECT_RATIO_MISMATCH');
    if (result.rejection.reason !== 'ASPECT_RATIO_MISMATCH') return;
    expect(result.rejection.deviationLog2).toBeGreaterThan(ASPECT_TOLERANCE_LOG2);
  });

  it('比例在容差内 → 通过', async () => {
    // 3:2 = 1.5 与 16:9 = 1.78：|log2(1.5/1.78)| ≈ 0.25 < 0.5
    const result = await processImage(await noisy(1200, 800), PHOTO_CONSTRAINTS);
    expect(result.kind).toBe('ok');
  });

  it('比例修正**不发生** —— 不符就拒，不裁剪', async () => {
    /*
     * 裁剪能让 aspect_ratio_score 满分，但可能切掉一半主体。
     * 10.1 的评分按素材原始属性算，入库时偷偷修正会让评分失去意义。
     */
    const result = await processImage(await noisy(1000, 1000), PHOTO_CONSTRAINTS);
    expect(result.kind).toBe('rejected');
  });
});

describe('11.2 第 4～5 步：WebP 与缩略图', () => {
  it('产出 WebP 与更小的缩略图', async () => {
    const result = await processImage(await noisy(1600, 900), PHOTO_CONSTRAINTS);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const webpMeta = await sharp(result.image.webp).metadata();
    expect(webpMeta.format).toBe('webp');
    expect(webpMeta.width).toBe(1600);

    const thumbMeta = await sharp(result.image.thumbnail).metadata();
    expect(thumbMeta.format).toBe('webp');
    expect(thumbMeta.width).toBe(THUMBNAIL_WIDTH);
    expect(result.image.thumbnail.byteLength).toBeLessThan(result.image.webp.byteLength);
  });

  it('超大图缩到上限，且不放大小图', async () => {
    const large = await processImage(await noisy(3200, 1800), PHOTO_CONSTRAINTS);
    if (large.kind !== 'ok') throw new Error('应当通过');
    expect(large.image.width).toBe(MAX_STORED_WIDTH);

    const exact = await processImage(await noisy(900, 506), PHOTO_CONSTRAINTS);
    if (exact.kind !== 'ok') throw new Error('应当通过');
    // 900 < 2400，不放大
    expect(exact.image.width).toBe(900);
  });

  it('落库的比例是处理后的实际比例（NUMERIC(10,5) 精度）', async () => {
    const result = await processImage(await noisy(1600, 900), PHOTO_CONSTRAINTS);
    if (result.kind !== 'ok') throw new Error('应当通过');

    expect(result.image.aspectRatio).toBeCloseTo(16 / 9, 4);
    expect(String(result.image.aspectRatio).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it('记录原图属性供排查', async () => {
    const result = await processImage(await noisy(3200, 1800), PHOTO_CONSTRAINTS);
    if (result.kind !== 'ok') throw new Error('应当通过');
    expect(result.image.source).toMatchObject({ width: 3200, height: 1800, format: 'png' });
  });
});

describe('quality_score（10.1）', () => {
  it('噪声图的清晰度远高于纯色图', async () => {
    const sharpImage = await processImage(await noisy(1600, 900), PHOTO_CONSTRAINTS);
    const flatImage = await processImage(await flat(1600, 900), PHOTO_CONSTRAINTS);
    if (sharpImage.kind !== 'ok' || flatImage.kind !== 'ok') throw new Error('应当通过');

    expect(sharpImage.image.quality.sharpness).toBeGreaterThan(
      flatImage.image.quality.sharpness + 0.5,
    );
    expect(flatImage.image.quality.sharpness).toBeCloseTo(0, 3);
  });

  it('三项加权与总分一致（0.4 / 0.3 / 0.3）', () => {
    const image = grayscale(64, 64, (x, y) => (x + y) % 256);
    const q = qualityScoreOf(image);
    expect(q.score).toBeCloseTo(q.sharpness * 0.4 + q.exposure * 0.3 + q.subject * 0.3, 3);
  });

  it('总分不超过 4 位小数（NUMERIC(5,4)）', () => {
    const q = qualityScoreOf(grayscale(32, 32, (x) => x * 8));
    expect(String(q.score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it('曝光：中间调无截断得高分，全黑/全白得低分', () => {
    expect(exposureScore(grayscale(32, 32, () => 128))).toBeCloseTo(1, 2);
    expect(exposureScore(grayscale(32, 32, () => 0))).toBeCloseTo(0, 2);
    expect(exposureScore(grayscale(32, 32, () => 255))).toBeCloseTo(0, 2);
  });

  it('曝光：截断像素比例线性扣分', () => {
    // 一半像素全白（截断）
    const half = exposureScore(grayscale(32, 32, (_x, y) => (y < 16 ? 255 : 128)));
    const none = exposureScore(grayscale(32, 32, () => 128));
    expect(half).toBeLessThan(none);
  });

  it('主体占比：中心有细节的图高于均匀纹理的图', () => {
    const centered = grayscale(64, 64, (x, y) => {
      const inCenter = x > 20 && x < 44 && y > 20 && y < 44;
      return inCenter ? ((x + y) % 2) * 255 : 128;
    });
    const uniform = grayscale(64, 64, (x, y) => ((x + y) % 2) * 255);

    expect(subjectScore(centered)).toBeGreaterThan(subjectScore(uniform));
  });

  it('尺寸过小的图各项为 0，而不是 NaN', () => {
    const tiny = grayscale(2, 2, () => 128);
    expect(sharpnessScore(tiny)).toBe(0);
    expect(subjectScore(tiny)).toBe(0);
    expect(qualityScoreOf(tiny).score).not.toBeNaN();
  });
});
