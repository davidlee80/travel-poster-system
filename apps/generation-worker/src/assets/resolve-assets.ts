import {
  SELECTION_BUDGET_MS,
  foodCacheKey,
  heroCacheKey,
  placeCacheKey,
  themeBucket,
} from '@tps/assets';
import type { AssetsRepository, SaveBindingInput } from '@tps/db';
import type { EmbeddingClient, ImageClient } from '@tps/llm';
import { sourceNote, type AssetLookup } from '@tps/presentation';
import type { AssetLock } from '@tps/queue';
import {
  SCHEMA_VERSIONS,
  type AssetRequirement,
  type AssetRequirementItem,
  type AssetResolveResponse,
  type AssetWarningCode,
  type LicenseType,
  type RepresentationType,
  type ResolvedAsset,
} from '@tps/schemas';
import type { ObjectStorage } from '@tps/storage';
import type { Logger, UserType } from '@tps/shared';

import type { AiImageBudget } from './ai-budget.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  assetBatchDuration,
  assetMatchScore,
  assetResolutionDuration,
  assetResolutionTotal,
} from './asset-metrics.js';
import { resolveByAi } from './resolvers/ai-generator.js';
import { resolveFallback } from './resolvers/fallback.js';
import {
  resolveByLicensedSource,
  type LicensedSourceLayerDeps,
} from './resolvers/licensed-source.js';
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
 * HERO_BACKGROUND     缓存键命中 → 素材库 → AI 生成 → 默认占位（9.3）
 * DESTINATION_PHOTO   缓存键命中 → 素材库 → AI 生成 → 默认占位（9.4）
 * FOOD_IMAGE          缓存键命中 → 素材库 → AI 生成 → 默认占位（9.5）
 * ```
 *
 * 三条图片链的完整顺序（9.3～9.6，P6 补上搜索层后）：
 *
 * ```text
 * 缓存键命中 → 素材库 → 授权图源搜索 → AI 生成 → 默认占位
 *     0            0            1            1          2
 * ```
 *
 * 搜索与 AI 同属 `fallback_level: 1`（十八章没有为它们分级），
 * 由 `resolution_strategy` 区分 —— 那一列会进 `plan_asset_bindings`
 * 的历史数据，因此两者必须可分辨。
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
  /**
   * AI 兜底（十八章的第 1 级，TP-4-02）。
   *
   * 可选：缺省时降级链是「缓存键 → 素材库 → 默认占位」，等级从 0 跳到 2
   * （P3 的行为）。让它可缺省不是为了兼容旧代码，而是因为 21.4 的全局熔断
   * 与「不配置图片供应商的部署」需要同一条无 AI 的路径 ——
   * 而那条路径必须是**经过测试**的，不是应急时才第一次走。
   */
  readonly ai?: AiLayerDeps;
  /**
   * 授权图源搜索（十八章第 1 级的前半，TP-6-03）。
   *
   * 与 `ai` 同样可缺省，理由也相同：9.6 的全局熔断、未配置图源的部署、
   * 以及「只跑库内检索」的场景都需要同一条无搜索的路径 ——
   * 而那条路径必须是**经过测试**的，不是应急时才第一次走。
   */
  readonly licensedSource?: LicensedSourceLayerDeps;
}

/**
 * AI 层的依赖。`budget` 是**每任务一个实例**，因此由调用方按任务构造，
 * 不放进长生命周期的依赖容器里。
 */
export interface AiLayerDeps {
  readonly image: ImageClient;
  readonly assetLock: AssetLock;
  readonly budget: AiImageBudget;
  readonly imageTimeoutMs: number;
  readonly userTypeLabel: UserType;
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
  /**
   * 13.7 的素材告警码，去重后按首次出现顺序（TP-4-09）。
   *
   * 去重是必要的：14 天的任务里同一个原因（比如熔断打开）会重复 40 次，
   * 而 `generation_jobs.warnings` 是给人看的 —— 40 个相同的码只会让
   * 真正独立的那两三个原因被埋掉。次数在指标里
   * （`travel_ai_image_total{outcome="skipped"}`）。
   */
  readonly warnings: readonly AssetWarningCode[];
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
  const warnings = new Set<AssetWarningCode>();
  for (const dayResults of perDay) {
    for (const outcome of dayResults) {
      bySlot.set(outcome.resolved.slot_id, outcome.resolved);
      for (const code of outcome.warnings) warnings.add(code);
    }
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
    warnings: [...warnings],
  };
}

interface SlotOutcome {
  readonly resolved: ResolvedAsset;
  readonly warnings: readonly AssetWarningCode[];
}

/** 单槽位解析，含 800 毫秒预算与异常兜底 */
async function resolveOne(
  deps: ResolveAssetsDeps,
  item: AssetRequirementItem,
  now: () => number,
): Promise<SlotOutcome> {
  const startedAt = now();
  // 预算按槽位独立计时（10.2 第 5 步）
  const deadline = startedAt + SELECTION_BUDGET_MS;

  try {
    const outcome = await resolveByRole(deps, item, deadline);
    record(item, outcome.resolved, (now() - startedAt) / 1000);
    return outcome;
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
    return { resolved: fallback, warnings: ['ASSET_LIBRARY_MISS'] };
  }
}

async function resolveByRole(
  deps: ResolveAssetsDeps,
  item: AssetRequirementItem,
  deadline: number,
): Promise<SlotOutcome> {
  if (item.role === 'ROUTE_MAP') {
    const outcome = await resolveRouteMap(deps, item);
    return {
      resolved: outcome.resolved,
      // 8.2 的文字路线是降级：地图渲染没成功（节点不足或缺 route_data）
      warnings: outcome.kind === 'text_fallback' ? ['ASSET_MAP_RENDER_FAILED'] : [],
    };
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
        warnings: [],
        resolved: {
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
        },
      };
    }
  }

  // ── 平台已审核素材（9.4/9.5 的第一层，9.3 的第二层）──
  const library = await resolveFromLocalLibrary(deps, item, { deadline });
  if (library.kind === 'hit') return { resolved: library.resolved, warnings: [] };

  const aiWarnings: AssetWarningCode[] = ['ASSET_LIBRARY_MISS'];

  /*
   * ── 授权图源搜索（十八章第 1 级的前半，TP-6-03）──
   *
   * 在 AI **之前**：一张合规的真实照片对景点与美食都优于 AI 插画（9.4/9.5），
   * 而它更便宜（5 秒 vs 20 秒）且命中即入库为全平台共享资产 ——
   * 下一次同一冷组合走的是上面那个「素材库」分支，零外呼（9.6）。
   *
   * 位置在缓存键与素材库**之后**：预热命中仍是主路径（21.2 措施二），
   * 搜索只发生在冷组合上。
   */
  const search = deps.licensedSource;
  if (search !== undefined) {
    const searched = await resolveByLicensedSource(
      { ...deps, ...search, searchBudget: search.searchBudget },
      item,
      cacheKey,
    );
    aiWarnings.push(...searched.warnings);
    if (searched.resolved !== null) {
      return { resolved: searched.resolved, warnings: searched.warnings };
    }
  }

  /*
   * ── AI 生成（十八章第 1 级的后半，TP-4-02）──
   *
   * 只有在素材库与搜索都未命中时才走到这里。顺序不能反：AI 生成要花钱、
   * 要 20 秒，而库里那张已经审核过的照片对「景点图」而言本来就更好（9.4）。
   */
  const ai = deps.ai;
  if (ai !== undefined) {
    const generated = await resolveByAi({ ...deps, ...ai, budget: ai.budget }, item, cacheKey);
    aiWarnings.push(...generated.warnings);
    if (generated.resolved !== null) {
      return { resolved: generated.resolved, warnings: generated.warnings };
    }
  }

  deps.logger.info(
    { role: item.role, strategy: 'none' },
    `素材库未命中（${library.reason}）且无 AI 产物，使用默认占位`,
  );
  return { resolved: await resolveFallback(deps, item), warnings: aiWarnings };
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
