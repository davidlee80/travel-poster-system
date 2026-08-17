import { z } from 'zod';
import {
  AssetSourceTypeSchema,
  AssetStatusSchema,
  AssetTypeSchema,
  LicenseTypeSchema,
  RepresentationTypeSchema,
  ResolutionStrategySchema,
  TextFallbackKindSchema,
} from './enums.js';
import { NonEmptyStringSchema } from './primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * ResolvedAsset —— 所有来源统一后的解析结果（设计稿八章、8.1、8.2）。
 *
 * ## 三条不变式由 schema 保证
 *
 * 1. `status = FALLBACK` 且 `asset = null` ⇒ `text_fallback` 必填（8.2）。
 *    这是唯一允许「没有素材却算已解析」的情形，模板据此渲染文字列表。
 * 2. `source_type = AI_GENERATED` ⇒ `representation_type = ILLUSTRATIVE`
 *    （9.4、二十章）。数据库的 `assets_ai_must_be_illustrative` 是同一条，
 *    两处都写是因为解析结果**先**在内存里流转（要进 ViewModel），
 *    落库只是其中一条路径。
 * 3. `SKIPPED` / `FAILED` ⇒ 没有 `asset`（8.1 的语义表）。
 *
 * ## 为什么 SVG 与图片共用一套结构
 *
 * 8.2 明确 SVG 的 `width`/`height` 取 `viewBox` 尺寸、`thumbnail` 恒为 null。
 * 也就是说 SVG 是「有尺寸、无缩略图的素材」，而不是另一种东西 ——
 * 模板对它们的处理只差一个 `<img>` 的 src 后缀。分成两套结构会让
 * ViewModel 里每个图片位都要判断类型。
 */

export const AssetLicenseSchema = z.object({
  type: LicenseTypeSchema,
  attribution_required: z.boolean(),
  /** 署名文案。`attribution_required` 为真时必填（由下面的 refine 保证） */
  attribution_text: z.string().nullish(),
});
export type AssetLicense = z.infer<typeof AssetLicenseSchema>;

export const AssetUrlsSchema = z.object({
  original: NonEmptyStringSchema,
  /** SVG 恒为 null（8.2） */
  thumbnail: z.string().nullable(),
});
export type AssetUrls = z.infer<typeof AssetUrlsSchema>;

export const AssetMetadataSchema = z.object({
  entity_name: z.string().nullish(),
  destination: z.string().nullish(),
  style_tags: z.array(z.string()).nullish(),
  /** 地图专用（8.2）：内容寻址的哈希，节点变化即自然失效（19.3） */
  route_node_hash: z.string().nullish(),
  map_style: z.string().nullish(),
  node_count: z.number().int().nonnegative().nullish(),
});
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;

export const ResolvedAssetBodySchema = z
  .object({
    asset_id: NonEmptyStringSchema,
    asset_type: AssetTypeSchema,
    source_type: AssetSourceTypeSchema,
    representation_type: RepresentationTypeSchema,
    mime_type: NonEmptyStringSchema,
    urls: AssetUrlsSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    aspect_ratio: z.number().positive(),
    metadata: AssetMetadataSchema,
    license: AssetLicenseSchema,
  })
  .refine(
    (asset) => asset.source_type !== 'AI_GENERATED' || asset.representation_type === 'ILLUSTRATIVE',
    {
      message: 'AI 生成物必须标记为 ILLUSTRATIVE（9.4、二十章）',
      path: ['representation_type'],
    },
  )
  .refine(
    (asset) =>
      !asset.license.attribution_required ||
      (asset.license.attribution_text ?? '').trim().length > 0,
    {
      // 需要署名却没有署名文案，页面就无法合规展示 —— 而这不是运行期数据
      // 问题，是入库时漏填，必须在解析阶段就暴露
      message: '需要署名的素材必须带 attribution_text（二十章）',
      path: ['license', 'attribution_text'],
    },
  );
export type ResolvedAssetBody = z.infer<typeof ResolvedAssetBodySchema>;

/** 8.2 的文字降级形态 */
export const TextFallbackSchema = z.object({
  kind: TextFallbackKindSchema,
  nodes: z.array(NonEmptyStringSchema).min(1),
});
export type TextFallback = z.infer<typeof TextFallbackSchema>;

export const AssetResolutionSchema = z.object({
  strategy: ResolutionStrategySchema,
  /** 10.1 的 final_score，或 19.4 的 1.0（精确键命中，不同量纲） */
  score: z.number().min(0).max(1),
  /** 0 为首选来源，数字越大越靠后（与十八章降级表对应） */
  fallback_level: z.number().int().min(0).max(3),
});
export type AssetResolution = z.infer<typeof AssetResolutionSchema>;

export const ResolvedAssetSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSIONS.resolvedAsset),
    slot_id: NonEmptyStringSchema,
    status: AssetStatusSchema,
    asset: ResolvedAssetBodySchema.nullable(),
    text_fallback: TextFallbackSchema.nullish(),
    resolution: AssetResolutionSchema,
  })
  // 8.1 的语义表：RESOLVED 一定有素材
  .refine((result) => result.status !== 'RESOLVED' || result.asset !== null, {
    message: 'RESOLVED 必须带 asset（8.1）',
    path: ['asset'],
  })
  /*
   * 8.2：FALLBACK 且没有素材时，text_fallback 必填。
   *
   * 缺了它模板会拿到一个「已解析但什么都没有」的槽位 ——
   * 十八章的「纯文字路线」降级因此在页面上表现为一块空白，
   * 而任务状态是成功的。
   */
  .refine(
    (result) =>
      result.status !== 'FALLBACK' ||
      result.asset !== null ||
      (result.text_fallback !== null && result.text_fallback !== undefined),
    {
      message: 'FALLBACK 且 asset 为 null 时必须提供 text_fallback（8.2）',
      path: ['text_fallback'],
    },
  )
  // 8.1：SKIPPED / FAILED 没有素材
  .refine((result) => !['SKIPPED', 'FAILED'].includes(result.status) || result.asset === null, {
    message: 'SKIPPED / FAILED 不得带 asset（8.1）',
    path: ['asset'],
  })
  // 19.4：CACHE_HIT 的 score 恒为 1.0（精确键命中）
  .refine((result) => result.resolution.strategy !== 'CACHE_HIT' || result.resolution.score === 1, {
    message: 'CACHE_HIT 的 score 恒为 1.0（19.4）',
    path: ['resolution', 'score'],
  })
  // 8.2：TEXT_FALLBACK 策略必然没有素材
  .refine((result) => result.resolution.strategy !== 'TEXT_FALLBACK' || result.asset === null, {
    message: 'TEXT_FALLBACK 不得带 asset（8.2）',
    path: ['asset'],
  });
export type ResolvedAsset = z.infer<typeof ResolvedAssetSchema>;

// ── 14.1 的响应体 ───────────────────────────────────────────

/**
 * 批量解析响应（14.1）。
 *
 * 三个数组按 `status` 分流，而不是给一个混在一起的 `results[]`：
 * 调用方对三者的处理完全不同 —— `resolved` 直接回填 ViewModel、
 * `fallbacks` 要计入 `plan_presentations.validation_status = 'DEGRADED'`、
 * `failed_optional` 只是模板隐藏该槽位。混在一起的话每个调用方都要重新
 * 按 status 分组，而分错一次的表现是「降级素材被当成正常素材」。
 *
 * `status: PARTIAL` —— 必需槽位（16.3 的两个角色）出现 `FAILED` 时的取值。
 * V1 里它只可能来自代码缺陷（两个必需角色都有到底的降级链），
 * 但契约上必须能表达，否则调用方无从判断「能不能渲染」。
 */
export const ASSET_RESOLVE_STATUS_VALUES = ['COMPLETED', 'PARTIAL'] as const;
export const AssetResolveStatusSchema = z.enum(ASSET_RESOLVE_STATUS_VALUES);
export type AssetResolveStatus = (typeof ASSET_RESOLVE_STATUS_VALUES)[number];

export const AssetResolveResponseSchema = z.object({
  status: AssetResolveStatusSchema,
  resolved: z.array(ResolvedAssetSchema),
  fallbacks: z.array(ResolvedAssetSchema),
  failed_optional: z.array(ResolvedAssetSchema),
});
export type AssetResolveResponse = z.infer<typeof AssetResolveResponseSchema>;
