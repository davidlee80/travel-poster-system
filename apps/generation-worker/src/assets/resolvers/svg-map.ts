import { randomUUID } from 'node:crypto';

import { mapCacheKey, renderSchematicMap } from '@tps/assets';
import type { AssetsRepository } from '@tps/db';
import { SCHEMA_VERSIONS, type AssetRequirementItem, type ResolvedAsset } from '@tps/schemas';
import type { ObjectStorage } from '@tps/storage';
import type { Logger } from '@tps/shared';

/**
 * svg-map resolver（TP-3-10，设计稿 9.2、14.2、19.3）。
 *
 * ```text
 * ROUTE_MAP
 *   → 缓存命中（map:v1:{hash}:{style}）→ CACHE_HIT
 *   → 渲染 SVG → 上传 → 落库 → SVG_RENDER
 *   → 有效节点 < 2 → 文字路线（8.2 的 text_fallback）
 * ```
 *
 * ## 内容寻址让缓存天然正确
 *
 * 键含 `route_node_hash`，而哈希是「实际画出来的那张图」的指纹
 * （节点名 + 4 位小数坐标）。因此：
 *   - 同一条路线在任何计划、任何用户下都命中同一张 SVG（19.5 跨计划复用）；
 *   - 路线一变哈希就变，旧图自然不再被命中（19.3「内容寻址」）——
 *     不需要任何失效逻辑。
 *
 * ## R-29：不走 Redis 缓存索引
 *
 * 19.3 让 Redis 存 `cache_key → asset_id` 的映射，作为「跳过数据库查询的
 * 快路径」。按它写的形态（只存 ID）**省不掉那次查询** —— 构造
 * `ResolvedAsset` 需要 `storage_url`、宽高，以及当前的 `status`
 * （素材可能已被人工下架），拿到 ID 之后仍要回表读这一行。
 *
 * 要真省掉，就得把整行缓存进 Redis，而那会把 19.3 自己要防的问题带回来：
 * 素材下架后 Redis 里还留着一份可用的旧数据，而下架的原因通常是版权。
 *
 * 而它本来要省的那次查询是 `assets_cache_key_uk` 上的单行唯一索引命中 ——
 * 大约 1 毫秒，而单槽位预算是 800 毫秒（10.2）。因此这里直接用
 * `findByCacheKey`：`assets.cache_key` 的唯一索引本身就是快路径，
 * 也是 19.3 说的「最终真相」。
 *
 * Redis 在素材路径上仍有一处真正的用途 —— 13.8 的 `lock:asset:{cache_key}`
 * 并发去重（同键 10 并发只生成一次），那是 P4 的 TP-4-06，与这里无关。
 *
 * ## SVG 也进 assets 表
 *
 * 8.2 把它定义成 `asset_type: 'SVG'` 的正式素材，而不是「附属文件」。
 * 这样 `plan_asset_bindings` 能一致地引用它（二十章的来源可追溯），
 * 也让「这个计划用了哪些素材」有唯一答案。
 */

export interface SvgMapDeps {
  readonly assets: AssetsRepository;
  readonly storage: ObjectStorage;
  readonly logger: Logger;
}

export type SvgMapOutcome =
  | { readonly kind: 'resolved'; readonly resolved: ResolvedAsset }
  /** 有效节点不足 2 个 → 文字路线（十八章的最后一环） */
  | { readonly kind: 'text_fallback'; readonly resolved: ResolvedAsset };

function svgObjectKey(assetId: string): string {
  return `assets/route_map/${assetId.slice(0, 2)}/${assetId}.svg`;
}

export async function resolveRouteMap(
  deps: SvgMapDeps,
  item: AssetRequirementItem,
): Promise<SvgMapOutcome> {
  const routeData = item.route_data;
  if (routeData === null || routeData === undefined) {
    /*
     * schema 保证 ROUTE_MAP 一定带 route_data（AssetRequirementItemSchema 的
     * refine），走到这里说明调用方绕过了 schema 校验。按「没有节点」处理，
     * 而不是抛错 —— 素材类错误不该阻断任务（16.3）。
     */
    deps.logger.error({ role: item.role }, 'ROUTE_MAP 槽位缺 route_data，按文字降级处理');
    return { kind: 'text_fallback', resolved: textFallback(item, []) };
  }

  const rendered = renderSchematicMap({ nodes: routeData.nodes, style: routeData.style });
  if (rendered.kind === 'insufficient_nodes') {
    return {
      kind: 'text_fallback',
      resolved: textFallback(
        item,
        routeData.nodes.map((node) => node.name),
      ),
    };
  }

  const cacheKey = mapCacheKey({ nodes: routeData.nodes, style: routeData.style });

  // ── 19.4：精确键命中，不重算评分 ──
  const cached = await deps.assets.findByCacheKey(cacheKey);
  if (cached !== null) {
    return {
      kind: 'resolved',
      resolved: svgAsset(item, {
        assetId: cached.assetId,
        url: cached.storageUrl,
        width: cached.width ?? rendered.map.width,
        height: cached.height ?? rendered.map.height,
        nodeCount: rendered.map.nodeCount,
        routeNodeHash: rendered.map.routeNodeHash,
        mapStyle: routeData.style,
        strategy: 'CACHE_HIT',
        score: 1,
      }),
    };
  }

  const assetId = randomUUID();
  const url = await deps.storage.put({
    key: svgObjectKey(assetId),
    body: new TextEncoder().encode(rendered.map.svg),
    contentType: 'image/svg+xml',
  });

  const saved = await deps.assets.insertAsset({
    assetId,
    assetType: 'SVG',
    sourceType: 'GENERATED_SVG',
    // 示意图不是照片
    representationType: 'ILLUSTRATIVE',
    entityName: null,
    destinationName: null,
    destinationPlaceId: null,
    title: `路线示意图（${rendered.map.nodeCount} 个地点）`,
    originalUrl: null,
    storageUrl: url,
    // 8.2：SVG 的 thumbnail 恒为 null
    thumbnailUrl: null,
    mimeType: 'image/svg+xml',
    width: rendered.map.width,
    height: rendered.map.height,
    aspectRatio: Math.round((rendered.map.width / rendered.map.height) * 1e5) / 1e5,
    styleTags: [routeData.style.toLowerCase()],
    /*
     * SVG 不参与素材库检索（它按缓存键精确命中），因此 search_text 与
     * embedding 都留空。给它们填值只会让路线图出现在景点图的候选集里。
     */
    searchText: '',
    licenseType: 'PLATFORM_OWNED',
    attributionText: null,
    licenseExpiresAt: null,
    qualityScore: null,
    embedding: null,
    cacheKey,
    generationMetadata: null,
  });

  return {
    kind: 'resolved',
    resolved: svgAsset(item, {
      assetId: saved.assetId,
      url,
      width: rendered.map.width,
      height: rendered.map.height,
      nodeCount: rendered.map.nodeCount,
      routeNodeHash: rendered.map.routeNodeHash,
      mapStyle: routeData.style,
      /*
       * `created` 为 false 说明并发写入时对方先落库（唯一索引兜底）。
       * 这一次仍然渲染并上传了，但用的是对方那行 —— 从缓存视角看
       * 它就是一次命中，因此 strategy 记 CACHE_HIT（19.4 的 score 恒为 1.0）。
       */
      strategy: saved.created ? 'SVG_RENDER' : 'CACHE_HIT',
      score: 1,
    }),
  };
}

interface SvgAssetInput {
  readonly assetId: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly nodeCount: number;
  readonly routeNodeHash: string;
  readonly mapStyle: string;
  readonly strategy: 'SVG_RENDER' | 'CACHE_HIT';
  readonly score: number;
}

function svgAsset(item: AssetRequirementItem, input: SvgAssetInput): ResolvedAsset {
  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: item.slot_id,
    status: 'RESOLVED',
    asset: {
      asset_id: input.assetId,
      asset_type: 'SVG',
      source_type: 'GENERATED_SVG',
      representation_type: 'ILLUSTRATIVE',
      mime_type: 'image/svg+xml',
      urls: { original: input.url, thumbnail: null },
      width: input.width,
      height: input.height,
      aspect_ratio: Math.round((input.width / input.height) * 1e5) / 1e5,
      metadata: {
        route_node_hash: input.routeNodeHash,
        map_style: input.mapStyle,
        node_count: input.nodeCount,
      },
      license: { type: 'PLATFORM_OWNED', attribution_required: false },
    },
    resolution: { strategy: input.strategy, score: input.score, fallback_level: 0 },
  };
}

/** 8.2 的文字路线降级 */
function textFallback(item: AssetRequirementItem, nodeNames: readonly string[]): ResolvedAsset {
  const nodes = nodeNames.filter((name) => name.trim().length > 0);

  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: item.slot_id,
    /*
     * 节点名一个都没有时也用 FALLBACK 而不是 FAILED：
     * ROUTE_MAP 是必需素材（16.3），FAILED 会让任务按「必需素材缺失」判定，
     * 而 12.1 的模板对 `nodes: []` 有明确行为（不渲染路线块）。
     * `text_fallback.nodes` 至少一项是 schema 要求的，因此空数组时
     * 给一句说明 —— 它会出现在页面上，比一块空白好。
     */
    status: 'FALLBACK',
    asset: null,
    text_fallback: {
      kind: 'ROUTE_NODE_LIST',
      nodes: nodes.length > 0 ? [...nodes] : ['当日行程未提供可定位的地点'],
    },
    resolution: { strategy: 'TEXT_FALLBACK', score: 0, fallback_level: 2 },
  };
}
