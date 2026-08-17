import {
  SELECTION_BUDGET_MS,
  foodCacheKey,
  heroCacheKey,
  placeCacheKey,
  themeBucket,
} from '@tps/assets';
import type { AssetsRepository, SaveBindingInput } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import { sourceNote, type AssetLookup } from '@tps/presentation';
import {
  SCHEMA_VERSIONS,
  type AssetRequirement,
  type AssetRequirementItem,
  type AssetResolveResponse,
  type LicenseType,
  type RepresentationType,
  type ResolvedAsset,
} from '@tps/schemas';
import type { ObjectStorage } from '@tps/storage';
import type { Logger } from '@tps/shared';

import { mapWithConcurrency } from './concurrency.js';
import {
  assetBatchDuration,
  assetMatchScore,
  assetResolutionDuration,
  assetResolutionTotal,
} from './asset-metrics.js';
import { resolveFallback } from './resolvers/fallback.js';
import { resolveFromLocalLibrary } from './resolvers/local-library.js';
import { resolveRouteMap } from './resolvers/svg-map.js';

/**
 * 批量素材解析（TP-3-14，设计稿 14.1、9.x、10.2、19.4、21.2）。
 *
 * 输入是 14.1 的请求信封（`AssetRequirement`），输出是 14.1 的响应体
 * （`AssetResolveResponse`）。契约与那两个 schema 完全一致 ——
 * 见 `apps/api/src/routes/internal-assets.ts` 关于「端点是契约宿主、
 * 主路径是进程内调用」的说明（R-28）。
 *
 * ## 每个槽位的来源顺序（九章）
 *
 * ```text
 * ROUTE_MAP           程序生成 SVG（9.2，不调用图片模型）
 * HERO_BACKGROUND     缓存键命中 → 素材库 → [AI，P4] → 默认占位（9.3）
 * DESTINATION_PHOTO   缓存键命中 → 素材库 → [授权源/AI，P4] → 默认占位（9.4）
 * FOOD_IMAGE          缓存键命中 → 素材库 → [授权源/AI，P4] → 默认占位（9.5）
 * ```
 *
 * ## 并发与预算
 *
 * 21.2：天级 8、单天内槽位 6。每个槽位有独立的 800 毫秒预算（10.2 第 5 步），
 * 从该槽位开始解析时计时 —— 用全局起点会让最后一批槽位天生超时。
 *
 * ## 单个槽位失败不影响其他槽位
 *
 * 每个槽位的异常都在这里被兜住并转成 `FALLBACK`/`SKIPPED`（16.3：素材类
 * 错误不阻断任务）。不兜的话，一次网络抖动会让 14 天的解析整体失败，
 * 而已经解析好的几十个槽位全部作废。
 */

export interface ResolveAssetsDeps {
  readonly assets: AssetsRepository;
  readonly storage: ObjectStorage;
  readonly embedding: EmbeddingClient;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** 21.2 的并发度 */
export const DAY_CONCURRENCY = 8;
export const SLOT_CONCURRENCY = 6;

export interface ResolveAssetsResult {
  readonly response: AssetResolveResponse;
  /** 可直接交给仓储写入的绑定（TP-3-15） */
  readonly bindings: readonly SaveBindingInput[];
  /** 全部槽位的解析结果，按输入顺序 */
  readonly all: readonly ResolvedAsset[];
}

export async function resolveAssets(
  deps: ResolveAssetsDeps,
  envelope: AssetRequirement,
): Promise<ResolveAssetsResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // 按天分组：21.2 的并发模型是两级的，分组必须显式
  const byDay = new Map<number, AssetRequirementItem[]>();
  for (const item of envelope.requirements) {
    const bucket = byDay.get(item.day_number);
    if (bucket === undefined) byDay.set(item.day_number, [item]);
    else bucket.push(item);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);

  const perDay = await mapWithConcurrency(days, DAY_CONCURRENCY, ([, items]) =>
    mapWithConcurrency(items, SLOT_CONCURRENCY, (item) => resolveOne(deps, item, now)),
  );

  /*
   * 结果按**输入顺序**重排。分组打乱了顺序，而 14.1 的响应会被调用方
   * 按槽位回填 —— 顺序不影响正确性，但影响可读性与差异对比
   * （同一个计划两次解析的响应应当逐字节可比）。
   */
  const bySlot = new Map<string, ResolvedAsset>();
  for (const dayResults of perDay) {
    for (const result of dayResults) bySlot.set(result.slot_id, result);
  }
  const all = envelope.requirements
    .map((item) => bySlot.get(item.slot_id))
    .filter((value): value is ResolvedAsset => value !== undefined);

  const resolved = all.filter((result) => result.status === 'RESOLVED');
  const fallbacks = all.filter((result) => result.status === 'FALLBACK');
  const failedOptional = all.filter(
    (result) => result.status === 'SKIPPED' || result.status === 'FAILED',
  );

  /*
   * `PARTIAL` 的判定：必需槽位（16.3 的 HERO_BACKGROUND / ROUTE_MAP）
   * 出现 FAILED。SKIPPED 不算 —— 见 fallback.ts：必需槽位的占位图缺失时
   * 用 SKIPPED，而模板对它有降级分支，页面仍然可渲染。
   */
  const requiredSlots = new Set(
    envelope.requirements.filter((item) => item.required).map((item) => item.slot_id),
  );
  const status: AssetResolveResponse['status'] = all.some(
    (result) => result.status === 'FAILED' && requiredSlots.has(result.slot_id),
  )
    ? 'PARTIAL'
    : 'COMPLETED';

  assetBatchDuration.observe({ outcome: status.toLowerCase() }, (now() - startedAt) / 1000);

  const roleBySlot = new Map(envelope.requirements.map((item) => [item.slot_id, item] as const));
  const bindings: SaveBindingInput[] = [];
  for (const result of all) {
    const item = roleBySlot.get(result.slot_id);
    if (item === undefined || result.asset === null) continue;
    bindings.push({
      planId: envelope.plan_id,
      planVersionId: envelope.plan_version_id,
      dayNumber: item.day_number,
      templateId: envelope.template_id,
      slotId: result.slot_id,
      role: item.role,
      assetId: result.asset.asset_id,
      resolutionStrategy: result.resolution.strategy,
      resolutionScore: result.resolution.score,
    });
  }

  return {
    response: { status, resolved, fallbacks, failed_optional: failedOptional },
    bindings,
    all,
  };
}

/** 单槽位解析，含 800 毫秒预算与异常兜底 */
async function resolveOne(
  deps: ResolveAssetsDeps,
  item: AssetRequirementItem,
  now: () => number,
): Promise<ResolvedAsset> {
  const startedAt = now();
  // 预算按槽位独立计时（10.2 第 5 步）
  const deadline = startedAt + SELECTION_BUDGET_MS;

  try {
    const resolved = await resolveByRole(deps, item, deadline);
    record(item, resolved, (now() - startedAt) / 1000);
    return resolved;
  } catch (error) {
    /*
     * 16.3：素材类错误不阻断任务。这里兜住一切异常 ——
     * 数据库抖动、存储 5xx、嵌入服务超时都归到降级。
     * 不兜的话，一个槽位的异常会让整个 14 天的解析作废。
     */
    deps.logger.error(
      { role: item.role, error_code: 'ASSET_LIBRARY_MISS' },
      `槽位解析异常，降级处理：${String(error)}`,
    );
    const fallback = await resolveFallback(deps, item).catch(() => skipped(item));
    record(item, fallback, (now() - startedAt) / 1000);
    return fallback;
  }
}

async function resolveByRole(
  deps: ResolveAssetsDeps,
  item: AssetRequirementItem,
  deadline: number,
): Promise<ResolvedAsset> {
  if (item.role === 'ROUTE_MAP') {
    const outcome = await resolveRouteMap(deps, item);
    return outcome.resolved;
  }

  // ── 19.4：精确键命中，不重算评分 ──
  const cacheKey = cacheKeyFor(item);
  if (cacheKey !== null) {
    const cached = await deps.assets.findByCacheKey(cacheKey);
    if (
      cached !== null &&
      cached.width !== null &&
      cached.height !== null &&
      cached.mimeType !== null
    ) {
      return {
        schema_version: SCHEMA_VERSIONS.resolvedAsset,
        slot_id: item.slot_id,
        status: 'RESOLVED',
        asset: {
          asset_id: cached.assetId,
          asset_type: 'IMAGE',
          source_type: cached.sourceType === 'AI_GENERATED' ? 'AI_GENERATED' : 'PLATFORM_LIBRARY',
          representation_type: cached.representationType as RepresentationType,
          mime_type: cached.mimeType,
          urls: { original: cached.storageUrl, thumbnail: cached.thumbnailUrl },
          width: cached.width,
          height: cached.height,
          aspect_ratio: cached.aspectRatio ?? cached.width / cached.height,
          metadata: {
            entity_name: cached.entityName,
            destination: cached.destinationName,
            style_tags: [...cached.styleTags],
          },
          license: {
            type: cached.licenseType as LicenseType,
            attribution_required:
              cached.attributionText !== null && cached.attributionText.length > 0,
            attribution_text: cached.attributionText,
          },
        },
        // 19.4：score 恒为 1.0，与 10.1 的相似度不是同一量纲
        resolution: { strategy: 'CACHE_HIT', score: 1, fallback_level: 0 },
      };
    }
  }

  // ── 平台已审核素材（9.4/9.5 的第一层，9.3 的第二层）──
  const library = await resolveFromLocalLibrary(deps, item, { deadline });
  if (library.kind === 'hit') return library.resolved;

  /*
   * 这里本该是「授权图片源 → AI 生成」两层（9.3～9.5），两者都在 P4
   * （TP-4-01/02）。P3 直接落到默认占位，`fallback_level` 因此从 0 跳到 2。
   */
  deps.logger.info(
    { role: item.role, strategy: 'none' },
    `素材库未命中（${library.reason}），使用默认占位`,
  );
  return resolveFallback(deps, item);
}

/** 19.2 的键格式。ROUTE_MAP 的键在 svg-map resolver 里算（它要先渲染） */
function cacheKeyFor(item: AssetRequirementItem): string | null {
  const subject = item.subject;
  if (subject === null || subject === undefined) return null;
  const style = item.visual_constraints.style ?? null;

  switch (item.role) {
    case 'HERO_BACKGROUND':
      return heroCacheKey({
        destinationPlaceId: subject.destination_place_id,
        destinationName: subject.destination,
        bucket: themeBucket(subject.theme),
        visualStyle: style ?? 'CHINESE_TRAVEL_EDITORIAL',
        aspectRatio: item.visual_constraints.aspect_ratio,
      });
    case 'DESTINATION_PHOTO':
      return placeCacheKey({
        placeId: subject.entity_place_id,
        entityName: subject.entity_name,
        role: item.role,
        aspectRatio: item.visual_constraints.aspect_ratio,
      });
    case 'FOOD_IMAGE':
      return subject.entity_name === null || subject.entity_name === undefined
        ? null
        : foodCacheKey({
            dishName: subject.entity_name,
            cityPlaceId: subject.destination_place_id,
            cityName: subject.destination,
            visualStyle: style ?? 'REALISTIC_FOOD_PHOTOGRAPHY',
          });
    case 'ROUTE_MAP':
      return null;
  }
}

function skipped(item: AssetRequirementItem): ResolvedAsset {
  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: item.slot_id,
    status: 'SKIPPED',
    asset: null,
    resolution: { strategy: 'STATIC_DEFAULT', score: 0, fallback_level: 3 },
  };
}

function record(item: AssetRequirementItem, result: ResolvedAsset, seconds: number): void {
  const strategy = result.resolution.strategy.toLowerCase();
  assetResolutionTotal.inc({
    role: item.role,
    strategy,
    outcome: result.status.toLowerCase(),
  });
  assetResolutionDuration.observe({ role: item.role, strategy }, seconds);
  if (result.status === 'RESOLVED' && result.resolution.strategy === 'LOCAL_LIBRARY_MATCH') {
    // 只对素材库命中记分数：CACHE_HIT 的 1.0 与相似度不是同一量纲（19.4），
    // 混进同一个直方图会让分布图变成两个尖峰
    assetMatchScore.observe({ role: item.role }, result.resolution.score);
  }
}

/**
 * 把解析结果转成 `@tps/presentation` 的素材查询器（12.1 的 `*.image` 与
 * `header.hero_asset`、`route_map.svg_url` 三处的数据来源）。
 *
 * 角色取自**需求**而不是从 `slot_id` 里嗅探子串：`source_note` 的判定
 * （AI 景点图标「示意图」）依赖角色，而按字符串猜角色会在槽位命名
 * 变化时静默失效 —— 表现是页面上少了那三个字，而那三个字是二十章
 * 要求的全部披露。
 */
export function toAssetLookup(
  requirements: readonly AssetRequirementItem[],
  results: readonly ResolvedAsset[],
): AssetLookup {
  const bySlot = new Map(results.map((result) => [result.slot_id, result] as const));
  const roleBySlot = new Map(requirements.map((item) => [item.slot_id, item.role] as const));

  return (slotId) => {
    const result = bySlot.get(slotId);
    if (result === undefined || result.asset === null) return undefined;

    const asset = result.asset;
    const role = roleBySlot.get(slotId);
    const note =
      role === 'HERO_BACKGROUND' || role === 'DESTINATION_PHOTO' || role === 'FOOD_IMAGE'
        ? sourceNote(asset.source_type, role)
        : null;

    return {
      image: { asset_id: asset.asset_id, url: asset.urls.original, source_note: note },
      hero: {
        asset_id: asset.asset_id,
        url: asset.urls.original,
        source_type: asset.source_type,
      },
      svgUrl: asset.asset_type === 'SVG' ? asset.urls.original : null,
    };
  };
}
