import { z } from 'zod';

/**
 * 全部枚举定义（设计稿 5.1、6.1、8.1、13.5）。
 *
 * 每个枚举导出三样东西：
 *   - `XXX_VALUES` 常量数组 —— 供穷尽性校验与遍历
 *   - `XXXSchema`  Zod 枚举   —— 供运行期校验与 JSON Schema 导出
 *   - `XXX` 类型              —— 供编译期约束
 *
 * 之所以不只导出 Zod schema：`Record<Period, IconName>` 这类穷尽映射需要
 * 字面量联合类型，而映射表的完整性检查是 9.1 图标护栏的实现方式（TP-1-03）。
 */

// ── 六章：TravelPlan ────────────────────────────────────────

/** 计划状态。`REJECTED` 只落库供排查，永不对外展示（设计稿 3.2.2、验收标准 15） */
export const PLAN_STATUS_VALUES = ['READY', 'REPAIRED', 'REJECTED'] as const;
export const PlanStatusSchema = z.enum(PLAN_STATUS_VALUES);
export type PlanStatus = (typeof PLAN_STATUS_VALUES)[number];

/** 行程时段。中文映射与图标名见 12.1 */
export const PERIOD_VALUES = ['MORNING', 'NOON', 'AFTERNOON', 'EVENING', 'NIGHT'] as const;
export const PeriodSchema = z.enum(PERIOD_VALUES);
export type Period = (typeof PERIOD_VALUES)[number];

/** 餐次。同日内不得重复（业务规则 V-41） */
export const MEAL_VALUES = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as const;
export const MealSchema = z.enum(MEAL_VALUES);
export type Meal = (typeof MEAL_VALUES)[number];

/** 美食实体类型。决定素材检索走菜品图库还是店铺图库（设计稿 9.5） */
export const FOOD_ENTITY_TYPE_VALUES = ['DISH', 'RESTAURANT', 'MARKET'] as const;
export const FoodEntityTypeSchema = z.enum(FOOD_ENTITY_TYPE_VALUES);
export type FoodEntityType = (typeof FOOD_ENTITY_TYPE_VALUES)[number];

/** 推荐路线类型。每日最多 3 条且 type 不重复（业务规则 V-43 相关） */
export const ROUTE_TYPE_VALUES = ['RELAXED', 'CLASSIC', 'DEEP', 'FAMILY'] as const;
export const RouteTypeSchema = z.enum(ROUTE_TYPE_VALUES);
export type RouteType = (typeof ROUTE_TYPE_VALUES)[number];

/** 拍照机位的建议时间。用作素材检索的 style_tags 提示 */
export const PREFERRED_TIME_VALUES = ['MORNING', 'AFTERNOON', 'GOLDEN_HOUR', 'NIGHT'] as const;
export const PreferredTimeSchema = z.enum(PREFERRED_TIME_VALUES);
export type PreferredTime = (typeof PREFERRED_TIME_VALUES)[number];

/** 交通方式。决定 ViewModel 用哪个图标（12.1） */
export const TRANSPORT_MODE_VALUES = ['WALK', 'TRANSIT', 'TAXI', 'BOAT', 'BIKE', 'DRIVE'] as const;
export const TransportModeSchema = z.enum(TRANSPORT_MODE_VALUES);
export type TransportMode = (typeof TRANSPORT_MODE_VALUES)[number];

/** 预订贴士分类 */
export const BOOKING_CATEGORY_VALUES = [
  'RESTAURANT',
  'ATTRACTION',
  'ACCOMMODATION',
  'TRANSPORT',
  'SHOW',
] as const;
export const BookingCategorySchema = z.enum(BOOKING_CATEGORY_VALUES);
export type BookingCategory = (typeof BOOKING_CATEGORY_VALUES)[number];

/** 预算分桶。breakdown 必须能汇总回这四桶（业务规则 V-20） */
export const BUDGET_BUCKET_VALUES = ['TICKET', 'TRANSPORT', 'MEAL', 'OTHER'] as const;
export const BudgetBucketSchema = z.enum(BUDGET_BUCKET_VALUES);
export type BudgetBucket = (typeof BUDGET_BUCKET_VALUES)[number];

/** 约束违规严重级。与 3.2.1 的定义一致 */
export const VIOLATION_SEVERITY_VALUES = ['BLOCKING', 'REPAIRABLE', 'ADVISORY'] as const;
export const ViolationSeveritySchema = z.enum(VIOLATION_SEVERITY_VALUES);
export type ViolationSeverity = (typeof VIOLATION_SEVERITY_VALUES)[number];

// ── 五章：TravelRequestUI ───────────────────────────────────

/** V1 仅支持 FIXED；SUGGESTED 保留给 V2（设计稿 1.2） */
export const DESTINATION_MODE_VALUES = ['FIXED'] as const;
export const DestinationModeSchema = z.enum(DESTINATION_MODE_VALUES);
export type DestinationMode = (typeof DESTINATION_MODE_VALUES)[number];

export const BUDGET_BASIS_VALUES = ['PER_PERSON_PER_DAY', 'TOTAL'] as const;
export const BudgetBasisSchema = z.enum(BUDGET_BASIS_VALUES);
export type BudgetBasis = (typeof BUDGET_BASIS_VALUES)[number];

/** V1 仅 CNY（设计稿 5.1） */
export const CURRENCY_VALUES = ['CNY'] as const;
export const CurrencySchema = z.enum(CURRENCY_VALUES);
export type Currency = (typeof CURRENCY_VALUES)[number];

export const BUDGET_INCLUDED_ITEM_VALUES = [
  'ACCOMMODATION',
  'MEALS',
  'LOCAL_TRANSPORT',
  'TICKETS',
  'INTERCITY_TRANSPORT',
  /*
   * P8 新增。原型的预算包含项有六个勾选框，购物是唯一没有对应值的一个。
   *
   * 加它是安全的：仓库里没有任何 `Record<BudgetIncludedItem, …>`，也没有对
   * 该枚举的穷举 switch —— `included_items` 一路透传到 normalize 与
   * `NormalizedBudget`，因此不存在「漏配一个分支」的落点（已逐处核对）。
   * 这一句写在这里是为了让下一个加值的人知道该去确认什么。
   *
   * 注意它与 `interest.shopping` 是两件事：这里是「预算含不含购物开支」，
   * 那里是「想不想逛」。同时勾选是合理输入。
   */
  'SHOPPING',
] as const;
export const BudgetIncludedItemSchema = z.enum(BUDGET_INCLUDED_ITEM_VALUES);
export type BudgetIncludedItem = (typeof BUDGET_INCLUDED_ITEM_VALUES)[number];

/**
 * 已经自行订好的部分（P8，原型第 1 步的「已有订单」）。
 *
 * ## 为什么是数组而不是带 NONE 成员的枚举
 *
 * 空数组就是「尚无预订」。加一个 `NONE` 成员会造出 `['NONE','LODGING']`
 * 这种自相矛盾却结构合法的值，而那需要再写一条校验去拦。
 *
 * ## 为什么要采集它
 *
 * 它改变行程结构而不只是文案：已订酒店意味着住宿位置固定、每日路线要围绕
 * 它排；已订往返交通意味着首末日的时间窗被钉住。丢掉这一项等于让模型在
 * 错误前提下规划，而产出的计划看起来完全正常。
 */
export const EXISTING_BOOKING_VALUES = ['INTERCITY_TRANSPORT', 'LODGING', 'TICKETS'] as const;
export const ExistingBookingSchema = z.enum(EXISTING_BOOKING_VALUES);
export type ExistingBooking = (typeof EXISTING_BOOKING_VALUES)[number];

/**
 * 预算档位（P8，原型第 3 步的五张卡片）。
 *
 * 数值已经进了 `budget.min`/`max`，档位名仍然要传：同一个预算区间下
 * 「经济穷游」与「品质度假」的选点取向不同（前者优先免费/低价景点，
 * 后者优先体验质量）。只发两个数字会把这层意图丢掉。
 *
 * `CUSTOM` 表示用户拖了滑块 —— 此时 min/max 才是唯一权威，档位名不含信息。
 */
export const BUDGET_TIER_VALUES = ['ECONOMY', 'STANDARD', 'QUALITY', 'LUXURY', 'CUSTOM'] as const;
export const BudgetTierSchema = z.enum(BUDGET_TIER_VALUES);
export type BudgetTier = (typeof BUDGET_TIER_VALUES)[number];

export const PACE_LEVEL_VALUES = ['RELAXED', 'BALANCED', 'PACKED'] as const;
export const PaceLevelSchema = z.enum(PACE_LEVEL_VALUES);
export type PaceLevel = (typeof PACE_LEVEL_VALUES)[number];

export const CONDITION_MODE_VALUES = ['MUST', 'SHOULD'] as const;
export const ConditionModeSchema = z.enum(CONDITION_MODE_VALUES);
export type ConditionMode = (typeof CONDITION_MODE_VALUES)[number];

export const LOCALE_VALUES = ['zh-CN'] as const;
export const LocaleSchema = z.enum(LOCALE_VALUES);
export type Locale = (typeof LOCALE_VALUES)[number];

// ── 七章：AssetRequirement ─────────────────────────────────

/**
 * 槽位角色（设计稿七章的 `role`）。
 *
 * 只有四个 —— 与九章的四条来源决策规则一一对应（9.2 路线图、9.3 Hero、
 * 9.4 景点图、9.5 美食图）。图标不在此列：9.1 的图标在编译期内联进产物，
 * 不走素材解析（因此也没有 `ICON` 角色的槽位）。
 *
 * 16.3：只有 `HERO_BACKGROUND` 与 `ROUTE_MAP` 是 `required: true`。
 */
export const ASSET_ROLE_VALUES = [
  'HERO_BACKGROUND',
  'FOOD_IMAGE',
  'DESTINATION_PHOTO',
  'ROUTE_MAP',
] as const;
export const AssetRoleSchema = z.enum(ASSET_ROLE_VALUES);
export type AssetRole = (typeof ASSET_ROLE_VALUES)[number];

/**
 * 需求侧的素材类型（设计稿七章的 `asset_type`）。
 *
 * 注意它与八章 `asset.asset_type`（`IMAGE`/`SVG`/`ICON`）**不是同一个枚举**：
 * 这里表达的是「可以接受哪些来源」，八章表达的是「拿到的东西是什么」。
 * 同名不同义是设计稿的写法，改名会让代码与文档对不上，因此保留原名，
 * 用类型名区分（`RequirementAssetType` / `AssetType`）。
 */
export const REQUIREMENT_ASSET_TYPE_VALUES = [
  'AI_ILLUSTRATION',
  'PHOTO_OR_AI',
  'REAL_PHOTO_PREFERRED',
  'GENERATED_SVG',
] as const;
export const RequirementAssetTypeSchema = z.enum(REQUIREMENT_ASSET_TYPE_VALUES);
export type RequirementAssetType = (typeof REQUIREMENT_ASSET_TYPE_VALUES)[number];

/** 视觉风格（七章 `visual_constraints.style`）。小写形式进缓存键（19.1） */
export const VISUAL_STYLE_VALUES = [
  'CHINESE_TRAVEL_EDITORIAL',
  'REALISTIC_FOOD_PHOTOGRAPHY',
] as const;
export const VisualStyleSchema = z.enum(VISUAL_STYLE_VALUES);
export type VisualStyle = (typeof VISUAL_STYLE_VALUES)[number];

// ── 八章：ResolvedAsset ────────────────────────────────────

export const ASSET_STATUS_VALUES = ['RESOLVED', 'FALLBACK', 'SKIPPED', 'FAILED'] as const;
export const AssetStatusSchema = z.enum(ASSET_STATUS_VALUES);
export type AssetStatus = (typeof ASSET_STATUS_VALUES)[number];

export const ASSET_TYPE_VALUES = ['IMAGE', 'SVG', 'ICON'] as const;
export const AssetTypeSchema = z.enum(ASSET_TYPE_VALUES);
export type AssetType = (typeof ASSET_TYPE_VALUES)[number];

export const ASSET_SOURCE_TYPE_VALUES = [
  'PLATFORM_LIBRARY',
  'LICENSED_SOURCE',
  'AI_GENERATED',
  'GENERATED_SVG',
  'LOCAL_ICON',
  'DEFAULT_PLACEHOLDER',
] as const;
export const AssetSourceTypeSchema = z.enum(ASSET_SOURCE_TYPE_VALUES);
export type AssetSourceType = (typeof ASSET_SOURCE_TYPE_VALUES)[number];

/**
 * AI 生成物必须标记为 ILLUSTRATIVE（设计稿 9.4、二十章）。
 * 该约束在数据库层由 `assets_ai_must_be_illustrative` 强制（设计稿十五章）。
 */
export const REPRESENTATION_TYPE_VALUES = ['PHOTOGRAPHIC', 'ILLUSTRATIVE'] as const;
export const RepresentationTypeSchema = z.enum(REPRESENTATION_TYPE_VALUES);
export type RepresentationType = (typeof REPRESENTATION_TYPE_VALUES)[number];

/** 授权类型（8.1）。评分见 10.1 的 `license_score` */
export const LICENSE_TYPE_VALUES = ['PLATFORM_OWNED', 'LICENSED', 'AI_GENERATED', 'CC0'] as const;
export const LicenseTypeSchema = z.enum(LICENSE_TYPE_VALUES);
export type LicenseType = (typeof LICENSE_TYPE_VALUES)[number];

/**
 * 解析策略（8.1）。
 *
 * `CACHE_HIT` 与其余策略不是同一量纲：它的 `score` 恒为 1.0，表示「精确键
 * 命中」而不是相似度 1.0（19.4）。区分二者靠的就是这个字段。
 */
export const RESOLUTION_STRATEGY_VALUES = [
  'LOCAL_LIBRARY_MATCH',
  'LICENSED_SOURCE_MATCH',
  'AI_GENERATION',
  'SVG_RENDER',
  'CACHE_HIT',
  'STATIC_DEFAULT',
  'TEXT_FALLBACK',
] as const;
export const ResolutionStrategySchema = z.enum(RESOLUTION_STRATEGY_VALUES);
export type ResolutionStrategy = (typeof RESOLUTION_STRATEGY_VALUES)[number];

/** 文字降级的形态（8.2）。V1 只有路线节点列表一种 */
export const TEXT_FALLBACK_KIND_VALUES = ['ROUTE_NODE_LIST'] as const;
export const TextFallbackKindSchema = z.enum(TEXT_FALLBACK_KIND_VALUES);
export type TextFallbackKind = (typeof TEXT_FALLBACK_KIND_VALUES)[number];

// ── 十五章 / 十九章：素材存储 ──────────────────────────────

/**
 * 素材的在架状态。
 *
 * 19.3 的失效条件表里三类素材都写着「人工下架（`assets.status`）」，
 * 但十五章的建表 SQL 没有这一列 —— 迁移 0005 补上了它，见该文件头。
 * 下架是**标记**而不是删除：`plan_asset_bindings.asset_id` 是
 * `ON DELETE RESTRICT`，而绑定记录本身是二十章可追溯性的一环。
 */
export const ASSET_RECORD_STATUS_VALUES = ['ACTIVE', 'RETIRED'] as const;
export const AssetRecordStatusSchema = z.enum(ASSET_RECORD_STATUS_VALUES);
export type AssetRecordStatus = (typeof ASSET_RECORD_STATUS_VALUES)[number];

/** `asset_variants.variant_type`（11.2 第 5 步） */
export const ASSET_VARIANT_TYPE_VALUES = ['ORIGINAL', 'THUMBNAIL'] as const;
export const AssetVariantTypeSchema = z.enum(ASSET_VARIANT_TYPE_VALUES);
export type AssetVariantType = (typeof ASSET_VARIANT_TYPE_VALUES)[number];

/**
 * 路线图风格（14.2 的 `style`，进地图缓存键）。
 *
 * V1 只有一种 —— 与 `DESTINATION_MODE`（仅 `FIXED`）、`CURRENCY`（仅 `CNY`）
 * 同样的处理：枚举先立起来，键格式与类型不必等到第二种风格出现才改。
 */
export const MAP_STYLE_VALUES = ['CANAL_GREEN'] as const;
export const MapStyleSchema = z.enum(MAP_STYLE_VALUES);
export type MapStyle = (typeof MAP_STYLE_VALUES)[number];

// ── 十一章 / 14.3：AI 图片生成 ─────────────────────────────

/**
 * 14.3 允许生成的四种受控素材类型。
 *
 * 「受控」的含义是**白名单**：不在表内的类型一律拒绝，而不是「拒绝已知的
 * 危险类型」。差别在新增角色时 —— 白名单会让新角色显式地走一次评审
 * （它的 AI 产物是否可接受、要不要标示意图），黑名单会让它默默获得生成权限。
 *
 * `ROUTE_MAP` 不在表内且永远不会进：11.3 禁止 AI 绘制地图文字，
 * 而 9.2 的路线图是程序生成的 SVG。
 *
 * `DECORATIVE_ILLUSTRATION` 在 V1 没有对应槽位（模板的装饰元素是 9.1 的
 * 内联图标）。保留它是因为 14.3 明确列了它，去掉会让端点与设计稿不一致 ——
 * 而端点的存在价值就是冻结契约（R-28）。
 */
export const AI_ASSET_TYPE_VALUES = [
  'HERO_ILLUSTRATION',
  'DECORATIVE_ILLUSTRATION',
  'FOOD_FALLBACK',
  'DESTINATION_ILLUSTRATION_FALLBACK',
] as const;
export const AiAssetTypeSchema = z.enum(AI_ASSET_TYPE_VALUES);
export type AiAssetType = (typeof AI_ASSET_TYPE_VALUES)[number];

/**
 * 11.1 的 `task`。
 *
 * 与 `AI_ASSET_TYPE` 一一对应，但不是同一个枚举：类型说的是「产物在库里
 * 算哪一类」（进配额与成本统计），task 说的是「模型该画什么」。
 * 合成一个的代价是提示词模板与库内分类从此不能各自演化。
 */
export const VISUAL_BRIEF_TASK_VALUES = [
  'GENERATE_TRAVEL_HERO',
  'GENERATE_DESTINATION_ILLUSTRATION',
  'GENERATE_FOOD_ILLUSTRATION',
  'GENERATE_DECORATIVE_ILLUSTRATION',
] as const;
export const VisualBriefTaskSchema = z.enum(VISUAL_BRIEF_TASK_VALUES);
export type VisualBriefTask = (typeof VISUAL_BRIEF_TASK_VALUES)[number];

/**
 * 主题语义桶（19.1 的 12 个 + `general`）。
 *
 * 这是 Hero 缓存能命中的**唯一原因**：`theme` 是 LLM 自由生成的中文短语
 * （「运河人文·古今交融」），直接归一化会得到几乎唯一的键。
 * 值本身就是小写形式，因为它们直接进缓存键，不再转换。
 */
export const THEME_BUCKET_VALUES = [
  'canal_culture',
  'lake_scenery',
  'old_town',
  'museum_art',
  'food_street',
  'mountain_nature',
  'temple_heritage',
  'modern_city',
  'night_view',
  'garden_classic',
  'coastal',
  'family_park',
  'general',
] as const;
export const ThemeBucketSchema = z.enum(THEME_BUCKET_VALUES);
export type ThemeBucket = (typeof THEME_BUCKET_VALUES)[number];

// ── 三章 3.3.1：展示编排 ───────────────────────────────────

export const PAGE_TYPE_VALUES = ['DAILY_POSTER', 'FULL_PLAN'] as const;
export const PageTypeSchema = z.enum(PAGE_TYPE_VALUES);
export type PageType = (typeof PAGE_TYPE_VALUES)[number];

/** 已注册模板。新增模板需同时更新此处与 apps/web/src/templates */
export const TEMPLATE_ID_VALUES = ['travel_infographic_v1', 'travel_full_plan_v1'] as const;
export const TemplateIdSchema = z.enum(TEMPLATE_ID_VALUES);
export type TemplateId = (typeof TEMPLATE_ID_VALUES)[number];

/** 展示数据的校验状态（设计稿十五章 plan_presentations） */
export const PRESENTATION_VALIDATION_VALUES = ['VALID', 'DEGRADED', 'INVALID'] as const;
export const PresentationValidationSchema = z.enum(PRESENTATION_VALIDATION_VALUES);
export type PresentationValidation = (typeof PRESENTATION_VALIDATION_VALUES)[number];

// ── 十三章 13.5：导出 ──────────────────────────────────────

export const EXPORT_FORMAT_VALUES = ['PNG', 'PDF'] as const;
export const ExportFormatSchema = z.enum(EXPORT_FORMAT_VALUES);
export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];

export const EXPORT_SCOPE_VALUES = ['ALL_DAYS', 'SINGLE_DAY', 'FULL_PLAN'] as const;
export const ExportScopeSchema = z.enum(EXPORT_SCOPE_VALUES);
export type ExportScope = (typeof EXPORT_SCOPE_VALUES)[number];

// ── 三章 3.6：身份（R-13）─────────────────────────────────

export const USER_TYPE_VALUES = ['ANONYMOUS', 'REGISTERED'] as const;
export const UserTypeSchema = z.enum(USER_TYPE_VALUES);
export type UserType = (typeof USER_TYPE_VALUES)[number];

export const USER_STATUS_VALUES = ['ACTIVE', 'SUSPENDED', 'MERGED', 'DELETED'] as const;
export const UserStatusSchema = z.enum(USER_STATUS_VALUES);
export type UserStatus = (typeof USER_STATUS_VALUES)[number];
