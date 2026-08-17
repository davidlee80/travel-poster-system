/**
 * 素材质量评分（10.1 的 `quality_score` 列，入库时离线计算）。
 *
 * 10.1 给了构成：清晰度（拉普拉斯方差归一）0.4 + 曝光合理性 0.3 +
 * 主体占比 0.3，但只有第一项给了算法。以下是三项的实现与各自的取舍。
 *
 * ## 清晰度：拉普拉斯方差（照设计稿实现）
 *
 * 灰度图上做离散拉普拉斯卷积，取方差。模糊图的高频能量低，方差小。
 * 归一化阈值取 500 —— 这是 OpenCV 社区做「模糊检测」时常用的量级
 * （100 以下通常肉眼可见模糊）。
 *
 * ## 曝光合理性：截断比例 + 亮度居中度（设计稿未给算法）
 *
 * 两个可测量的坏情况：过曝/欠曝导致的**像素截断**（细节永久丢失），
 * 以及整体亮度偏离中间调。两者线性惩罚。
 *
 * ## 主体占比：中心区域边缘能量占比（近似，设计稿未给算法）
 *
 * 真正的「主体占比」需要显著性分割模型。V1 不引入模型，改用一个可解释的
 * 近似：**中心 50% 面积内的边缘能量占全图的比例**。
 * 依据是构图习惯 —— 主体通常居中且边缘丰富，而大片天空/墙面的边缘能量低。
 *
 * 这是**近似而不是等价**，因此：
 *   - 它只占 `final_score` 的 0.05 × 0.3 = 1.5% 权重，误差影响有界；
 *   - 缺失时按 10.1 取 0.5 中性值，不会因为算不出来而把素材判死。
 * 引入分割模型后重算这一列即可，不影响其他列（`quality_score` 是独立的）。
 */

/** 拉普拉斯方差的归一化上界（超过即视为足够清晰） */
export const SHARPNESS_VARIANCE_CEILING = 500;
/** 像素值低于/高于此值视为截断 */
const CLIP_LOW = 5;
const CLIP_HIGH = 250;

export interface GrayscaleImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface QualityBreakdown {
  readonly sharpness: number;
  readonly exposure: number;
  readonly subject: number;
  readonly score: number;
}

/** 离散拉普拉斯算子（4 邻域）。返回每个内部像素的响应 */
function laplacian(image: GrayscaleImage): Float64Array {
  const { data, width, height } = image;
  const out = new Float64Array(Math.max(0, (width - 2) * (height - 2)));

  let index = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = data[y * width + x]!;
      const up = data[(y - 1) * width + x]!;
      const down = data[(y + 1) * width + x]!;
      const left = data[y * width + x - 1]!;
      const right = data[y * width + x + 1]!;
      out[index] = up + down + left + right - 4 * center;
      index += 1;
    }
  }

  return out;
}

function variance(values: Float64Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;

  let acc = 0;
  for (const value of values) acc += (value - mean) ** 2;
  return acc / values.length;
}

export function sharpnessScore(image: GrayscaleImage): number {
  if (image.width < 3 || image.height < 3) return 0;
  const v = variance(laplacian(image));
  return clamp01(v / SHARPNESS_VARIANCE_CEILING);
}

export function exposureScore(image: GrayscaleImage): number {
  const { data } = image;
  if (data.length === 0) return 0;

  let clipped = 0;
  let sum = 0;
  for (const value of data) {
    if (value <= CLIP_LOW || value >= CLIP_HIGH) clipped += 1;
    sum += value;
  }

  const clipRatio = clipped / data.length;
  const mean = sum / data.length;
  // 亮度居中度：128 为最佳，偏离 128 越远越低
  const centered = 1 - Math.abs(mean - 128) / 128;

  /*
   * 截断比例的惩罚系数是 2：10% 的像素被截断就扣掉 20% 分。
   * 比 1 更陡是有意的 —— 截断是**不可恢复**的细节丢失，
   * 而亮度偏移在展示时还能被版式与遮罩补偿。
   */
  return clamp01(centered * (1 - Math.min(1, clipRatio * 2)));
}

export function subjectScore(image: GrayscaleImage): number {
  const { width, height } = image;
  if (width < 3 || height < 3) return 0;

  const response = laplacian(image);
  const innerWidth = width - 2;

  // 中心 50% 面积：各边缩进 (1 - sqrt(0.5)) / 2 ≈ 14.6%
  const inset = (1 - Math.SQRT1_2) / 2;
  const x0 = Math.floor(innerWidth * inset);
  const x1 = Math.ceil(innerWidth * (1 - inset));
  const innerHeight = height - 2;
  const y0 = Math.floor(innerHeight * inset);
  const y1 = Math.ceil(innerHeight * (1 - inset));

  let total = 0;
  let center = 0;
  for (let y = 0; y < innerHeight; y += 1) {
    for (let x = 0; x < innerWidth; x += 1) {
      const energy = Math.abs(response[y * innerWidth + x]!);
      total += energy;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) center += energy;
    }
  }

  if (total === 0) return 0;

  /*
   * 直接取占比，不做归一。中心区是全图 50% 面积，因此：
   *   能量全在中心   → 1.0（主体明确）
   *   能量均匀分布   → 0.5（没有主体，比如一整片纹理墙）
   *   能量全在边缘   → 0.0（主体被切在画面外）
   *
   * 早先写成 `占比 / 0.5` 是错的：那会把「均匀分布」映射成满分，
   * 与这一项要表达的意思正好相反。
   */
  return clamp01(center / total);
}

export function qualityScoreOf(image: GrayscaleImage): QualityBreakdown {
  const sharpness = sharpnessScore(image);
  const exposure = exposureScore(image);
  const subject = subjectScore(image);

  return {
    sharpness,
    exposure,
    subject,
    // 10.1 的权重：0.4 / 0.3 / 0.3
    score: round4(sharpness * 0.4 + exposure * 0.3 + subject * 0.3),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** `assets.quality_score` 是 NUMERIC(5,4)，超过 4 位小数会被数据库截断 */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
