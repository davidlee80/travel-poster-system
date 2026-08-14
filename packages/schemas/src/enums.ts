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
] as const;
export const BudgetIncludedItemSchema = z.enum(BUDGET_INCLUDED_ITEM_VALUES);
export type BudgetIncludedItem = (typeof BUDGET_INCLUDED_ITEM_VALUES)[number];

export const PACE_LEVEL_VALUES = ['RELAXED', 'BALANCED', 'PACKED'] as const;
export const PaceLevelSchema = z.enum(PACE_LEVEL_VALUES);
export type PaceLevel = (typeof PACE_LEVEL_VALUES)[number];

export const CONDITION_MODE_VALUES = ['MUST', 'SHOULD'] as const;
export const ConditionModeSchema = z.enum(CONDITION_MODE_VALUES);
export type ConditionMode = (typeof CONDITION_MODE_VALUES)[number];

export const LOCALE_VALUES = ['zh-CN'] as const;
export const LocaleSchema = z.enum(LOCALE_VALUES);
export type Locale = (typeof LOCALE_VALUES)[number];

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
