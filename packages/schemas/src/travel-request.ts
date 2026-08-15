import { z } from 'zod';

import {
  BudgetBasisSchema,
  BudgetIncludedItemSchema,
  CurrencySchema,
  DestinationModeSchema,
  LocaleSchema,
  PaceLevelSchema,
  TemplateIdSchema,
} from './enums.js';
import { TravelConditionSchema } from './conditions.js';
import { DateStringSchema, NonEmptyStringSchema, TimeStringSchema } from './primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * 前端请求模型与标准化结果（TP-2-03，设计稿五章、3.1.1）。
 *
 * ## 这里的 schema **只做结构校验**
 *
 * 与 `TravelPlan` 同一条原则（见 travel-plan.ts）：日期区间是否合理、
 * 预算是否可行、天数是否越界，全部**不在 schema 里拦**，而是交给
 * 3.1.2 的 N-01～N-12。
 *
 * 理由是错误码的粒度。13.7 要求请求校验类错误必须带 `field`，
 * 「前端可直接高亮出错表单项」。若 schema 就把 `end_date < start_date` 拒了，
 * 客户端拿到的是 `REQ_SCHEMA_INVALID` —— 一个无法定位到具体表单项的码，
 * 用户只能看到「请求格式不正确」。把这些判断留给 N-xx，才能返回
 * `REQ_DATE_RANGE_INVALID` + `field: "trip.dates.end_date"`。
 *
 * schema 负责的是「字段存在、类型正确、枚举合法」——
 * 这些错了确实只能返回 `REQ_SCHEMA_INVALID`，因为连字段都读不出来。
 */

// ── 五章：TravelRequestUI ────────────────────────────────────

export const PlaceRefSchema = z.object({
  text: NonEmptyStringSchema.max(200),
  /** 可缺省：用户手输的地名可能没有对应 place_id，此时按 19.1 归一化文本 */
  place_id: NonEmptyStringSchema.max(100).optional(),
});
export type PlaceRef = z.infer<typeof PlaceRefSchema>;

export const TripDestinationSchema = z.object({
  mode: DestinationModeSchema,
  text: NonEmptyStringSchema.max(200),
  place_id: NonEmptyStringSchema.max(100).optional(),
  allow_multiple_destinations: z.boolean(),
});

export const TripDatesSchema = z.object({
  start_date: DateStringSchema,
  end_date: DateStringSchema,
  /**
   * V1 只支持 0（N-09）。这里**不写 `z.literal(0)`** —— 那会让非 0 值
   * 返回 `REQ_SCHEMA_INVALID` 而不是 `REQ_DATE_FLEXIBILITY_UNSUPPORTED`，
   * 后者才能告诉用户「弹性日期暂不支持」。
   */
  flexibility_days: z.number().int().min(0),
});

export const TravelerChildSchema = z.object({
  // 0～17 是结构性范围：负数或 200 岁不是业务冲突而是明显的脏数据
  age: z.number().int().min(0).max(17),
});

export const TravelerSeniorSchema = z.object({
  age: z.number().int().min(0).max(120).optional(),
});

export const TravelersSchema = z.object({
  adults: z.number().int().min(0).max(20),
  children: z.array(TravelerChildSchema).max(10),
  seniors: z.array(TravelerSeniorSchema).max(10),
});

export const RequestBudgetSchema = z.object({
  currency: CurrencySchema,
  basis: BudgetBasisSchema,
  // 不在 schema 里比较 min/max，也不要求 > 0 —— 那是 N-04
  min: z.number().min(0),
  max: z.number().min(0),
  included_items: z.array(BudgetIncludedItemSchema).min(1),
});

/**
 * 节奏偏好。四个数值字段与 `level` 全部可选。
 *
 * 5.1：`level` 与数值字段冲突时**以数值字段为准**，`level` 仅在数值缺省时
 * 提供默认值。因此这里不能要求两者互斥 —— 同时提供是合法输入。
 */
export const RequestPaceSchema = z.object({
  level: PaceLevelSchema.optional(),
  attractions_per_day_min: z.number().int().min(0).optional(),
  attractions_per_day_max: z.number().int().min(0).optional(),
  walking_limit_km: z.number().min(0).optional(),
  earliest_departure_time: TimeStringSchema.optional(),
});

export const CustomRequirementsSchema = z.object({
  /**
   * 5.1 的上限是 500 字，**超长截断并记入 assumptions**，不是拒绝。
   * 所以 schema 这里给一个宽松的硬上限防止滥用，真正的 500 字截断在标准化里做。
   */
  raw_text: z.string().max(5_000),
});

export const OutputPreferencesSchema = z.object({
  language: LocaleSchema,
  /**
   * 模板 ID 用枚举而不是自由字符串：N-11 要求「在已注册模板列表中」，
   * 而这个列表就是编译期已知的 TEMPLATE_ID_VALUES。
   * 未知模板因此返回 REQ_SCHEMA_INVALID —— 这是可接受的，
   * 因为模板 ID 不是用户填的表单项，而是前端代码里的常量，
   * 出错属于客户端 bug 而不是用户输入错误。
   */
  template_id: TemplateIdSchema,
  generate_png: z.boolean(),
  generate_pdf: z.boolean(),
});

export const TravelRequestUISchema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.travelRequestUi),
  client_request_id: NonEmptyStringSchema.max(100),
  locale: LocaleSchema,
  /** IANA 时区名。N-01 用它判断「今天」，因此不能缺省 */
  timezone: NonEmptyStringSchema.max(64),

  trip: z.object({
    origin: PlaceRefSchema,
    destination: TripDestinationSchema,
    dates: TripDatesSchema,
  }),

  travelers: TravelersSchema,
  budget: RequestBudgetSchema,
  pace: RequestPaceSchema,
  conditions: z.array(TravelConditionSchema).max(24),
  custom_requirements: CustomRequirementsSchema,
  output_preferences: OutputPreferencesSchema,
});
export type TravelRequestUI = z.infer<typeof TravelRequestUISchema>;

// ── 3.1.1：NormalizedTravelRequest ──────────────────────────

/**
 * 解析后的节奏参数。四个字段在标准化后**全部有值** ——
 * 下游（Prompt 构造、V-20 校验）不需要再处理 undefined。
 */
export const ResolvedPaceSchema = z.object({
  level: PaceLevelSchema,
  attractions_per_day_min: z.number().int().min(0),
  attractions_per_day_max: z.number().int().min(0),
  walking_limit_km: z.number().min(0),
  earliest_departure_time: TimeStringSchema,
});
export type ResolvedPace = z.infer<typeof ResolvedPaceSchema>;

export const NormalizedBudgetSchema = z.object({
  currency: CurrencySchema,
  basis: BudgetBasisSchema,
  min: z.number(),
  max: z.number(),
  /** 3.1.1：按 basis 折算后的总额区间，下游只用这两个值 */
  total_min: z.number(),
  total_max: z.number(),
  included_items: z.array(BudgetIncludedItemSchema),
});

export const NormalizedTravelRequestSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.normalizedTravelRequest),
  client_request_id: NonEmptyStringSchema,
  locale: LocaleSchema,
  timezone: NonEmptyStringSchema,

  destination_name: NonEmptyStringSchema,
  destination_place_id: NonEmptyStringSchema.optional(),
  origin_name: NonEmptyStringSchema,
  origin_place_id: NonEmptyStringSchema.optional(),

  start_date: DateStringSchema,
  end_date: DateStringSchema,
  /** 含首尾。可能越界（由 N-03 判定），因此这里不加 1～14 的范围 */
  total_days: z.number().int(),

  traveler_count: z.number().int(),
  has_child: z.boolean(),
  has_senior: z.boolean(),

  budget: NormalizedBudgetSchema,
  pace: ResolvedPaceSchema,

  /** 3.1.1：按 mode 拆分。硬约束与软约束在 Prompt 里的地位完全不同 */
  must_conditions: z.array(TravelConditionSchema),
  should_conditions: z.array(TravelConditionSchema),

  /** 已截断到 500 字（截断事实记入 assumptions） */
  custom_text: z.string(),

  output_preferences: OutputPreferencesSchema,

  /**
   * 标准化过程中做出的假设。
   *
   * 5.1（自由文本截断）与 3.2.4（无历史参考）都要求记录在此。
   * 这不是日志 —— 它随计划一起返回给用户，让「系统替你做了什么决定」可见。
   */
  assumptions: z.array(z.string()),
});
export type NormalizedTravelRequest = z.infer<typeof NormalizedTravelRequestSchema>;
