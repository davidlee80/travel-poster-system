/**
 * 展示编排的纯逻辑（设计稿 3.3、12.1、3.2.3）。
 *
 * ## 为什么是独立包，而不是放在 generation-worker 里
 *
 * 设计稿 22.2 把 presentation 列在 `apps/generation-worker/src/` 下，但这些
 * 函数有两个消费方：
 *   - generation-worker：P3 起用真实数据生成 ViewModel 并落库
 *   - web：P1 用 fixture 生成 ViewModel 以驱动模板与视觉基线
 *
 * 应用之间不应互相依赖，而这些函数是**零 IO 的纯逻辑**，抽成包是最自然的
 * 归属。设计稿 22.2 已同步更新。
 */

export {
  BOOKING_CATEGORY_LABEL,
  BUDGET_BUCKET_LABEL,
  MEAL_LABEL,
  PERIOD_LABEL,
  PREFERRED_TIME_LABEL,
  ROUTE_TYPE_LABEL,
  advanceText,
  amountText,
  dayLabel,
  durationText,
  periodIconName,
  priceText,
  sourceNote,
  totalText,
  transportIconName,
} from './derive.js';

export {
  COMPACT_LIMITS,
  compactL1,
  compactL2,
  toCompact,
  type CompactLimitKey,
} from './compact.js';

export {
  CONDITION_CODES,
  CONDITION_DOMAIN_LABEL,
  CONDITION_LABEL,
  MUST_BY_DEFAULT_DOMAINS,
} from './condition-labels.js';

export { MODULE_ICON_PATHS, moduleIcons } from './icons.js';

export { foodSlotId, heroSlotId, photoSpotSlotId, routeMapSlotId } from './slots.js';

export {
  EMPTY_ASSET_LOOKUP,
  PresentationError,
  buildDailyPoster,
  type AssetLookup,
  type BuildDailyPosterInput,
  type BuildResult,
  type SlotResolution,
} from './build-view-model.js';

export {
  buildFullPlan,
  type BuildFullPlanInput,
  type BuildFullPlanResult,
  type FullPlanViewModel,
} from './build-full-plan.js';
export {
  RENDER_ROUNDS,
  parseRenderVariant,
  variantToQuery,
  type RenderLayout,
  type RenderVariant,
} from './render-variant.js';
