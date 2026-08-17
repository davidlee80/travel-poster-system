import { createHash } from 'node:crypto';
import type { AssetRole, MapStyle, RouteNode, ThemeBucket, VisualStyle } from '@tps/schemas';
import { normalizeKeySegment } from './normalize.js';
import { themeBucket } from './theme-buckets.js';

/**
 * 缓存键（TP-3-12，设计稿 19.1、19.2）。
 *
 * ```text
 * hero:  hero:v1:{destination}:{theme_bucket}:{visual_style}:{aspect_ratio}
 * place: place:v1:{place_id}:{image_role}:{aspect_ratio}
 * food:  food:v1:{dish_name}:{city}:{visual_style}
 * map:   map:v1:{route_node_hash}:{map_style}
 * ```
 *
 * ## 键版本号不是装饰
 *
 * 19.2：任何影响**产物外观**的变更（AI 提示词模板改版、SVG 渲染器升级、
 * 比例定义变化、归一化规则变化）都必须递增 `KEY_VERSION`，而不是清空缓存。
 * 递增保留旧产物用于回滚与对比；清空则是不可逆的 —— 那些 Hero 是花钱生成的。
 *
 * ## 为什么目的地优先 place_id
 *
 * 19.1：名称会因 LLM 措辞变化（「拱宸桥」/「拱宸桥历史街区」）产生不同键，
 * `place_id` 稳定。缺 `place_id` 时才退化为归一化名称 ——
 * 那种情况下命中率下降是可接受的，产出错图不可接受。
 */

/** 19.2 的键版本号。改动影响产物外观时必须递增 */
export const KEY_VERSION = 'v1';

/** `16:6` → `16x6`（19.1） */
export function aspectRatioSegment(aspectRatio: string): string {
  return aspectRatio.replace(':', 'x');
}

/** 枚举值小写（19.1 的 `visual_style` 一栏） */
function enumSegment(value: string): string {
  return value.toLowerCase();
}

/** 目的地段：优先 place_id，缺失时用归一化名称（19.1） */
export function destinationSegment(input: {
  readonly placeId?: string | null | undefined;
  readonly name?: string | null | undefined;
}): string {
  const placeId = input.placeId ?? null;
  if (placeId !== null && placeId.trim().length > 0) return normalizeKeySegment(placeId);

  const normalized = normalizeKeySegment(input.name ?? '');
  return normalized.length > 0 ? normalized : 'unknown';
}

export interface HeroKeyInput {
  readonly destinationPlaceId?: string | null;
  readonly destinationName?: string | null;
  /** LLM 生成的中文主题短语；归桶后进键（19.1） */
  readonly theme?: string | null;
  /** 已归好的桶。给出时不再从 `theme` 推导（避免重复计算与不一致） */
  readonly bucket?: ThemeBucket;
  readonly visualStyle: VisualStyle;
  readonly aspectRatio: string;
}

export function heroCacheKey(input: HeroKeyInput): string {
  const bucket = input.bucket ?? themeBucket(input.theme);
  return [
    'hero',
    KEY_VERSION,
    destinationSegment({ placeId: input.destinationPlaceId, name: input.destinationName }),
    bucket,
    enumSegment(input.visualStyle),
    aspectRatioSegment(input.aspectRatio),
  ].join(':');
}

export interface PlaceKeyInput {
  readonly placeId?: string | null;
  /** `place_id` 缺失时的退路 */
  readonly entityName?: string | null;
  readonly role: AssetRole;
  readonly aspectRatio: string;
}

export function placeCacheKey(input: PlaceKeyInput): string {
  return [
    'place',
    KEY_VERSION,
    destinationSegment({ placeId: input.placeId, name: input.entityName }),
    enumSegment(input.role),
    aspectRatioSegment(input.aspectRatio),
  ].join(':');
}

export interface FoodKeyInput {
  readonly dishName: string;
  readonly cityPlaceId?: string | null;
  readonly cityName?: string | null;
  readonly visualStyle: VisualStyle;
}

export function foodCacheKey(input: FoodKeyInput): string {
  return [
    'food',
    KEY_VERSION,
    normalizeKeySegment(input.dishName) || 'unknown',
    destinationSegment({ placeId: input.cityPlaceId, name: input.cityName }),
    enumSegment(input.visualStyle),
  ].join(':');
}

/**
 * 路线节点哈希（19.1 最后一行）。
 *
 * `sha256(nodes.map(n => `${name}:${round(lat,4)}:${round(lng,4)}`).join("|")).slice(0,16)`
 *
 * 坐标保留 4 位小数（约 11 米精度）：不做四舍五入的话，同一条路线在两次
 * 生成中因为浮点尾数不同就会得到不同的哈希，地图缓存永不命中。
 *
 * **坐标非法的节点先剔除**，与渲染器保持同一口径 ——
 * 哈希必须是「实际画出来的那张图」的指纹，否则内容寻址失效：
 * 同一张图会有两个键，或者两张不同的图共用一个键（后者会画错）。
 */
export function routeNodeHash(nodes: readonly RouteNode[]): string {
  const text = validRouteNodes(nodes)
    .map((node) => `${node.name}:${round4(node.latitude)}:${round4(node.longitude)}`)
    .join('|');

  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function mapCacheKey(input: {
  readonly nodes: readonly RouteNode[];
  readonly style: MapStyle;
}): string {
  return ['map', KEY_VERSION, routeNodeHash(input.nodes), enumSegment(input.style)].join(':');
}

/** 坐标合法且在地球范围内的节点。渲染与哈希共用这一个判定 */
export function validRouteNodes(
  nodes: readonly RouteNode[],
): { readonly name: string; readonly latitude: number; readonly longitude: number }[] {
  const out: { name: string; latitude: number; longitude: number }[] = [];
  for (const node of nodes) {
    const { latitude, longitude } = node;
    if (latitude === null || longitude === null) continue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    out.push({ name: node.name, latitude, longitude });
  }
  return out;
}

function round4(value: number): string {
  /*
   * `toFixed(4)` 而不是 `Math.round(v * 1e4) / 1e4`：后者会产出
   * 30.32 与 30.3200 这类同值不同串的结果（`String(30.32)` 是 "30.32"），
   * 而哈希是按字符串算的 —— 同一坐标写成两种形式就是两个键。
   */
  return value.toFixed(4);
}
