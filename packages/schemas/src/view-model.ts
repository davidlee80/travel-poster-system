import { z } from 'zod';
import {
  AssetSourceTypeSchema,
  PageTypeSchema,
  RouteTypeSchema,
  TemplateIdSchema,
} from './enums.js';
import { NonEmptyStringSchema } from './primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * TravelPosterViewModel —— React 信息图模板真正消费的数据（设计稿十二章）。
 *
 * ## 与 TravelPlan 的关键区别：这里可以严格
 *
 * TravelPlan 是**模型输出**，schema 必须宽松以便业务规则分级修复。
 * ViewModel 是**我们自己的代码产出**，它的每一处不一致都是程序缺陷而不是
 * 数据问题，因此这里的约束越严越好 —— 让缺陷在编排阶段就暴露，而不是
 * 变成页面上的空白或 `NaN`。
 *
 * 具体体现：
 *   - `icons` 必须含全部 8 个模块图标键，缺一个就是校验失败
 *   - `*_compact` 与原文成对存在
 *   - 全部展示文案已是最终中文，模板不做任何再加工
 */

// ── 图标 ────────────────────────────────────────────────────

/**
 * 模块图标键（设计稿 9.1、12.2）。
 *
 * V1.0 的 `icons` 只列了 6 个且含清单中不存在的 `route`，同时漏掉了清单里的
 * `budget` / `tips`。这里是对齐后的 8 个。
 *
 * 时段图标与交通图标**不在** `icons` 里 —— 它们按条目变化，由
 * `schedule[].period_icon` 与 `transport_tips[].icon` 按名引用（12.2）。
 */
export const MODULE_ICON_KEYS = [
  'schedule',
  'food',
  'map',
  'route',
  'camera',
  'ticket',
  'budget',
  'tips',
] as const;
export type ModuleIconKey = (typeof MODULE_ICON_KEYS)[number];

/**
 * 用 `z.object` 逐键声明而不是 `z.record`：
 * `z.record` 允许缺键，无法表达「8 个键必须齐全」，也无法给出
 * `Record<ModuleIconKey, string>` 这种可供编译期穷尽检查的类型。
 */
export const ModuleIconsSchema = z.object({
  schedule: NonEmptyStringSchema,
  food: NonEmptyStringSchema,
  map: NonEmptyStringSchema,
  route: NonEmptyStringSchema,
  camera: NonEmptyStringSchema,
  ticket: NonEmptyStringSchema,
  budget: NonEmptyStringSchema,
  tips: NonEmptyStringSchema,
});
export type ModuleIcons = z.infer<typeof ModuleIconsSchema>;

// ── 图片引用 ────────────────────────────────────────────────

export const ViewImageSchema = z.object({
  asset_id: NonEmptyStringSchema,
  url: NonEmptyStringSchema,
  /**
   * AI 生成的**景点类**代表图在此显示「示意图」（设计稿二十章、12.1）。
   * Hero 氛围图不标注 —— 它表达的是主题而非具体地点。
   */
  source_note: z.string().nullable(),
});
export type ViewImage = z.infer<typeof ViewImageSchema>;

export const HeroAssetSchema = z.object({
  asset_id: NonEmptyStringSchema,
  url: NonEmptyStringSchema,
  source_type: AssetSourceTypeSchema,
});
export type HeroAsset = z.infer<typeof HeroAssetSchema>;

// ── 各模块 ──────────────────────────────────────────────────

export const ViewHeaderSchema = z.object({
  destination: NonEmptyStringSchema,
  total_days: z.number().int().positive(),
  /** `DAY 3`，不补零（12.1） */
  day_label: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  title_compact: NonEmptyStringSchema,
  subtitle: z.string(),
  subtitle_compact: z.string(),
  /** 解析失败且降级链也用尽时为 null，模板改用渐变背景（十八章） */
  hero_asset: HeroAssetSchema.nullable(),
});
export type ViewHeader = z.infer<typeof ViewHeaderSchema>;

export const ViewScheduleItemSchema = z.object({
  /** 已是中文（「上午」），模板不做映射 */
  period: NonEmptyStringSchema,
  /** `period-morning` 形式，对应 9.1 的时段图标 */
  period_icon: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  description: z.string(),
  description_compact: z.string(),
  /** 「建议 2～3 小时」（12.1 时长文案规则） */
  duration_text: NonEmptyStringSchema,
});
export type ViewScheduleItem = z.infer<typeof ViewScheduleItemSchema>;

export const ViewFoodCardSchema = z.object({
  /** 「早餐」 */
  meal: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: z.string(),
  description_compact: z.string(),
  image: ViewImageSchema.nullable(),
});
export type ViewFoodCard = z.infer<typeof ViewFoodCardSchema>;

/**
 * 路线地图。
 *
 * `svg_url` 为 null 时模板渲染 `nodes` 文字列表 —— 对应 8.2 的
 * `text_fallback`（十八章「路线地图 → 简化 SVG → 纯文字路线」）。
 * 因此 `nodes` **始终**必填，不能只在降级时提供。
 */
export const ViewRouteMapSchema = z.object({
  svg_url: NonEmptyStringSchema.nullable(),
  nodes: z.array(NonEmptyStringSchema),
});
export type ViewRouteMap = z.infer<typeof ViewRouteMapSchema>;

export const ViewRouteRecommendationSchema = z.object({
  type: RouteTypeSchema,
  /** 「轻松休闲版路线」（12.1 映射） */
  label: NonEmptyStringSchema,
  nodes: z.array(NonEmptyStringSchema),
});
export type ViewRouteRecommendation = z.infer<typeof ViewRouteRecommendationSchema>;

export const ViewTransportTipSchema = z.object({
  text: NonEmptyStringSchema,
  /** `transport-boat` 形式，对应 9.1 的交通图标 */
  icon: NonEmptyStringSchema,
});
export type ViewTransportTip = z.infer<typeof ViewTransportTipSchema>;

export const ViewPhotoSpotSchema = z.object({
  name: NonEmptyStringSchema,
  /** 「建议上午」 */
  time_text: NonEmptyStringSchema,
  image: ViewImageSchema.nullable(),
});
export type ViewPhotoSpot = z.infer<typeof ViewPhotoSpotSchema>;

export const ViewTicketReminderSchema = z.object({
  entity_name: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  /** 「免费」或「¥60」 */
  price_text: NonEmptyStringSchema,
  /** 「需提前 1 天」；无需提前时为 null，模板隐藏该行（12.1） */
  advance_text: z.string().nullable(),
});
export type ViewTicketReminder = z.infer<typeof ViewTicketReminderSchema>;

export const ViewBudgetItemSchema = z.object({
  label: NonEmptyStringSchema,
  /** 「¥0」/「约 ¥10」（12.1 金额文案规则） */
  amount_text: NonEmptyStringSchema,
});
export type ViewBudgetItem = z.infer<typeof ViewBudgetItemSchema>;

export const ViewBudgetSchema = z.object({
  items: z.array(ViewBudgetItemSchema),
  /** 「约 ¥105 / 人」 */
  total_text: NonEmptyStringSchema,
});
export type ViewBudget = z.infer<typeof ViewBudgetSchema>;

export const ViewBookingTipSchema = z.object({
  text: NonEmptyStringSchema,
  /** 「餐厅」 */
  category_text: NonEmptyStringSchema,
});
export type ViewBookingTip = z.infer<typeof ViewBookingTipSchema>;

// ── 完整 ViewModel ──────────────────────────────────────────

export const TravelPosterViewModelSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSIONS.travelPosterViewModel),
    template_id: TemplateIdSchema,
    page_type: PageTypeSchema,
    plan_id: NonEmptyStringSchema,
    plan_version_id: NonEmptyStringSchema,
    /** `DAILY_POSTER` 时必填；`FULL_PLAN` 时必须为 null（3.3.1） */
    day_number: z.number().int().positive().nullable(),

    header: ViewHeaderSchema,
    schedule: z.array(ViewScheduleItemSchema),
    food_cards: z.array(ViewFoodCardSchema),
    route_map: ViewRouteMapSchema,
    route_recommendations: z.array(ViewRouteRecommendationSchema),
    must_do: z.array(NonEmptyStringSchema),
    transport_tips: z.array(ViewTransportTipSchema),
    photo_spots: z.array(ViewPhotoSpotSchema),
    ticket_reminders: z.array(ViewTicketReminderSchema),
    budget: ViewBudgetSchema,
    booking_tips: z.array(ViewBookingTipSchema),
    daily_summary: z.string(),
    daily_summary_compact: z.string(),

    icons: ModuleIconsSchema,
  })
  // 3.3.1：page_type 与 day_number 的绑定关系。
  // 数据库层也有同名约束（plan_presentations_day_number_check），两处一致。
  .refine(
    (vm) =>
      (vm.page_type === 'DAILY_POSTER' && vm.day_number !== null) ||
      (vm.page_type === 'FULL_PLAN' && vm.day_number === null),
    {
      message: 'DAILY_POSTER 必须有 day_number，FULL_PLAN 必须为 null（设计稿 3.3.1）',
      path: ['day_number'],
    },
  )
  // 12.1：预算数字对不上是用户可见的严重错误，不允许静默展示。
  // 这里只能校验 items 与 total_text 的存在性一致；金额求和的断言需要原始
  // 数值，由编排阶段在生成 ViewModel 前完成（buildBudget 会做）。
  .refine((vm) => vm.budget.items.length > 0 || vm.budget.total_text.length > 0, {
    message: '预算模块不得为空壳（设计稿 12.1）',
    path: ['budget'],
  });

export type TravelPosterViewModel = z.infer<typeof TravelPosterViewModelSchema>;

/**
 * 完整计划页的 ViewModel（3.3.1 的 `FULL_PLAN`）。
 *
 * ## 为什么它需要自己的 schema
 *
 * `FULL_PLAN` 落库的不是 `TravelPosterViewModel` 而是「概览 + 各日 ViewModel
 * 的集合」（见 @tps/presentation 的 `buildFullPlan`）。在 P5 之前它只有一个
 * TypeScript interface —— 于是 13.4 的 `/presentations/full` 响应**无法被校验**：
 * 服务端存进去什么、客户端就得信什么。
 *
 * 而客户端恰恰不能信：落库的 ViewModel 是**历史数据**，模板契约改版后库里
 * 还留着旧结构。没有 schema 的话，那种不匹配会在渲染中途抛
 * `undefined is not an object`，整页白屏，而离根因已经很远。
 *
 * 定义在 schemas 而不是 presentation：13.4 的响应契约属于 API 层，
 * 而 presentation 是它的一个消费方（另一个是前端）。
 */
export const FullPlanViewModelSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.travelPosterViewModel),
  template_id: TemplateIdSchema,
  page_type: z.literal('FULL_PLAN'),
  plan_id: NonEmptyStringSchema,
  plan_version_id: NonEmptyStringSchema,
  /** FULL_PLAN 恒为 null（3.3.1，数据库同名约束） */
  day_number: z.null(),

  overview: z.object({
    title: NonEmptyStringSchema,
    summary: z.string(),
    destination: NonEmptyStringSchema,
    total_days: z.number().int().positive(),
    date_range_text: z.string(),
    traveler_text: z.string(),
    total_budget_text: z.string(),
    per_person_text: z.string(),
  }),

  /**
   * 各日 ViewModel，按 `day_number` 升序。
   *
   * 不校验「升序」与「天数与 overview.total_days 一致」：那两条由编排阶段
   * 保证（`buildFullPlan` 按顺序构造），而在读路径上把它们做成硬失败会让
   * 一份内容完好、只是某天缺失的历史计划完全无法显示 ——
   * 而用户要的是看他的行程。
   */
  days: z.array(TravelPosterViewModelSchema),

  icons: ModuleIconsSchema,
});

export type FullPlanViewModelShape = z.infer<typeof FullPlanViewModelSchema>;
