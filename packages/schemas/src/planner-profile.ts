import { z } from 'zod';

import { ConditionCodeSchema } from './conditions.js';
import { CurrencySchema } from './enums.js';
import { DateStringSchema, NonEmptyStringSchema, TimeStringSchema } from './primitives.js';

/**
 * Planner V2.1 的 76 字段问卷答案（`planner_profile`）。
 *
 * ## 为什么是一个新的顶层块，而不是就地扩展 trip/travelers/budget/pace
 *
 * 就地扩展会立刻撞上「同一概念两个路径」：字段表的 `budget.travel_tier` 与
 * P8 的 `budget.tier`、`pace.level`（1～5 整数）与 P8 的 `pace.intensity`、
 * `profile.additional_notes` 与 `custom_requirements.raw_text`，四对都是同一件事。
 * 就地扩展的结果是要么改掉 P8 的字段名（破坏性变更），要么维护一张
 * 「api_key → 实际路径」的别名表 —— 而别名表是第二个真相源，
 * 漏一条的表现是「用户填了档次，生成时读到 undefined」。
 *
 * 新块把这件事变成一条可断言的规则：
 *
 *     76 个字段的载荷路径 === `planner_profile.` + api_key
 *
 * 由 `planner-profile.test.ts` 逐个 api_key 走 schema 验证。子块名与
 * api_key 的第一段逐字相同，因此 `planner_profile.profile.trip_purposes`
 * 这种略显重复的路径是**刻意的** —— 为了让上面那条规则没有例外。
 *
 * ## 与既有 conditions / trip / budget / pace 的关系
 *
 * `planner_profile` 是**用户答案的逐字记录**，`trip` / `travelers` / `budget` /
 * `pace` / `conditions` 是**投影**，喂给 P1～P8 已有的生成链路。前端两者都发：
 *
 *   - 投影让 V-30/V-32 硬约束校验、N-01～N-12、Prompt 一行不改仍然工作；
 *   - 逐字记录让 76 个 field_id 各自有独立 binding（规范 21.1 的阻塞发布门槛），
 *     并让 21.2 的 `source_field_id` 能指回具体字段。
 *
 * 三态标签（`transport.intercity_modes` 等 4 个字段）在两处都出现：这里保留
 * 用户选的 code + 态，`conditions[]` 保留投影后的 MUST/SHOULD。看起来是冗余，
 * 但两者的权威范围不同 —— `conditions` 的 code 白名单由配置中心的发布版本决定
 * （见 conditions.ts 与 apps/api 的 `allowedConditionCodes`），而问卷答案必须
 * 在配置改版后仍然可回放。
 *
 * ## 为什么选项枚举定义在本文件而不是 enums.ts
 *
 * enums.ts 是五大数据契约共用枚举的真相源；这里的 30 余个枚举各自只服务
 * **一个**问卷字段，且不出现在 TravelPlan / ViewModel / AssetRequirement 里。
 * 搬进 enums.ts 会让那个文件长出一倍，而读者要在「计划的时段枚举」与
 * 「同行关系枚举」之间来回翻。就近定义，块与它的选项在同一屏。
 */

// ── 共用小类型 ──────────────────────────────────────────────

/**
 * 三态。与 `apps/web` 的 `ConditionStance` 同名同值 —— 那里是界面态，
 * 这里是契约值，投影关系见 `conditionToContract`。
 */
export const PLANNER_STANCE_VALUES = ['PREFER', 'REQUIRE', 'EXCLUDE'] as const;
export const PlannerStanceSchema = z.enum(PLANNER_STANCE_VALUES);
export type PlannerStance = (typeof PLANNER_STANCE_VALUES)[number];

/**
 * 一个三态标签的选择。
 *
 * `code` 用 `ConditionCodeSchema`（域前缀正则）而不是内置字面量联合：
 * 配置中心可以发布七个既有域下的新码，写死联合会让新发布的标签在这里被拒，
 * 而症状是「配置改完了，前端能点，提交报 REQ_SCHEMA_INVALID」。
 */
export const StanceSelectionSchema = z.object({
  code: ConditionCodeSchema,
  stance: PlannerStanceSchema,
});
export type StanceSelection = z.infer<typeof StanceSelectionSchema>;

/**
 * 带「其他」补充文字的多选。
 *
 * 字段表里有 6 个字段的选项列表含「其他」并要求补充文字。写成共用形状而不是
 * 给每个字段加一个兄弟键：兄弟键会让「一个字段一个 payload 键」这条规则出现
 * 例外，而例外一旦有一个，那条规则就不能再用测试守。
 */
function multiSelectWithOther<T extends z.ZodTypeAny>(values: T, max: number) {
  return z.object({
    values: z.array(values).max(max),
    /** 仅当 values 含 `OTHER` 时有意义。不做交叉校验 —— 那是前端与 N-xx 的职责 */
    other_text: z.string().max(100).optional(),
  });
}

/** 金额区间。`money_range` 类型的字段用它。不比较 min/max —— 那是 N-xx */
export const MoneyRangeSchema = z.object({
  min: z.number().min(0),
  max: z.number().min(0),
});
export type MoneyRange = z.infer<typeof MoneyRangeSchema>;

/** 时间区间。`time_range` 类型的字段用它。不比较先后 —— 那是 N-xx */
export const TimeRangeSchema = z.object({
  start: TimeStringSchema,
  end: TimeStringSchema,
});
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/**
 * 用户自报状态。
 *
 * 规范 4.3 的硬要求：护照、签证、保险、驾照的客户输入保存为 user_reported，
 * **不直接写成 verified=true**。把「谁说的」编进类型而不是靠调用方自觉：
 * 一个裸 enum 在下游看起来和核验结论毫无区别，而误当结论用的后果是
 * 「系统告诉用户签证没问题」。
 */
export const UserReportedSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    user_reported: value,
    /** 用户自报时的日期，供后台判断这条自报是否已经过期 */
    reported_on: DateStringSchema.optional(),
  });

// ── 01 旅行轮廓：trip ───────────────────────────────────────

export const DESTINATION_STATUS_VALUES = ['CONFIRMED', 'SHORTLISTED', 'UNDECIDED'] as const;
export const DestinationStatusSchema = z.enum(DESTINATION_STATUS_VALUES);
export type DestinationStatus = (typeof DESTINATION_STATUS_VALUES)[number];

export const DATE_FLEXIBILITY_VALUES = [
  'FIXED',
  'PLUS_MINUS_1',
  'PLUS_MINUS_3',
  'WHOLE_WEEK',
  'MONTH_ONLY',
] as const;
export const DateFlexibilitySchema = z.enum(DATE_FLEXIBILITY_VALUES);
export type DateFlexibility = (typeof DATE_FLEXIBILITY_VALUES)[number];

/** 已有订单的类型。比 P8 的 `EXISTING_BOOKING_VALUES`（3 个）多了餐厅与接送 */
export const LOCKED_ORDER_TYPE_VALUES = [
  'INTERCITY_TRANSPORT',
  'LODGING',
  'TICKETS',
  'RESTAURANT',
  'TRANSFER',
] as const;
export const LockedOrderTypeSchema = z.enum(LOCKED_ORDER_TYPE_VALUES);
export type LockedOrderType = (typeof LOCKED_ORDER_TYPE_VALUES)[number];

/**
 * 可改退状态。
 *
 * `NON_REFUNDABLE` 是派生 LOCKED 约束的触发条件（规范 4 章的注 + 附录 B 的
 * D-06）；`UNKNOWN` **按不可改退处理**（规范 7 的「不可改退默认视为最高约束」），
 * 但仍与 `NON_REFUNDABLE` 分开存 —— 后台核实之后要能区分「确认不可退」与
 * 「用户不清楚」，合并成一个值就再也问不出来了。
 */
export const CHANGEABILITY_VALUES = ['CHANGEABLE', 'NON_REFUNDABLE', 'UNKNOWN'] as const;
export const ChangeabilitySchema = z.enum(CHANGEABILITY_VALUES);
export type Changeability = (typeof CHANGEABILITY_VALUES)[number];

/** 一个地点。`country` 单独存是因为跨境判定读它，而从 text 里再解析一次会分叉 */
export const PlannerPlaceSchema = z.object({
  text: NonEmptyStringSchema.max(200),
  place_id: NonEmptyStringSchema.max(100).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
});
export type PlannerPlace = z.infer<typeof PlannerPlaceSchema>;

export const LockedOrderSchema = z.object({
  type: LockedOrderTypeSchema,
  name: NonEmptyStringSchema.max(200),
  /** 自由文本而不是结构化日期时间：用户手上的凭证形态各异（「10/05 10:00 起飞」） */
  datetime_text: z.string().max(100),
  place_text: z.string().max(200),
  /** 订单号可选。字段表明确「不默认采集敏感支付信息」 */
  reference: z.string().max(100).optional(),
  changeability: ChangeabilitySchema,
});
export type LockedOrder = z.infer<typeof LockedOrderSchema>;

export const PlannerTripSchema = z.object({
  /** PV2-01-001 */
  origin: PlannerPlaceSchema.optional(),
  /** PV2-01-002 */
  destination_status: DestinationStatusSchema.optional(),
  /** PV2-01-003。1～5 个；顺序即用户的排序（可拖拽） */
  destinations: z.array(PlannerPlaceSchema).max(5).optional(),
  /** PV2-01-004 */
  dates: z.object({ start_date: DateStringSchema, end_date: DateStringSchema }).optional(),
  /** PV2-01-005 */
  date_flexibility: DateFlexibilitySchema.optional(),
  /** PV2-01-008。空数组 = 「暂无」；不设 NONE 成员，理由同 P8 的 existing_bookings */
  locked_order_types: z.array(LockedOrderTypeSchema).optional(),
  /** PV2-01-009 */
  locked_orders: z.array(LockedOrderSchema).max(20).optional(),
});

// ── 01 旅行轮廓 / 09 确认旅程：profile ──────────────────────

export const TRIP_PURPOSE_VALUES = [
  'LEISURE',
  'HONEYMOON',
  'FAMILY',
  'FOOD',
  'PHOTOGRAPHY',
  'SHOPPING',
  'SKI',
  'SHOW_SPORTS',
  'BLEISURE',
  'VISIT_RELATIVES',
  'OTHER',
] as const;
export const TripPurposeSchema = z.enum(TRIP_PURPOSE_VALUES);
export type TripPurpose = (typeof TRIP_PURPOSE_VALUES)[number];

export const TOP_GOAL_VALUES = [
  'EAT_WELL',
  'STAY_WELL',
  'LESS_HASSLE',
  'DEEP_EXPERIENCE',
  'PHOTOS',
  'FAMILY_FUN',
  'SHOPPING',
  'VALUE_FOR_MONEY',
  'FREE_TIME',
  'OTHER',
] as const;
export const TopGoalSchema = z.enum(TOP_GOAL_VALUES);
export type TopGoal = (typeof TOP_GOAL_VALUES)[number];

export const PlannerProfileMetaSchema = z.object({
  /** PV2-01-006。上限 5 而不是字段表的「最多建议 4 项」——「建议」由前端提示，不由契约拒 */
  trip_purposes: multiSelectWithOther(TripPurposeSchema, 5).optional(),
  /**
   * PV2-01-007。**数组顺序即排名**，第 1 项权重最高。
   *
   * 不加 `rank` 字段：两处表达同一个顺序必然出现 `[{goal:A,rank:2},{goal:B,rank:1}]`
   * 这种数组序与 rank 不一致的值，而那时哪个才是权威说不清。
   */
  top_goals: multiSelectWithOther(TopGoalSchema, 3).optional(),
  /** PV2-09-004。500 字是字段表的口径，与 5.1 的自由文本上限一致 */
  additional_notes: z.string().max(500).optional(),
});

// ── 02 同行伙伴：travelers ──────────────────────────────────

export const TRAVELER_RELATION_VALUES = [
  'SELF',
  'PARTNER',
  'FRIEND',
  'CHILD',
  'PARENT',
  'OTHER',
] as const;
export const TravelerRelationSchema = z.enum(TRAVELER_RELATION_VALUES);
export type TravelerRelation = (typeof TRAVELER_RELATION_VALUES)[number];

export const AGE_BAND_VALUES = ['INFANT', 'CHILD', 'TEEN', 'ADULT', 'SENIOR'] as const;
export const AgeBandSchema = z.enum(AGE_BAND_VALUES);
export type AgeBand = (typeof AGE_BAND_VALUES)[number];

export const MINOR_GUARDIANSHIP_VALUES = [
  'BOTH_PARENTS',
  'SINGLE_PARENT',
  'NON_PARENT_GUARDIAN',
  'UNACCOMPANIED',
] as const;
export const MinorGuardianshipSchema = z.enum(MINOR_GUARDIANSHIP_VALUES);
export type MinorGuardianship = (typeof MINOR_GUARDIANSHIP_VALUES)[number];

/**
 * 行动能力。
 *
 * 字段表的「不得仅根据年龄自动填写」是这个字段存在的全部理由 ——
 * 它与 `age_band` 正交，一个 70 岁的人可以是 `NORMAL`。
 */
export const MOBILITY_LEVEL_VALUES = [
  'NORMAL',
  'LESS_WALKING',
  'NO_LONG_STANDING',
  'AVOID_STAIRS',
  'FREQUENT_REST',
] as const;
export const MobilityLevelSchema = z.enum(MOBILITY_LEVEL_VALUES);
export type MobilityLevel = (typeof MOBILITY_LEVEL_VALUES)[number];

export const CHILD_NEED_VALUES = [
  'STROLLER_ACCESS',
  'CAR_SEAT',
  'FIXED_NAP',
  'KIDS_MEAL',
  'FAMILY_ROOM',
  'OTHER',
] as const;
export const ChildNeedSchema = z.enum(CHILD_NEED_VALUES);
export type ChildNeed = (typeof CHILD_NEED_VALUES)[number];

export const GROUPING_NEED_VALUES = [
  'SEPARATE_ROOMS',
  'SEPARATE_CARS',
  'SPLIT_ACTIVITIES',
  'ALWAYS_TOGETHER',
] as const;
export const GroupingNeedSchema = z.enum(GROUPING_NEED_VALUES);
export type GroupingNeed = (typeof GROUPING_NEED_VALUES)[number];

export const TravelerProfileSchema = z.object({
  relation: TravelerRelationSchema,
  age_band: AgeBandSchema,
  /** 儿童建议填具体年龄（票价与规则按岁数分档）。0～120 是结构性范围 */
  age: z.number().int().min(0).max(120).optional(),
  relation_other: z.string().max(50).optional(),
});
export type TravelerProfile = z.infer<typeof TravelerProfileSchema>;

export const PlannerTravelersSchema = z.object({
  /** PV2-02-001 */
  count: z.number().int().min(1).max(20).optional(),
  /** PV2-02-002。与 count 一致由 N-xx 校验，不在 schema 里 —— 它要能报出具体差多少 */
  profiles: z.array(TravelerProfileSchema).max(20).optional(),
  /** PV2-02-003 */
  minor_guardianship: MinorGuardianshipSchema.optional(),
  /** PV2-02-004 */
  mobility_level: MobilityLevelSchema.optional(),
  /** PV2-02-005 */
  child_needs: multiSelectWithOther(ChildNeedSchema, 6).optional(),
  /** PV2-02-006 */
  grouping_needs: z.array(GroupingNeedSchema).max(4).optional(),
});

// ── 03 预算取舍：budget ─────────────────────────────────────

export const BUDGET_MODE_VALUES = ['TOTAL', 'PER_PERSON', 'TIER', 'UNKNOWN'] as const;
export const BudgetModeSchema = z.enum(BUDGET_MODE_VALUES);
export type BudgetMode = (typeof BUDGET_MODE_VALUES)[number];

/**
 * 旅行档次。
 *
 * 与 P8 的 `BUDGET_TIER_VALUES` 刻意不同：那里有 `STANDARD` 与 `CUSTOM`，
 * 前者是「舒适」的旧译名，后者表示「用户拖了滑块，档次名不含信息」。
 * V2 的档次不再绑定固定金额（字段表：「档次不绑定固定人民币/天；金额由目的地
 * 动态估算」），因此 `CUSTOM` 这一态在 V2 不存在 —— 金额与档次是两个独立字段。
 */
export const TRAVEL_TIER_VALUES = ['ECONOMY', 'COMFORT', 'QUALITY', 'LUXURY'] as const;
export const TravelTierSchema = z.enum(TRAVEL_TIER_VALUES);
export type TravelTier = (typeof TRAVEL_TIER_VALUES)[number];

export const BUDGET_SCOPE_ITEM_VALUES = [
  'INTERCITY_TRANSPORT',
  'ACCOMMODATION',
  'MEALS',
  'LOCAL_TRANSPORT',
  'TICKETS',
  'SHOPPING',
] as const;
export const BudgetScopeItemSchema = z.enum(BUDGET_SCOPE_ITEM_VALUES);
export type BudgetScopeItem = (typeof BUDGET_SCOPE_ITEM_VALUES)[number];

export const PlannerBudgetSchema = z.object({
  /** PV2-03-001 */
  mode: BudgetModeSchema.optional(),
  /** PV2-03-002 */
  currency: CurrencySchema.optional(),
  /** PV2-03-003。口径（总额还是人均）由 `mode` 决定，不在这里重复表达 */
  target_range: MoneyRangeSchema.optional(),
  /** PV2-03-004 */
  travel_tier: TravelTierSchema.optional(),
  /**
   * PV2-03-005 硬上限。
   *
   * 用 `{ enabled, amount? }` 而不是 `amount?: number`：开关关掉时要保留已填数值
   * （规范 6 的「值保留」），而 `undefined` 表达不了「填过但现在不生效」。
   */
  hard_cap: z
    .object({ enabled: z.boolean(), amount: z.number().min(0).optional() })
    .optional(),
  /**
   * PV2-03-006。两部分：预算口径包含哪些项 + 愿意多花在哪。
   *
   * `priorities` 与 `conditions[]` 里的 `budget.*` 码重复，理由见文件头。
   */
  scope_and_priorities: z
    .object({
      included_items: z.array(BudgetScopeItemSchema).max(6),
      priorities: z.array(StanceSelectionSchema).max(20),
    })
    .optional(),
});

// ── 04 旅行节奏：pace / risk ────────────────────────────────

export const WALKING_TOLERANCE_VALUES = [
  'UP_TO_3KM',
  'KM_3_TO_5',
  'KM_5_TO_8',
  'KM_8_TO_12',
  'OVER_12KM',
] as const;
export const WalkingToleranceSchema = z.enum(WALKING_TOLERANCE_VALUES);
export type WalkingTolerance = (typeof WALKING_TOLERANCE_VALUES)[number];

export const CORE_ACTIVITIES_VALUES = ['ONE', 'TWO_TO_THREE', 'FOUR_TO_FIVE', 'AS_MANY', 'SYSTEM'] as const;
export const CoreActivitiesSchema = z.enum(CORE_ACTIVITIES_VALUES);
export type CoreActivities = (typeof CORE_ACTIVITIES_VALUES)[number];

export const FREE_TIME_VALUES = ['NONE', 'ABOUT_1H', 'H2_TO_3', 'HALF_DAY', 'DEPENDS'] as const;
export const FreeTimeSchema = z.enum(FREE_TIME_VALUES);
export type FreeTime = (typeof FREE_TIME_VALUES)[number];

export const HOTEL_CHANGE_TOLERANCE_VALUES = [
  'ZERO',
  'ONE',
  'TWO',
  'THREE_PLUS',
  'FOR_EXPERIENCE',
] as const;
export const HotelChangeToleranceSchema = z.enum(HOTEL_CHANGE_TOLERANCE_VALUES);
export type HotelChangeTolerance = (typeof HOTEL_CHANGE_TOLERANCE_VALUES)[number];

export const RISK_EXCLUSION_VALUES = [
  'RED_EYE_FLIGHT',
  'OVERNIGHT_GROUND',
  'MULTI_TRANSFER',
  'REMOTE_AREA',
  'LAST_MINUTE_CHANGE',
  'HIGH_RISK_ACTIVITY',
  'LONG_QUEUE',
] as const;
export const RiskExclusionSchema = z.enum(RISK_EXCLUSION_VALUES);
export type RiskExclusion = (typeof RISK_EXCLUSION_VALUES)[number];

export const PlannerPaceSchema = z.object({
  /** PV2-04-001。1 躺平 … 5 特种兵。与 P8 的 `pace.intensity` 同量纲 */
  level: z.number().int().min(1).max(5).optional(),
  /** PV2-04-002 */
  daily_window: TimeRangeSchema.optional(),
  /** PV2-04-003 */
  walking_tolerance: WalkingToleranceSchema.optional(),
  /** PV2-04-004 */
  core_activities_per_day: CoreActivitiesSchema.optional(),
  /** PV2-04-005 */
  free_time: FreeTimeSchema.optional(),
  /** PV2-04-006。`enabled` 的理由同 `budget.hard_cap` */
  rest_window: z
    .object({ enabled: z.boolean(), window: TimeRangeSchema.optional() })
    .optional(),
  /** PV2-04-007。规范 10：这是「换几次酒店」，由后台推导路线结构，不要求用户懂术语 */
  hotel_change_tolerance: HotelChangeToleranceSchema.optional(),
});

export const PlannerRiskSchema = z.object({
  /** PV2-04-008。排除标签只有选中/未选中，不循环成偏好（规范 4.2） */
  exclusions: z.array(RiskExclusionSchema).max(7).optional(),
});

// ── 05 路上怎么走：transport ────────────────────────────────

export const TRANSFER_TOLERANCE_VALUES = [
  'DIRECT_ONLY',
  'DIRECT_PREFERRED',
  'MAX_ONE_TRANSFER',
  'MULTI_TRANSFER_OK',
] as const;
export const TransferToleranceSchema = z.enum(TRANSFER_TOLERANCE_VALUES);
export type TransferTolerance = (typeof TRANSFER_TOLERANCE_VALUES)[number];

export const CABIN_CLASS_VALUES = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const;
export const CabinClassSchema = z.enum(CABIN_CLASS_VALUES);
export type CabinClass = (typeof CABIN_CLASS_VALUES)[number];

export const SEAT_PREFERENCE_VALUES = ['WINDOW', 'AISLE', 'TOGETHER'] as const;
export const SeatPreferenceSchema = z.enum(SEAT_PREFERENCE_VALUES);
export type SeatPreference = (typeof SEAT_PREFERENCE_VALUES)[number];

export const DEPARTURE_WINDOW_VALUES = ['EARLY_MORNING', 'MORNING', 'AFTERNOON', 'EVENING'] as const;
export const DepartureWindowSchema = z.enum(DEPARTURE_WINDOW_VALUES);
export type DepartureWindow = (typeof DEPARTURE_WINDOW_VALUES)[number];

export const DRIVING_EXPERIENCE_VALUES = ['UNDER_1Y', 'Y1_TO_3', 'OVER_3Y'] as const;
export const DrivingExperienceSchema = z.enum(DRIVING_EXPERIENCE_VALUES);
export type DrivingExperience = (typeof DRIVING_EXPERIENCE_VALUES)[number];

/** 驾照状态。**不收驾照号码**（规范 20），只收足以判断合法性的条件 */
export const LICENSE_STATUS_VALUES = ['VALID_LICENSE', 'HAS_IDP', 'NEEDS_CHECK'] as const;
export const LicenseStatusSchema = z.enum(LICENSE_STATUS_VALUES);
export type LicenseStatus = (typeof LICENSE_STATUS_VALUES)[number];

export const CAR_TYPE_VALUES = ['SEDAN', 'SUV', 'VAN_7', 'WITH_CHILD_SEAT'] as const;
export const CarTypeSchema = z.enum(CAR_TYPE_VALUES);
export type CarType = (typeof CAR_TYPE_VALUES)[number];

export const LARGE_LUGGAGE_VALUES = ['NONE', 'STROLLER', 'CAMERA_GEAR', 'SPORTS_GEAR', 'OTHER'] as const;
export const LargeLuggageSchema = z.enum(LARGE_LUGGAGE_VALUES);
export type LargeLuggage = (typeof LARGE_LUGGAGE_VALUES)[number];

export const PlannerTransportSchema = z.object({
  /** PV2-05-001 */
  intercity_modes: z.array(StanceSelectionSchema).max(10).optional(),
  /** PV2-05-002 */
  flight_constraints: z
    .object({
      transfer_tolerance: TransferToleranceSchema.optional(),
      avoid_red_eye: z.boolean().optional(),
    })
    .optional(),
  /** PV2-05-003 */
  flight_comfort: z
    .object({
      cabin: CabinClassSchema.optional(),
      seats: z.array(SeatPreferenceSchema).max(3).optional(),
    })
    .optional(),
  /** PV2-05-004 */
  time_preferences: z
    .object({
      windows: z.array(DepartureWindowSchema).max(4).optional(),
      avoid_late_night_arrival: z.boolean().optional(),
    })
    .optional(),
  /** PV2-05-005 */
  local_modes: z.array(StanceSelectionSchema).max(10).optional(),
  /**
   * PV2-05-006 自驾。
   *
   * 整块包在 `UserReportedSchema` 里：规范 4.3 要求驾驶资格保存为 user_reported
   * 并等待 `driving_eligibility.status` 核验。不包的话下游拿到的是一个看起来
   * 已经确认的资格声明。
   */
  self_drive: UserReportedSchema(
    z.object({
      driver_age: z.number().int().min(0).max(120).optional(),
      experience: DrivingExperienceSchema.optional(),
      license_status: LicenseStatusSchema.optional(),
      car_type: CarTypeSchema.optional(),
    }),
  ).optional(),
  /** PV2-05-007 */
  luggage_profile: z
    .object({
      carry_on: z.number().int().min(0).max(20).optional(),
      checked: z.number().int().min(0).max(20).optional(),
      large_items: z.array(LargeLuggageSchema).max(5).optional(),
      large_items_other: z.string().max(100).optional(),
    })
    .optional(),
});

// ── 06 住得更舒服：lodging ──────────────────────────────────

export const BED_TYPE_VALUES = [
  'DOUBLE',
  'TWIN',
  'EXTRA_BED',
  'CONNECTING',
  'FAMILY',
  'SEPARATE',
] as const;
export const BedTypeSchema = z.enum(BED_TYPE_VALUES);
export type BedType = (typeof BED_TYPE_VALUES)[number];

export const LOCATION_PRIORITY_VALUES = [
  'TRANSIT_CONVENIENT',
  'WALK_TO_SIGHTS',
  'QUIET',
  'NIGHTLIFE',
  'SHOPPING',
  'SEA_OR_NATURE',
  'HOTEL_ITSELF',
] as const;
export const LocationPrioritySchema = z.enum(LOCATION_PRIORITY_VALUES);
export type LocationPriority = (typeof LOCATION_PRIORITY_VALUES)[number];

export const HOTEL_CLASS_VALUES = ['ANY', 'THREE_PLUS', 'FOUR_PLUS', 'FIVE'] as const;
export const HotelClassSchema = z.enum(HOTEL_CLASS_VALUES);
export type HotelClass = (typeof HOTEL_CLASS_VALUES)[number];

export const SLEEP_CHECKIN_NEED_VALUES = [
  'VERY_QUIET',
  'HIGH_FLOOR',
  'NON_SMOKING',
  'LATE_CHECK_IN',
  'EARLY_CHECK_IN',
  'LATE_CHECK_OUT',
] as const;
export const SleepCheckinNeedSchema = z.enum(SLEEP_CHECKIN_NEED_VALUES);
export type SleepCheckinNeed = (typeof SLEEP_CHECKIN_NEED_VALUES)[number];

export const RoomConfigSchema = z.object({
  /** 第几间房。1 起 */
  room_index: z.number().int().min(1).max(10),
  bed_type: BedTypeSchema,
  /** 该房间容纳的人数。规范 12 要求界面实时提示「尚有 N 人未分配」，算它需要这个数 */
  capacity: z.number().int().min(1).max(6),
});
export type RoomConfig = z.infer<typeof RoomConfigSchema>;

export const PlannerLodgingSchema = z.object({
  /** PV2-06-001 */
  types: z.array(StanceSelectionSchema).max(10).optional(),
  /** PV2-06-002 */
  rooms_count: z.number().int().min(1).max(10).optional(),
  /** PV2-06-003 */
  room_configuration: z.array(RoomConfigSchema).max(10).optional(),
  /** PV2-06-004。币种继承 `budget.currency`，不在这里重复一份 */
  nightly_budget: MoneyRangeSchema.optional(),
  /** PV2-06-005。数组顺序即 Top 3 排名，理由同 `profile.top_goals` */
  location_priorities: z.array(LocationPrioritySchema).max(3).optional(),
  /** PV2-06-006 */
  class_and_brand: z
    .object({
      hotel_class: HotelClassSchema.optional(),
      brands: z.array(z.string().max(50)).max(5).optional(),
    })
    .optional(),
  /** PV2-06-007 */
  amenities: z.array(StanceSelectionSchema).max(20).optional(),
  /** PV2-06-008 */
  sleep_checkin_needs: z
    .object({
      needs: z.array(SleepCheckinNeedSchema).max(6),
      /** 晚到入住的预计到店时间。超过前台时间时必须进 VERIFY（字段表校验规则） */
      arrival_time: TimeStringSchema.optional(),
    })
    .optional(),
});

// ── 07 吃好也玩好：food / interests / shopping ──────────────

export const FOOD_EXPERIENCE_VALUES = [
  'LOCAL_SPECIALTY',
  'FINE_DINING',
  'STREET_FOOD',
  'MARKET',
  'CAFE_DESSERT',
  'BAR_IZAKAYA',
  'CHINESE',
  'JAPANESE',
  'WESTERN',
] as const;
export const FoodExperienceSchema = z.enum(FOOD_EXPERIENCE_VALUES);
export type FoodExperience = (typeof FOOD_EXPERIENCE_VALUES)[number];

/**
 * 饮食方式。
 *
 * 规范 4.2 明确：宗教与饮食要求**不得使用三态循环**。因此这是普通多选而不是
 * `StanceSelection` —— 「偏好清真」不是一个有意义的表达。
 */
export const DIETARY_REQUIREMENT_VALUES = [
  'VEGETARIAN',
  'VEGAN',
  'HALAL',
  'KOSHER',
  'NO_SPICY',
  'NO_ALCOHOL',
  'OTHER',
] as const;
export const DietaryRequirementSchema = z.enum(DIETARY_REQUIREMENT_VALUES);
export type DietaryRequirement = (typeof DIETARY_REQUIREMENT_VALUES)[number];

export const TRISTATE_ANSWER_VALUES = ['NO', 'YES', 'UNSURE'] as const;
export const TristateAnswerSchema = z.enum(TRISTATE_ANSWER_VALUES);
export type TristateAnswer = (typeof TRISTATE_ANSWER_VALUES)[number];

/** 过敏严重程度。`ANAPHYLAXIS` 触发 VERIFY-BLOCKING 与人工/供应商确认 */
export const ALLERGY_SEVERITY_VALUES = ['MILD', 'MODERATE', 'SEVERE', 'ANAPHYLAXIS'] as const;
export const AllergySeveritySchema = z.enum(ALLERGY_SEVERITY_VALUES);
export type AllergySeverity = (typeof ALLERGY_SEVERITY_VALUES)[number];

export const DINING_BUDGET_VALUES = ['MOSTLY_CASUAL', 'MODERATE', 'QUALITY_FIRST'] as const;
export const DiningBudgetSchema = z.enum(DINING_BUDGET_VALUES);
export type DiningBudget = (typeof DINING_BUDGET_VALUES)[number];

export const QUEUE_ATTITUDE_VALUES = ['WILL_BOOK_AHEAD', 'WILL_QUEUE', 'AVOID_QUEUE'] as const;
export const QueueAttitudeSchema = z.enum(QUEUE_ATTITUDE_VALUES);
export type QueueAttitude = (typeof QUEUE_ATTITUDE_VALUES)[number];

export const AllergyDetailSchema = z.object({
  /** 过敏原名称。自由文本 —— 枚举不可能覆盖，而漏掉一个的后果是安全事故 */
  allergen: NonEmptyStringSchema.max(50),
  severity: AllergySeveritySchema,
  avoid_cross_contamination: z.boolean(),
});
export type AllergyDetail = z.infer<typeof AllergyDetailSchema>;

export const PlannerFoodSchema = z.object({
  /** PV2-07-001 */
  experience_tags: z.array(FoodExperienceSchema).max(9).optional(),
  /** PV2-07-002。「无」= 空数组，理由同 locked_order_types */
  dietary_requirements: multiSelectWithOther(DietaryRequirementSchema, 7).optional(),
  /** PV2-07-003。事实入口，不使用三态标签（规范 13） */
  has_allergies: TristateAnswerSchema.optional(),
  /** PV2-07-004 */
  allergy_details: z
    .object({
      allergens: z.array(AllergyDetailSchema).max(20),
      carries_emergency_medication: z.boolean().optional(),
    })
    .optional(),
  /** PV2-07-005 */
  dining_style: z
    .object({
      budget_level: DiningBudgetSchema.optional(),
      queue_attitude: z.array(QueueAttitudeSchema).max(3).optional(),
    })
    .optional(),
});

export const MustDoItemSchema = z.object({
  text: NonEmptyStringSchema.max(200),
  place_id: NonEmptyStringSchema.max(100).optional(),
  /** 该项只能在某天完成时填。冲突检测读它（规范 18.1） */
  date_constraint: DateStringSchema.optional(),
});
export type MustDoItem = z.infer<typeof MustDoItemSchema>;

export const PlannerInterestsSchema = z.object({
  /** PV2-07-006。值是条件码，理由同 StanceSelectionSchema.code */
  tags: z.array(ConditionCodeSchema).max(30).optional(),
  /** PV2-07-007。必须是 `tags` 的子集（由 N-xx 校验）；数组顺序即排名 */
  top3: z.array(ConditionCodeSchema).max(3).optional(),
  /** PV2-07-008 */
  must_do: z.array(MustDoItemSchema).max(20).optional(),
  /**
   * PV2-07-009。
   *
   * 两个列表而不是一个带 stance 的列表：字段表把它标成 `PREFER/EXCLUDE`，
   * 而「想去但可放弃」与「明确不要」在生成时是两种完全不同的约束 ——
   * 合成一个列表就得靠一个 stance 字段区分，而那正是规范 4.2 反对的
   * 「用三态表达非主观取舍」。
   */
  wish_and_exclude: z
    .object({
      wish: z.array(z.string().max(200)).max(20),
      exclude: z.array(z.string().max(200)).max(20),
    })
    .optional(),
});

export const PlannerShoppingSchema = z.object({
  /** PV2-07-010 */
  intent: z
    .object({
      enabled: z.boolean(),
      brands_or_categories: z.array(z.string().max(50)).max(20).optional(),
      budget: z.number().min(0).optional(),
      wants_tax_refund: z.boolean().optional(),
    })
    .optional(),
});

// ── 08 特别关照：special / documents / insurance / safety ───

export const HEALTH_NEED_VALUES = [
  'WHEELCHAIR_OR_WALKER',
  'HEARING_VISION_AID',
  'PREGNANCY',
  'CHRONIC_CONDITION',
  'NO_LONG_STANDING',
  'MEDICAL_DEVICE',
  'OTHER',
] as const;
export const HealthNeedSchema = z.enum(HEALTH_NEED_VALUES);
export type HealthNeed = (typeof HEALTH_NEED_VALUES)[number];

export const HIGH_RISK_ACTIVITY_VALUES = [
  'HIGH_ALTITUDE',
  'SCUBA_DIVING',
  'SKIING',
  'MOUNTAINEERING',
  'EXTREME_SPORTS',
] as const;
export const HighRiskActivitySchema = z.enum(HIGH_RISK_ACTIVITY_VALUES);
export type HighRiskActivity = (typeof HIGH_RISK_ACTIVITY_VALUES)[number];

export const PASSPORT_STATUS_VALUES = ['VALID', 'APPLYING', 'RENEWING'] as const;
export const PassportStatusSchema = z.enum(PASSPORT_STATUS_VALUES);
export type PassportStatus = (typeof PASSPORT_STATUS_VALUES)[number];

export const VISA_STATUS_VALUES = [
  'HELD',
  'NOT_APPLIED',
  'IN_PROGRESS',
  'UNSURE',
  'MAYBE_EXEMPT',
] as const;
export const VisaStatusSchema = z.enum(VISA_STATUS_VALUES);
export type VisaStatus = (typeof VISA_STATUS_VALUES)[number];

export const INSURANCE_STATUS_VALUES = ['HELD', 'NONE', 'WILL_BUY', 'UNSURE'] as const;
export const InsuranceStatusSchema = z.enum(INSURANCE_STATUS_VALUES);
export type InsuranceStatus = (typeof INSURANCE_STATUS_VALUES)[number];

export const SAFETY_CONTEXT_VALUES = [
  'SOLO_TRAVEL',
  'SOLO_FEMALE',
  'HEAVY_NIGHTLIFE',
  'LATE_NIGHT_ARRIVAL',
  'REMOTE_AREA',
] as const;
export const SafetyContextSchema = z.enum(SAFETY_CONTEXT_VALUES);
export type SafetyContext = (typeof SAFETY_CONTEXT_VALUES)[number];

export const WorkConstraintSchema = z.object({
  /** 自由文本时段。目的地时区由 `trip` 推导，不在每条记录里重复 */
  when_text: NonEmptyStringSchema.max(100),
  requirement_text: z.string().max(200).optional(),
});
export type WorkConstraint = z.infer<typeof WorkConstraintSchema>;

export const PlannerSpecialSchema = z.object({
  /** PV2-08-001。首层只问是否存在，不要求诊断（规范 14） */
  has_health_or_accessibility_needs: TristateAnswerSchema.optional(),
  /** PV2-08-002。只采功能性需求，不设医学诊断输入框 */
  health_accessibility_needs: multiSelectWithOther(HealthNeedSchema, 7).optional(),
  /** PV2-08-003。空数组 = 「无」 */
  high_risk_activities: z.array(HighRiskActivitySchema).max(5).optional(),
  /** PV2-08-004。**不问药名**（字段表：「不在此处要求药名」） */
  medication_status: UserReportedSchema(TristateAnswerSchema).optional(),
  /** PV2-08-010 */
  work_constraints: z
    .object({ enabled: z.boolean(), items: z.array(WorkConstraintSchema).max(10) })
    .optional(),
});

export const PlannerDocumentsSchema = z.object({
  /** PV2-08-005。**只收国家**，不收身份证/居留证号码（字段表 + 规范 20） */
  nationality_residency: z
    .object({
      nationality: z.string().max(100).optional(),
      residency: z.string().max(100).optional(),
    })
    .optional(),
  /** PV2-08-006。只收到期日与状态，不收护照号码 */
  passport_status: UserReportedSchema(
    z.object({
      status: PassportStatusSchema.optional(),
      expiry_date: DateStringSchema.optional(),
    }),
  ).optional(),
  /** PV2-08-007。用户自报不视为最终结论（规范 4.3） */
  visa_status: UserReportedSchema(
    z.object({
      status: VisaStatusSchema.optional(),
      valid_until: DateStringSchema.optional(),
    }),
  ).optional(),
});

export const PlannerInsuranceSchema = z.object({
  /** PV2-08-008 */
  status: UserReportedSchema(InsuranceStatusSchema).optional(),
});

export const PlannerSafetySchema = z.object({
  /** PV2-08-009。空数组 = 「无」；不询问不必要的身份细节 */
  contexts: z.array(SafetyContextSchema).max(5).optional(),
});

// ── 09 确认旅程：review / service / privacy ─────────────────

export const NOTIFICATION_MODE_VALUES = [
  'REALTIME',
  'DAILY_MORNING',
  'DAILY_EVENING',
  'IMPORTANT_ONLY',
] as const;
export const NotificationModeSchema = z.enum(NOTIFICATION_MODE_VALUES);
export type NotificationMode = (typeof NOTIFICATION_MODE_VALUES)[number];

/** 提醒渠道。**只列产品实际支持的**（字段表：不展示未实现渠道） */
export const NOTIFICATION_CHANNEL_VALUES = ['IN_APP', 'EMAIL'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNEL_VALUES);
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export const MONITORING_TOPIC_VALUES = [
  'WEATHER',
  'FLIGHT_OR_TRAIN',
  'ATTRACTION_CLOSURE',
  'TRANSIT_DISRUPTION',
  'SAFETY_ALERT',
  'BOOKING_CONFIRMATION',
] as const;
export const MonitoringTopicSchema = z.enum(MONITORING_TOPIC_VALUES);
export type MonitoringTopic = (typeof MONITORING_TOPIC_VALUES)[number];

export const PlannerReviewSchema = z.object({
  /**
   * PV2-09-001。用户在第 9 步逐组确认过的快照。
   *
   * 只存「确认了哪几组」而不是把五组内容再抄一份：内容是前八步字段的派生值，
   * 抄一份就会有两个版本，而用户改了上游字段之后这份抄本不会自动更新 ——
   * 表现是「确认页显示的与实际发出的不一致」。
   */
  constraints_snapshot: z
    .object({
      acknowledged_groups: z.array(z.string().max(32)).max(8),
      acknowledged_at: z.string().max(40).optional(),
    })
    .optional(),
  /** PV2-09-002。已在第 9 步就地补答的阻塞项 field_id */
  blocking_answers: z
    .object({ resolved_field_ids: z.array(z.string().max(20)).max(76) })
    .optional(),
});

export const PlannerServiceSchema = z.object({
  /** PV2-09-003 */
  notification_preferences: z
    .object({
      mode: NotificationModeSchema.optional(),
      channels: z.array(NotificationChannelSchema).max(2).optional(),
    })
    .optional(),
  /** PV2-10-006 */
  monitoring_topics: z.array(MonitoringTopicSchema).max(6).optional(),
});

export const PlannerPrivacySchema = z.object({
  /** PV2-09-005。**不预勾选**；不同意则不能处理需敏感数据的功能（规范 15） */
  trip_processing_consent: z.boolean().optional(),
  /** PV2-09-006。与本次服务授权分开，默认不预勾选 */
  save_preferences: z.boolean().optional(),
});

// ── 10 行前准备中心：pretrip ────────────────────────────────

export const ESIM_SUPPORT_VALUES = ['SUPPORTED', 'NOT_SUPPORTED', 'UNSURE'] as const;
export const EsimSupportSchema = z.enum(ESIM_SUPPORT_VALUES);
export type EsimSupport = (typeof ESIM_SUPPORT_VALUES)[number];

export const CONNECTIVITY_PREFERENCE_VALUES = ['ESIM', 'ROAMING', 'PHYSICAL_SIM', 'WIFI'] as const;
export const ConnectivityPreferenceSchema = z.enum(CONNECTIVITY_PREFERENCE_VALUES);
export type ConnectivityPreference = (typeof CONNECTIVITY_PREFERENCE_VALUES)[number];

/** 支付方式。**不采集卡号/CVV/密码**（字段表 + 规范 20） */
export const PAYMENT_METHOD_VALUES = [
  'VISA',
  'MASTERCARD',
  'AMEX',
  'APPLE_PAY',
  'GOOGLE_PAY',
  'CASH',
  'OTHER',
] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHOD_VALUES);
export type PaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];

export const LOYALTY_KIND_VALUES = ['AIRLINE', 'HOTEL', 'CAR_RENTAL', 'CREDIT_CARD'] as const;
export const LoyaltyKindSchema = z.enum(LOYALTY_KIND_VALUES);
export type LoyaltyKind = (typeof LOYALTY_KIND_VALUES)[number];

export const LOCATION_SHARING_VALUES = ['NEVER', 'EMERGENCY_ONLY', 'DURING_TRIP'] as const;
export const LocationSharingSchema = z.enum(LOCATION_SHARING_VALUES);
export type LocationSharing = (typeof LOCATION_SHARING_VALUES)[number];

export const LoyaltyProgramSchema = z.object({
  kind: LoyaltyKindSchema,
  brand: NonEmptyStringSchema.max(50),
  /** 等级名。**不收会员号与密码**（字段表：「编号原则上非必要不收」） */
  tier: z.string().max(50).optional(),
});
export type LoyaltyProgram = z.infer<typeof LoyaltyProgramSchema>;

export const PlannerPretripSchema = z.object({
  /** PV2-10-001 */
  connectivity: z
    .object({
      esim: EsimSupportSchema.optional(),
      preferences: z.array(ConnectivityPreferenceSchema).max(4).optional(),
    })
    .optional(),
  /** PV2-10-002 */
  payment_methods: multiSelectWithOther(PaymentMethodSchema, 7).optional(),
  /** PV2-10-003 */
  loyalty_programs: z.array(LoyaltyProgramSchema).max(20).optional(),
  /**
   * PV2-10-004 紧急联系人。
   *
   * 位置共享是**独立授权**（字段表：「位置共享独立授权」），因此
   * `location_sharing` 与联系人信息并列而不是嵌在里面 —— 嵌套会让「填了联系人」
   * 看起来自动同意了位置共享。
   */
  emergency_contact: z
    .object({
      name: z.string().max(50).optional(),
      relation: z.string().max(50).optional(),
      contact: z.string().max(100).optional(),
      location_sharing: LocationSharingSchema.optional(),
    })
    .optional(),
  /**
   * PV2-10-005。
   *
   * 只存已上传文件的引用（对象键或导入批次 ID），不在契约里携带文件内容。
   * 上传后端不在 P9 范围内（见实施计划的「明确不在本轮范围」），
   * 因此这里现在恒为空数组 —— 结构先立起来，避免将来接上传时改契约。
   */
  imported_documents: z.array(z.string().max(200)).max(50).optional(),
});

// ── 顶层块 ──────────────────────────────────────────────────

/**
 * 76 字段问卷答案。
 *
 * 每个子块都可缺省，块内每个字段也都可缺省 —— 用户可以在任何一步中途离开，
 * 而草稿必须能提交（规范 18 允许 `research-needed` 状态下生成）。
 * 「哪些字段在什么条件下必填」由 Field/Step/Trip 状态机与 N-xx 判定，
 * **不由 schema 判定**：schema 拒绝只能给出 `REQ_SCHEMA_INVALID`，
 * 而那个码定位不到任何表单项（见 travel-request.ts 头部）。
 *
 * 子块名与 api_key 第一段逐字相同。19 个子块对应字段表里出现的 19 个前缀。
 */
export const PlannerProfileSchema = z.object({
  trip: PlannerTripSchema.optional(),
  profile: PlannerProfileMetaSchema.optional(),
  travelers: PlannerTravelersSchema.optional(),
  budget: PlannerBudgetSchema.optional(),
  pace: PlannerPaceSchema.optional(),
  risk: PlannerRiskSchema.optional(),
  transport: PlannerTransportSchema.optional(),
  lodging: PlannerLodgingSchema.optional(),
  food: PlannerFoodSchema.optional(),
  interests: PlannerInterestsSchema.optional(),
  shopping: PlannerShoppingSchema.optional(),
  special: PlannerSpecialSchema.optional(),
  documents: PlannerDocumentsSchema.optional(),
  insurance: PlannerInsuranceSchema.optional(),
  safety: PlannerSafetySchema.optional(),
  review: PlannerReviewSchema.optional(),
  service: PlannerServiceSchema.optional(),
  privacy: PlannerPrivacySchema.optional(),
  pretrip: PlannerPretripSchema.optional(),
});

export type PlannerProfile = z.infer<typeof PlannerProfileSchema>;
export type PlannerProfileInput = z.input<typeof PlannerProfileSchema>;
