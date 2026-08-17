/**
 * 素材匹配、缓存键与路线图渲染的纯逻辑（设计稿十章、十九章、14.2）。
 *
 * ## 为什么是独立包
 *
 * 设计稿 22.2 把这些能力列在 `apps/generation-worker/src/assets/` 下，
 * 但它们有三个消费方：
 *   - generation-worker：解析编排（TP-3-14）
 *   - api：14.1 / 14.2 两个内部端点（对外契约）
 *   - 素材灌库 CLI：入库时要算 `search_text` 与缓存键（TP-3-06）
 *
 * 与 `@tps/presentation` 同一处理：零 IO 的纯逻辑，抽成包是自然归属。
 * 有 IO 的部分（sharp 后处理、对象存储上传、数据库读写）仍在应用侧。
 */

export {
  fullWidthToHalf,
  jaccard,
  normalizeKeySegment,
  normalizeName,
  stripBrackets,
  tokenize,
} from './normalize.js';

export {
  ENTITY_ALIASES,
  NEUTRAL_ENTITY_SCORE,
  NEUTRAL_QUALITY_SCORE,
  REGION_CITIES,
  ROLE_QUERY_LABEL,
  SCORE_ACCEPT_IMMEDIATELY,
  SCORE_MINIMUM,
  SCORE_WEIGHTS,
  aspectRatioScore,
  destinationMatch,
  entityMatch,
  licenseScore,
  qualityScore,
  resolutionScore,
  scoreAsset,
  semanticQueryText,
  semanticSimilarity,
  type ScoreBreakdown,
  type ScoringCandidate,
  type ScoringRequirement,
} from './scoring.js';

export { THEME_KEYWORDS, themeBucket } from './theme-buckets.js';

export {
  AI_ASSET_TYPE_BY_ROLE,
  IMAGE_PROMPT_VERSION,
  NEGATIVE_REQUIREMENTS,
  briefForRequirement,
  buildVisualBrief,
  imageSizeFor,
  renderNegativePrompt,
  renderPrompt,
  type BuildBriefInput,
} from './visual-brief.js';

export { buildSearchText, type SearchTextInput } from './search-text.js';

export {
  KEY_VERSION,
  aspectRatioSegment,
  destinationSegment,
  foodCacheKey,
  heroCacheKey,
  mapCacheKey,
  placeCacheKey,
  routeNodeHash,
  validRouteNodes,
  type FoodKeyInput,
  type HeroKeyInput,
  type PlaceKeyInput,
} from './cache-keys.js';

export {
  MAP_HEIGHT,
  MAP_WIDTH,
  MIN_ROUTE_NODES,
  escapeXml,
  renderSchematicMap,
  type RenderMapInput,
  type RenderMapResult,
  type RenderedMap,
} from './svg-map.js';

export {
  CANDIDATE_LIMIT,
  SELECTION_BUDGET_MS,
  selectBestCandidate,
  type ScoredCandidate,
  type SelectOptions,
  type SelectionOutcome,
  type SelectionReason,
  type SelectionResult,
} from './selection.js';
