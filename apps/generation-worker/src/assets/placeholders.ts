import sharp from 'sharp';

import type { AspectRatio, AssetRole } from '@tps/schemas';

/**
 * 默认占位素材（十八章降级链的最后一环，19.5 之外）。
 *
 * 十八章的三条降级链都以「默认占位」收尾：
 * Hero → 渐变背景、景点 → 默认景点占位图、美食 → 默认美食占位图。
 * 这些图必须**预先存在于素材库**，否则降级链的最后一步无处可取 ——
 * 而那时的处境已经是「什么都没找到」，不可能再去生成。
 *
 * ## 为什么用程序生成而不是设计稿出图
 *
 * 占位图的要求是「不假装是照片、能填住版位、中文可读」。
 * 纯色/渐变加一行说明文字就够，且程序生成的产物在任何环境都一致
 * （视觉基线测试因此稳定）。设计出图反而会引入一个二进制夹具与
 * 「谁负责更新」的问题。
 *
 * ## 它们不是「假的库素材」
 *
 * `source_type` 一律 `DEFAULT_PLACEHOLDER`、`representation_type` 一律
 * `ILLUSTRATIVE`。这两个标记让它们**不可能**被当成实拍照片：
 * 解析结果的 `status` 是 `FALLBACK`、`strategy` 是 `STATIC_DEFAULT`，
 * 页面上按占位样式渲染。往库里灌一批渐变图然后当作
 * `PLATFORM_LIBRARY` 命中，才是不能做的事。
 */

export interface PlaceholderSpec {
  readonly role: Exclude<AssetRole, 'ROUTE_MAP'>;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: AspectRatio;
  readonly minWidth: number;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  /** 稳定的缓存键，让占位图只灌一次（19.2 的键版本随渐变改动递增） */
  readonly cacheKey: string;
}

/** 三个角色各一张。比例与 `@tps/presentation` 的槽位约束一致 */
export const PLACEHOLDER_SPECS: readonly PlaceholderSpec[] = [
  {
    role: 'HERO_BACKGROUND',
    width: 1600,
    height: 600,
    aspectRatio: '16:6',
    minWidth: 1600,
    label: '主题背景',
    from: '#2f6b52',
    to: '#8fc0a9',
    cacheKey: 'placeholder:v1:hero_background:16x6',
  },
  {
    role: 'DESTINATION_PHOTO',
    width: 1200,
    height: 675,
    aspectRatio: '16:9',
    minWidth: 800,
    label: '暂无实景图',
    from: '#3f5e78',
    to: '#a9c3d6',
    cacheKey: 'placeholder:v1:destination_photo:16x9',
  },
  {
    role: 'FOOD_IMAGE',
    width: 900,
    height: 675,
    aspectRatio: '4:3',
    minWidth: 600,
    label: '暂无美食图',
    from: '#8a5a2b',
    to: '#e0c9a6',
    cacheKey: 'placeholder:v1:food_image:4x3',
  },
];

/**
 * 生成一张占位图（PNG 字节，交给 11.2 的后处理转 WebP）。
 *
 * 文字用 SVG 叠加而不是 sharp 的文字 API：后者依赖 pango/fontconfig，
 * 在 Alpine 与部分 Linux 镜像上缺失（22.3.2 的同类问题）。
 * SVG 里只写 `font-family` 让 librsvg 用系统字体 —— 图里的文字是中文，
 * 而渲染镜像已经装了 Noto Sans SC（17.5）。
 *
 * ## 占位图为什么不会被当成库素材命中
 *
 * 不靠 `quality_score` 压低（实测渐变图仍能拿到 0.6 左右 —— 清晰度接近 0，
 * 但曝光居中、边缘能量集中在中间的文字上，两项都不低），
 * 而靠**没有实体与目的地**：
 *
 *   - 景点/美食槽位带 `entity_name`，占位图的 `entity_name` 为 null
 *     → `entity_match` = 0，权重 0.35 直接归零，final 上限约 0.5；
 *   - Hero 槽位没有实体名（按中性 0.5 计入），但 `destination_match` 仍为 0
 *     → final 上限约 0.6。
 *
 * 两者都低于 10.2 的 0.65 阈值，因此占位图**只能**由降级链显式取用
 * （`STATIC_DEFAULT`），不会在 `LOCAL_LIBRARY_MATCH` 里冒出来。
 * 这比「用分数压住」可靠：分数是连续量，阈值一调就可能翻转。
 */
export async function renderPlaceholder(spec: PlaceholderSpec): Promise<Uint8Array> {
  const fontSize = Math.round(spec.height / 10);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="${spec.from}" />`,
    `<stop offset="100%" stop-color="${spec.to}" />`,
    `</linearGradient></defs>`,
    `<rect width="${spec.width}" height="${spec.height}" fill="url(#g)" />`,
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" `,
    `font-family="Noto Sans SC, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" `,
    `fill="#ffffff" fill-opacity="0.82">${spec.label}</text>`,
    `</svg>`,
  ].join('');

  const png = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
  return new Uint8Array(png);
}
