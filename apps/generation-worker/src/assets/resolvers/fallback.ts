import type { AssetsRepository } from '@tps/db';
import {
  SCHEMA_VERSIONS,
  type AssetRequirementItem,
  type LicenseType,
  type RepresentationType,
  type ResolvedAsset,
} from '@tps/schemas';

import { PLACEHOLDER_SPECS } from '../placeholders.js';

/**
 * 默认占位与跳过（TP-3-09 的最后一层，设计稿十八章、8.1）。
 *
 * 十八章三条降级链的收尾：
 * ```text
 * Hero   → 缓存图 → AI（P4）→ 默认占位（渐变）
 * 景点   → 授权源 → AI（P4）→ 默认占位
 * 美食   → 授权源 → AI（P4）→ 默认占位
 * ```
 *
 * ## P3 的降级链缺中间一环
 *
 * `AI_GENERATION` 与 `LICENSED_SOURCE_MATCH` 都在 P4（TP-4-01/02）。
 * 因此 P3 的实际链路是「素材库 → 默认占位」，`fallback_level` 从 0 直接
 * 跳到 2 —— 1 这一级留给 P4。这是有意留空而不是编号错误：
 * 让 P4 接入 AI 时只增加一层，不需要重编所有等级
 * （等级会出现在 `plan_asset_bindings.resolution_strategy` 的历史数据里）。
 *
 * ## 占位图不在库里时用 SKIPPED，不用 FAILED
 *
 * `FAILED` 会让 16.3 按「必需素材缺失」判定并阻断任务。
 * 而占位图缺失是**部署问题**（忘了跑 `assets:ingest --placeholders`），
 * 用户的计划本身完全可用：模板对 `hero_asset: null` 有渐变背景分支，
 * 对 `image: null` 有占位样式分支（12.1）。阻断只会把一次运维遗漏
 * 变成用户拿不到计划。
 */

export interface FallbackDeps {
  readonly assets: AssetsRepository;
}

/** 角色 → 占位图缓存键 */
const PLACEHOLDER_KEY_BY_ROLE = new Map(
  PLACEHOLDER_SPECS.map((spec) => [spec.role, spec.cacheKey] as const),
);

export async function resolveFallback(
  deps: FallbackDeps,
  item: AssetRequirementItem,
): Promise<ResolvedAsset> {
  const cacheKey = item.role === 'ROUTE_MAP' ? undefined : PLACEHOLDER_KEY_BY_ROLE.get(item.role);

  if (cacheKey !== undefined) {
    const placeholder = await deps.assets.findByCacheKey(cacheKey);
    if (
      placeholder !== null &&
      placeholder.width !== null &&
      placeholder.height !== null &&
      placeholder.mimeType !== null
    ) {
      return {
        schema_version: SCHEMA_VERSIONS.resolvedAsset,
        slot_id: item.slot_id,
        // 8.1：FALLBACK 也有 asset —— 占位素材是正式素材记录
        status: 'FALLBACK',
        asset: {
          asset_id: placeholder.assetId,
          asset_type: 'IMAGE',
          source_type: 'DEFAULT_PLACEHOLDER',
          representation_type: placeholder.representationType as RepresentationType,
          mime_type: placeholder.mimeType,
          urls: { original: placeholder.storageUrl, thumbnail: placeholder.thumbnailUrl },
          width: placeholder.width,
          height: placeholder.height,
          aspect_ratio: placeholder.aspectRatio ?? placeholder.width / placeholder.height,
          metadata: { style_tags: [...placeholder.styleTags] },
          license: {
            type: placeholder.licenseType as LicenseType,
            attribution_required: false,
          },
        },
        resolution: { strategy: 'STATIC_DEFAULT', score: 0, fallback_level: 2 },
      };
    }
  }

  /*
   * 8.1 的 `SKIPPED` 语义是「`required: false` 且全部来源均未达阈值，
   * 模板隐藏该槽位」。必需槽位（Hero）走到这里时也用 SKIPPED ——
   * 见文件头：模板对 `hero_asset: null` 有渐变背景分支，
   * 用 FAILED 会把一次运维遗漏变成用户拿不到计划。
   */
  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: item.slot_id,
    status: 'SKIPPED',
    asset: null,
    resolution: { strategy: 'STATIC_DEFAULT', score: 0, fallback_level: 3 },
  };
}
