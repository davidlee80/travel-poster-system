import { z } from 'zod';
import {
  BookingCategorySchema,
  BudgetBucketSchema,
  ConditionModeSchema,
  CurrencySchema,
  FoodEntityTypeSchema,
  MealSchema,
  PeriodSchema,
  PlanStatusSchema,
  PreferredTimeSchema,
  RouteTypeSchema,
  TransportModeSchema,
  ViolationSeveritySchema,
} from './enums.js';
import {
  DateStringSchema,
  DestinationRefSchema,
  GeoLocationSchema,
  MoneySchema,
  NonEmptyStringSchema,
  TimeStringSchema,
} from './primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * TravelPlan —— 大模型输出的结构化旅行计划（设计稿六章）。
 *
 * ## 关键原则：schema 只做结构与类型校验
 *
 * 取值合理性**不**在这里校验，而由 3.2.1 的业务规则（V-01～V-45）负责。
 * 原因是那些规则的严重级各不相同：
 *
 *   V-08 经纬度越界   → REPAIRABLE，修复为置 null
 *   V-10 景点数超限   → REPAIRABLE，删除末位条目
 *   V-24 金额为负     → REPAIRABLE，置 0
 *   V-01 天数不匹配   → BLOCKING，触发补生成
 *
 * 如果 schema 一律拒绝，全部 REPAIRABLE 都会被升级成 BLOCKING（Schema 校验
 * 失败是阻断项，见十六章 16.3），自动修复机制就完全失效了。因此：
 *
 *   schema 管「字段在不在、类型对不对、枚举值合不合法」
 *   业务规则管「数值合不合理、条目多不多、约束满不满足」
 *
 * 这个分工对应设计稿 3.2 的第 5 步（Schema 校验）与第 6 步（业务规则校验）。
 */

// ── 日程 ────────────────────────────────────────────────────

export const ScheduleItemSchema = z.object({
  period: PeriodSchema,
  start_time: TimeStringSchema,
  end_time: TimeStringSchema,
  title: NonEmptyStringSchema,
  description: z.string(),
  /** 与 start/end 的时间差一致性由 V-07 校验（容差 ±5 分钟） */
  duration_minutes: z.number().int(),
  location: GeoLocationSchema,
  estimated_walking_km: z.number().finite(),
  estimated_cost: MoneySchema,
  /**
   * 是否适合携带儿童（R-20 新增）。
   *
   * 业务规则 V-33 是「`has_child === true` 时每日至少一条 `schedule` **标注**
   * 适合儿童」。V1.2 的 `ScheduleItem` 没有任何这样的标注位，该规则因此
   * 无法按字面实现 —— 只能改为在 `title` / `description` 里嗅探
   * 「亲子」「适合小朋友」之类关键词。那样做的问题不是麻烦，而是**不可靠**：
   * 命中与否取决于模型恰好用了哪个词，而 V-33 是 `ADVISORY`，它的产物
   * （`assumptions`）会直接展示给用户。对一条其实很适合孩子的行程报
   * 「未包含适合儿童的安排」，比不报更糟。
   *
   * 因此增加显式布尔位，由模型在结构化输出里标注。见设计稿修订 R-20。
   */
  child_friendly: z.boolean(),
});
export type ScheduleItem = z.infer<typeof ScheduleItemSchema>;

// ── 美食 ────────────────────────────────────────────────────

export const FoodRecommendationSchema = z.object({
  meal: MealSchema,
  name: NonEmptyStringSchema,
  description: z.string(),
  entity_type: FoodEntityTypeSchema,
});
export type FoodRecommendation = z.infer<typeof FoodRecommendationSchema>;

// ── 推荐路线 ────────────────────────────────────────────────

export const RouteRecommendationSchema = z.object({
  type: RouteTypeSchema,
  title: NonEmptyStringSchema,
  /** 节点数不足 2 时删除该条路线（V-43），不在 schema 层拒绝 */
  nodes: z.array(NonEmptyStringSchema),
});
export type RouteRecommendation = z.infer<typeof RouteRecommendationSchema>;

// ── 拍照机位 ────────────────────────────────────────────────

export const PhotoSpotSchema = z.object({
  name: NonEmptyStringSchema,
  /** 必须能在同日 schedule[].location.name 中找到，否则删除（V-42） */
  entity_name: NonEmptyStringSchema,
  preferred_time: PreferredTimeSchema,
});
export type PhotoSpot = z.infer<typeof PhotoSpotSchema>;

// ── 提示类条目（V1.0 中为空数组，V1.1 补全结构）───────────────

export const TransportTipSchema = z.object({
  text: NonEmptyStringSchema,
  mode: TransportModeSchema,
});
export type TransportTip = z.infer<typeof TransportTipSchema>;

export const TicketReminderSchema = z.object({
  entity_name: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  /** 需提前预约的天数；0 或 null 表示无需提前 */
  advance_days: z.number().int().nullable(),
  price: MoneySchema,
});
export type TicketReminder = z.infer<typeof TicketReminderSchema>;

export const BookingTipSchema = z.object({
  text: NonEmptyStringSchema,
  category: BookingCategorySchema,
});
export type BookingTip = z.infer<typeof BookingTipSchema>;

// ── 预算 ────────────────────────────────────────────────────

/**
 * 语义化预算条目（R-04）。
 *
 * V1.0 的 `daily_budget` 只有四个固定分桶，无法产出 ViewModel 的
 * `budget.items[].label`（例：「运河船票」）。因此新增 `breakdown[]` 作为
 * 语义化条目，四个分桶降级为由它汇总得出的派生值（一致性由 V-20 保证）。
 */
export const BudgetBreakdownItemSchema = z.object({
  label: NonEmptyStringSchema,
  amount: z.number().finite(),
  bucket: BudgetBucketSchema,
});
export type BudgetBreakdownItem = z.infer<typeof BudgetBreakdownItemSchema>;

export const DailyBudgetSchema = z.object({
  ticket: z.number().finite(),
  transport: z.number().finite(),
  meal: z.number().finite(),
  other: z.number().finite(),
  /** 应等于 breakdown 金额之和；不等时由 V-20 修复 */
  total: z.number().finite(),
  currency: CurrencySchema,
  breakdown: z.array(BudgetBreakdownItemSchema),
});
export type DailyBudget = z.infer<typeof DailyBudgetSchema>;

export const TotalBudgetSchema = z.object({
  ticket: z.number().finite(),
  transport: z.number().finite(),
  meal: z.number().finite(),
  accommodation: z.number().finite(),
  other: z.number().finite(),
  total: z.number().finite(),
  per_person: z.number().finite(),
  currency: CurrencySchema,
});
export type TotalBudget = z.infer<typeof TotalBudgetSchema>;

// ── 单日 ────────────────────────────────────────────────────

export const TravelPlanDaySchema = z.object({
  day_number: z.number().int(),
  date: DateStringSchema,
  city: NonEmptyStringSchema,
  theme: NonEmptyStringSchema,
  subtitle: z.string(),
  /**
   * R-04 补充的源字段。V1.0 的 ViewModel 有 `daily_summary` 但 TravelPlan
   * 没有对应源，只能凭空编造或从 theme/subtitle 拼接（后者会产出与页面标题
   * 重复的冗余文案）。因此改为由 LLM 直接生成，≤ 40 字。
   */
  daily_summary: z.string(),

  schedule: z.array(ScheduleItemSchema),
  food_recommendations: z.array(FoodRecommendationSchema),
  route_recommendations: z.array(RouteRecommendationSchema),
  must_do: z.array(NonEmptyStringSchema),
  photo_spots: z.array(PhotoSpotSchema),
  transport_tips: z.array(TransportTipSchema),
  ticket_reminders: z.array(TicketReminderSchema),
  booking_tips: z.array(BookingTipSchema),
  daily_budget: DailyBudgetSchema,
});
export type TravelPlanDay = z.infer<typeof TravelPlanDaySchema>;

// ── 约束报告 ────────────────────────────────────────────────

export const SatisfiedConstraintSchema = z.object({
  code: NonEmptyStringSchema,
  mode: ConditionModeSchema,
  evidence: z.string(),
});
export type SatisfiedConstraint = z.infer<typeof SatisfiedConstraintSchema>;

export const ViolatedConstraintSchema = z.object({
  code: NonEmptyStringSchema,
  mode: ConditionModeSchema,
  reason: z.string(),
  severity: ViolationSeveritySchema,
});
export type ViolatedConstraint = z.infer<typeof ViolatedConstraintSchema>;

export const AssumptionSchema = z.object({
  code: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  /** 产生该假设的规则编号（如 "V-22"）；非规则来源时为 null */
  rule_id: z.string().nullable(),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const ConstraintReportSchema = z.object({
  satisfied: z.array(SatisfiedConstraintSchema),
  violated: z.array(ViolatedConstraintSchema),
  assumptions: z.array(AssumptionSchema),
});
export type ConstraintReport = z.infer<typeof ConstraintReportSchema>;

// ── 完整计划 ────────────────────────────────────────────────

/**
 * 由大模型直接产出的部分。
 *
 * `plan_id` / `plan_version_id` / `request_id` **不在其中** ——
 * 它们由程序注入（设计稿 6.3、1.2「模型不直接写数据库」）。把它们放进
 * 交给模型的 JSON Schema 会诱导模型编造 ID，而编造的 ID 一旦被误信就会
 * 污染归属关系。
 */
export const TravelPlanContentSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.travelPlan),
  status: PlanStatusSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),

  destination: DestinationRefSchema,
  start_date: DateStringSchema,
  end_date: DateStringSchema,
  total_days: z.number().int(),
  traveler_count: z.number().int(),
  currency: CurrencySchema,

  total_budget: TotalBudgetSchema,
  days: z.array(TravelPlanDaySchema),
  constraint_report: ConstraintReportSchema,
});
export type TravelPlanContent = z.infer<typeof TravelPlanContentSchema>;

/** 程序注入的标识符 */
export const PlanIdentitySchema = z.object({
  plan_id: NonEmptyStringSchema,
  plan_version_id: NonEmptyStringSchema,
  request_id: NonEmptyStringSchema,
});
export type PlanIdentity = z.infer<typeof PlanIdentitySchema>;

/** 落库与后续消费使用的完整形态 */
export const TravelPlanSchema = TravelPlanContentSchema.extend(PlanIdentitySchema.shape);
export type TravelPlan = z.infer<typeof TravelPlanSchema>;

/**
 * 交给大模型的结构化输出 schema（设计稿 6.3）。
 *
 * 相对 `TravelPlanContentSchema` 再去掉两项：
 *   - `schema_version` 由程序填充，模型没必要复述一个常量
 *   - `status` 由校验与修复流程决定，模型无从判断自己的输出是 READY 还是 REPAIRED
 */
export const TravelPlanLlmOutputSchema = TravelPlanContentSchema.omit({
  schema_version: true,
  status: true,
});
export type TravelPlanLlmOutput = z.infer<typeof TravelPlanLlmOutputSchema>;
