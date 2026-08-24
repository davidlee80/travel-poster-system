import { z } from 'zod';

import {
  BudgetBasisSchema,
  BudgetIncludedItemSchema,
  BudgetTierSchema,
  CurrencySchema,
  DestinationModeSchema,
  ExistingBookingSchema,
  LocaleSchema,
  PaceLevelSchema,
  TemplateIdSchema,
  type BudgetIncludedItem,
} from './enums.js';
import { TravelConditionSchema } from './conditions.js';
import { PlannerConstraintTypeSchema } from './planner-fields.js';
import { PlannerProfileSchema } from './planner-profile.js';
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
  /**
   * P8：可缺省。V1 只有 `FIXED` 一个合法值，因此默认即正确 ——
   * 让每个前端模板都显式传一个常量，只是把样板搬到客户端。
   */
  mode: DestinationModeSchema.default('FIXED'),
  text: NonEmptyStringSchema.max(200),
  place_id: NonEmptyStringSchema.max(100).optional(),
  /** P8：可缺省，默认 false。N-10 仍拒绝 `true`（V1 不支持多目的地） */
  allow_multiple_destinations: z.boolean().default(false),
});

export const TripDatesSchema = z.object({
  start_date: DateStringSchema,
  end_date: DateStringSchema,
  /**
   * V1 只支持 0（N-09）。这里**不写 `z.literal(0)`** —— 那会让非 0 值
   * 返回 `REQ_SCHEMA_INVALID` 而不是 `REQ_DATE_FLEXIBILITY_UNSUPPORTED`，
   * 后者才能告诉用户「弹性日期暂不支持」。
   *
   * P8：可缺省，默认 0。默认值与 N-09 唯一接受的值一致，因此漏传等于合法；
   * 而显式传非 0 仍然走 N-09 的精确错误码。
   */
  flexibility_days: z.number().int().min(0).default(0),
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
  /** P8：可缺省，默认空数组 —— 「没带小孩」是绝大多数请求的情形 */
  children: z.array(TravelerChildSchema).max(10).default([]),
  seniors: z.array(TravelerSeniorSchema).max(10).default([]),
});

/**
 * 预算默认覆盖的开支项（P8）。
 *
 * 不含 `INTERCITY_TRANSPORT`：往返大交通常常已经自行订好（原型的「已有订单」
 * 就有这一项），把它算进默认集会让同一个 min/max 显得更紧，从而无谓地收窄行程。
 *
 * ## 这个字段今天是惰性数据
 *
 * 已核实：`normalize.ts` 只把它透传进 `NormalizedBudget`，Prompt 没有渲染它，
 * 也没有任何 V-xx / N-xx 规则读它。也就是说模型目前并不知道预算覆盖了哪些开支，
 * 而 min/max 的含义恰恰取决于此。这是 P8 之前就存在的缺口，不在本轮范围 ——
 * 记在这里是为了让下一个动预算的人知道它还没接上。
 */
export const DEFAULT_BUDGET_ITEMS: readonly BudgetIncludedItem[] = [
  'ACCOMMODATION',
  'MEALS',
  'LOCAL_TRANSPORT',
  'TICKETS',
];

export const RequestBudgetSchema = z.object({
  /** P8：可缺省。V1 只有 CNY */
  currency: CurrencySchema.default('CNY'),
  /**
   * **不可缺省。** 它决定 min/max 是「人均每天」还是「全程总额」——
   * 猜错让预算偏差约（人数 × 天数）≈ 20 倍，且 N-12 的 50 元/人/天 下限
   * 也是按它折算的。这是 P8 里唯一一个「机器填充但仍必填」的字段。
   */
  basis: BudgetBasisSchema,
  // 不在 schema 里比较 min/max，也不要求 > 0 —— 那是 N-04
  min: z.number().min(0),
  max: z.number().min(0),
  /**
   * P8：预算档位。**纯 optional 而不是带默认值** ——
   * 「没选档位」与「档位是经济」不是一回事，给它默认值会让前者无法表达，
   * 而模型会据此调整选点取向。
   */
  tier: BudgetTierSchema.optional(),
  /**
   * P8：可缺省，默认 `DEFAULT_BUDGET_ITEMS`。
   *
   * `.min(1)` 保留：`.default()` 只在键缺省时生效，因此「不传」合法而
   * 「显式传 `[]`」仍被拒 —— 后者让 min/max 失去意义，不是用户会有意
   * 表达的诉求。
   *
   * 默认值写成**函数**而不是直接给常量：Zod 4 的 `.default()` 短路返回，
   * 不复制也不解析，因此给常量会让每次解析拿到**同一个数组引用** ——
   * 任何下游的就地修改都会污染 `DEFAULT_BUDGET_ITEMS` 本身。
   */
  included_items: z
    .array(BudgetIncludedItemSchema)
    .min(1)
    .default(() => [...DEFAULT_BUDGET_ITEMS]),
});

/**
 * 节奏偏好。四个数值字段与 `level` 全部可选。
 *
 * 5.1：`level` 与数值字段冲突时**以数值字段为准**，`level` 仅在数值缺省时
 * 提供默认值。因此这里不能要求两者互斥 —— 同时提供是合法输入。
 */
export const RequestPaceSchema = z.object({
  level: PaceLevelSchema.optional(),
  /**
   * P8：原型滑块的五档强度（1 躺平 … 5 特种兵）。
   *
   * 与 `level` 并存而不是取代它：`level` 只有三档，5→3 会把「躺平」与
   * 「慢游」压成同一个 `RELAXED`。5.1 已经规定「数值字段与 level 冲突时
   * 以数值为准」，因此这一项与其余四个数值字段同构。
   *
   * 越界值**不截断**：一个被悄悄改成 5 的 6 会让用户拿到与他所选不同的
   * 节奏，而界面上看不出任何异常。
   */
  intensity: z.number().int().min(1).max(5).optional(),
  attractions_per_day_min: z.number().int().min(0).optional(),
  attractions_per_day_max: z.number().int().min(0).optional(),
  walking_limit_km: z.number().min(0).optional(),
  earliest_departure_time: TimeStringSchema.optional(),
});

export const CustomRequirementsSchema = z.object({
  /**
   * 5.1 的上限是 500 字，**超长截断并记入 assumptions**，不是拒绝。
   * 所以 schema 这里给一个宽松的硬上限防止滥用，真正的 500 字截断在标准化里做。
   *
   * P8：可缺省，默认空串 —— 「没有额外要求」是常态，而下游读的是
   * `custom_text`（已截断的字符串），空串与不填是同一件事。
   */
  raw_text: z.string().max(5_000).default(''),
});

/**
 * 输出偏好。P8 起四个字段全部可缺省 —— 它们都是前端代码里的常量而不是
 * 用户填的表单项，让每个模板显式传一遍只是搬运样板。
 */
export const OutputPreferencesSchema = z.object({
  language: LocaleSchema.default('zh-CN'),
  /**
   * 模板 ID 用枚举而不是自由字符串：N-11 要求「在已注册模板列表中」，
   * 而这个列表就是编译期已知的 TEMPLATE_ID_VALUES。
   * 未知模板因此返回 REQ_SCHEMA_INVALID —— 这是可接受的，
   * 因为模板 ID 不是用户填的表单项，而是前端代码里的常量，
   * 出错属于客户端 bug 而不是用户输入错误。
   */
  template_id: TemplateIdSchema.default('travel_infographic_v1'),
  /*
   * 两个都默认 true：13.5 的导出是用户点了才发起的独立请求，这两个开关只是
   * 声明「这份计划打算导出成什么」。默认 false 会让一个最小请求生成出的计划
   * 无法导出，而那不是「少填了一个可选项」应有的后果。
   */
  generate_png: z.boolean().default(true),
  generate_pdf: z.boolean().default(true),
});

/**
 * 前端请求模型。
 *
 * ## 必填集只有 11 个字段（P8）
 *
 * `schema_version`、`client_request_id`、`timezone`、`trip.origin.text`、
 * `trip.destination.text`、`trip.dates.start_date`、`trip.dates.end_date`、
 * `travelers.adults`、`budget.basis`、`budget.min`、`budget.max`。
 *
 * 其余全部由 schema 填默认值 —— 前端呈现层可以整体替换，而替换者只需凑出
 * 这 11 项。逐字段的判定过程与理由见 `docs/前端字段清单.md`。
 *
 * 四个「机器填充却仍必填」的字段各有具体理由（版本判别、幂等键、时区影响
 * N-01 判断「今天」、basis 决定 min/max 的量级），同一份文档里逐条列了。
 *
 * 这次放宽**向后兼容**：照旧发全量字段的客户端一行不改，因此
 * `travel_request_ui_v1` 不升版本号。
 */
export const TravelRequestUISchema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.travelRequestUi),
  client_request_id: NonEmptyStringSchema.max(100),
  /** P8：可缺省。V1 只有 zh-CN */
  locale: LocaleSchema.default('zh-CN'),
  /** IANA 时区名。N-01 用它判断「今天」，因此**不能**缺省 */
  timezone: NonEmptyStringSchema.max(64),

  trip: z.object({
    origin: PlaceRefSchema,
    destination: TripDestinationSchema,
    dates: TripDatesSchema,
    /**
     * P8：已经自行订好的部分。空数组 = 尚无预订。
     *
     * 默认值写成函数，理由同 `included_items`：Zod 4 的 `.default()` 短路
     * 返回同一个引用。
     */
    existing_bookings: z.array(ExistingBookingSchema).default(() => []),
  }),

  travelers: TravelersSchema,
  budget: RequestBudgetSchema,
  /**
   * P8：可缺省。内部字段本来就全可选，标准化阶段按 level 补默认值。
   *
   * ## 对象级默认值一律用 `.prefault()` 而不是 `.default()`
   *
   * Zod 4 的 `.default()` **短路**：输入为 undefined 时直接返回默认值，
   * 不再走内部 schema 的解析。因此 `OutputPreferencesSchema.default({})`
   * 会产出 `{}` —— 而 `z.infer` 声称那里有四个必填字段。也就是说
   * `.default()` 在对象上能造出**不满足自身推断类型**的值，而 TypeScript
   * 完全看不见。
   *
   * `.prefault()` 会把默认值送进内部 schema 解析，内层的 `.default()`
   * 因此正常生效。标量与数组的默认值本身已是完整合法值，用 `.default()` 即可。
   */
  pace: RequestPaceSchema.prefault({}),
  /*
   * 上限取字典大小而不是字面量：两者本来就该相等（一个 code 勾一次），
   * 写死数字会在下一次扩字典时静默变成「最多只能勾前 N 个」，
   * 而超出的表现是 REQ_SCHEMA_INVALID —— 定位不到任何表单项。
   *
   * 这里**不**去重：重复 code 的处理属于 N-08 的职责，它能给出带 field
   * 的精确错误，而 schema 层只能给 REQ_SCHEMA_INVALID。
   */
  // 配置中心可发布新标签；200 是单次请求的防滥用上限，不再等于内置字典数量。
  conditions: z.array(TravelConditionSchema).max(200).default([]),
  custom_requirements: CustomRequirementsSchema.prefault({}),
  output_preferences: OutputPreferencesSchema.prefault({}),

  /**
   * P9：Planner V2.1 的 76 字段问卷答案。
   *
   * ## 为什么是一个新块而不是就地扩展上面几块
   *
   * 完整推导见 `planner-profile.ts` 的文件头。一句话：就地扩展会造出
   * 「同一概念两个路径」（`budget.travel_tier` 与 P8 的 `budget.tier` 等四对），
   * 而新块让「76 个字段的载荷路径 === `planner_profile.` + api_key」成为一条
   * 可被测试穷举的规则。
   *
   * ## 为什么是 optional 而不是 prefault({})
   *
   * `prefault({})` 会让**每一个**请求（包括只带 11 个必填字段的最小请求）
   * 都长出一个 19 个空子块的对象，落进 `travel_requests.raw_request` 一路存下去。
   * 而「客户端没发问卷」与「客户端发了但全空」在语义上不同：前者是 P8 及之前的
   * 客户端，后者是 V2 客户端上用户什么都没填。下游要能区分 —— 见 normalize 的
   * 回退逻辑。
   *
   * ## 它不改变必填集
   *
   * 契约的必填集仍是 P8 的 11 个字段，`travel_request_ui_v1` 不升版本
   * （见 versions.ts 的递增规则：可选字段新增不递增）。照旧发全量字段的
   * 客户端一行不改。
   */
  planner_profile: PlannerProfileSchema.optional(),
}).superRefine((request, ctx) => {
  /*
   * 目的地在两处出现，必须一致。
   *
   * ## 为什么两处都要发
   *
   * `travel_requests` 表有 `destination_name VARCHAR(200) NOT NULL` 与
   * `destination_place_id` 两个**提取列**，若干 CHECK 约束依赖它们，
   * 因此 `trip.destination` 是单个地点、不能变成数组。而多城序列必须能表达，
   * 它落在 `planner_profile.trip.destinations`（1～5 个，顺序即行程顺序）。
   *
   * ## 为什么要在契约层断言，而不是取其一
   *
   * 静默取其一有两种走法，两种都很糟：取 `trip.destination` 会让多城行程的
   * 第 2～5 个城市凭空消失，而生成出的计划看起来完全正常；取
   * `destinations[0]` 会让提取列与请求体不一致，于是数据库里那一行的
   * 目的地与用户看到的不是同一个地方。
   *
   * 这是本文件里**唯一**一条跨字段校验。它不违反「schema 只做结构校验」那条
   * 原则：不一致的两处目的地不是「业务上不可行」（那类判断归 N-xx），
   * 而是**客户端构造错误** —— 与模板 ID 写错同类，因此
   * `REQ_SCHEMA_INVALID` 是正确的错误码，而 `path` 指向具体那一处。
   */
  const destinations = request.planner_profile?.trip?.destinations;
  if (destinations === undefined || destinations.length === 0) return;

  const primary = destinations[0];
  if (primary === undefined) return;

  if (primary.text !== request.trip.destination.text) {
    ctx.addIssue({
      code: 'custom',
      path: ['planner_profile', 'trip', 'destinations', 0, 'text'],
      message: `与 trip.destination.text（${request.trip.destination.text}）不一致`,
    });
  }

  /*
   * `place_id` 只在两边都有时比较。
   *
   * 单边有值是合法的：`planner_profile` 的地点可能来自地点服务而
   * `trip.destination` 由前端投影时省略了它（`PlaceRefSchema.place_id` 可缺省）。
   * 要求两边同时有值会把「还没接地点服务」变成一个提交错误。
   */
  const primaryId = primary.place_id;
  const tripId = request.trip.destination.place_id;
  if (primaryId !== undefined && tripId !== undefined && primaryId !== tripId) {
    ctx.addIssue({
      code: 'custom',
      path: ['planner_profile', 'trip', 'destinations', 0, 'place_id'],
      message: `与 trip.destination.place_id（${tripId}）不一致`,
    });
  }
});

/**
 * **消费**用的类型：默认值已填好，全部字段都在。
 *
 * 下游（`normalize.ts` 等）用它 —— 例如 `ui.travelers.children.length`
 * 不需要处理 undefined。
 */
export type TravelRequestUI = z.infer<typeof TravelRequestUISchema>;

/**
 * **构造**用的类型：附加字段可缺省。
 *
 * 前端拼请求体用这个。与 `TravelRequestUI` 刻意分开：混用的表现是前端为了
 * 满足类型而显式传一堆默认值，于是「附加」在客户端侧又变回了必填 ——
 * 那正是 P8 要消除的样板。
 */
export type TravelRequestUIInput = z.input<typeof TravelRequestUISchema>;

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

/**
 * 一条运行时约束（规范 4 章 + 4.1，P9）。
 *
 * ## 为什么不是「又一个 conditions 数组」
 *
 * `must_conditions` / `should_conditions` 的元素只有 `code` + `mode` + `value`
 * 三个字段，而 code 必须在冻结字典里。76 字段里有大量约束**没有对应的 code**：
 * 「花生过敏，严重程度 ANAPHYLAXIS，需避免交叉污染」、「10/06 09:00–11:00
 * 不能移动的会议」、「不要去夜店」。硬塞一个 code 会让 N-08 拒掉整个请求，
 * 而放进自由文本会让一条硬约束降级成一句「补充信息」。
 *
 * 因此这是一份**带类型与来源的自然语言约束清单**：
 *
 *   - `type` 决定它在 Prompt 里落进哪一段（规范 4.1 的优先级分段）；
 *   - `source_field_id` 让生成结果可以指回具体字段（规范 21.2 的可追溯性）；
 *   - `decision_weight` 是 `PLANNER_CONSTRAINT_PRECEDENCE` 里的数字，
 *     取舍时**数字小的不得被数字大的静默覆盖**。
 *
 * `conditions` 并不因此过时：它是**结构化**的那一部分，受 V-30/V-32 的
 * 机器校验保护（比对 code 集合），而这份清单只能靠 Prompt 与人工审阅。
 * 两者的分工是「能结构化的走结构化，剩下的至少别丢」。
 */
export const RuntimeConstraintSchema = z.object({
  /**
   * 稳定标识，形如 `HARD:diet.halal` / `LOCKED:PV2-01-009#0`。
   *
   * 存在的理由是**跨版本比对**：同一份问卷改了一个字段之后重新生成，
   * 要能看出「哪几条约束变了」。用数组下标做标识的话，删掉中间一条
   * 会让其后所有约束看起来都变了。
   */
  constraint_id: NonEmptyStringSchema.max(120),
  type: PlannerConstraintTypeSchema,
  /** 规范 21.2：指回 76 个字段之一。空串不合法 —— 无来源的约束无法追溯 */
  source_field_id: NonEmptyStringSchema.max(20),
  /** 给模型看的一句话。中文，不含 code */
  text: NonEmptyStringSchema.max(300),
  /** `PLANNER_CONSTRAINT_PRECEDENCE` 的值。数字小 = 优先级高 */
  decision_weight: z.number().int().min(0),
});
export type RuntimeConstraint = z.infer<typeof RuntimeConstraintSchema>;

/**
 * 一条待核验项（规范 4.3、17.1）。
 *
 * `status` 只有 `user_reported` 一个取值：本轮不做后台核验（见实施计划的
 * 「明确不在本轮范围」）。留着这个字段而不是省掉它，是因为省掉之后接核验的人
 * 要同时改契约与所有下游 —— 而留着它意味着那时只需追加一个枚举值。
 *
 * **不把它折成布尔 `verified`。** 规范 4.3 的核心是「用户自报永远不等于官方
 * 核验结论」，而一个 `verified: false` 的字段读起来像「核验过了，没通过」。
 */
export const VERIFY_STATUS_VALUES = ['user_reported'] as const;
export const VerifyStatusSchema = z.enum(VERIFY_STATUS_VALUES);

export const VerifyItemSchema = z.object({
  item_id: NonEmptyStringSchema.max(120),
  source_field_id: NonEmptyStringSchema.max(20),
  /** 是否阻塞初步方案（VERIFY-BLOCKING 与 VERIFY-NONBLOCKING 的唯一区别）*/
  blocking: z.boolean(),
  status: VerifyStatusSchema,
  text: NonEmptyStringSchema.max(300),
});
export type VerifyItem = z.infer<typeof VerifyItemSchema>;

/**
 * 弹性日期（P9）。
 *
 * `days` 与 `mode` 都保留：前者是可计算的窗口宽度（下游排期用它），
 * 后者是用户的原始选择。只留 `days` 的话「只定月份」与「前后差 30 天」
 * 变成同一件事 —— 而前者压根还没有具体日期，后者有一个中心日。
 */
export const NormalizedDateFlexibilitySchema = z.object({
  days: z.number().int().min(0),
  mode: z.string().max(32).optional(),
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

  /*
   * ── P9 新增的四个字段。**全部可选。** ──────────────────────
   *
   * `apps/generation-worker/src/generate-plan.ts` 会把库里的
   * `normalized_request` 重新 `safeParse` 一遍。新增**必填**字段会让 P8 及
   * 之前落的行全部解析失败 —— 而那条路径上的注释说这只可能是
   * 「标准化规则改版」，也就是说它会被当成脏数据而不是版本问题。
   *
   * 下游取值一律走 helper（`planCities` 等）而不是直接读字段，
   * 因此存量单目的地行仍然得到一个单元素城市序列，
   * V-04 的集合校验对它退化成原来的等值校验。
   */

  /**
   * 城市序列（P9）。顺序即行程顺序，1～5 个。
   *
   * 缺省时由 `planCities` 退化成 `[{ text: destination_name }]` ——
   * 因此下游不需要区分「单目的地」与「多城市」两条代码路径。
   */
  cities: z.array(PlaceRefSchema).min(1).max(5).optional(),

  /** 弹性日期（P9）。缺省等价于 `{ days: 0 }`，也就是日期固定 */
  date_flexibility: NormalizedDateFlexibilitySchema.optional(),

  /**
   * 运行时约束清单（P9）。
   *
   * 上限 200：一个 76 字段的问卷全部填满大约产出 60～80 条，
   * 200 是防滥用而不是业务上限。
   */
  constraints: z.array(RuntimeConstraintSchema).max(200).optional(),

  /** 待核验清单（P9）。上限与字段总数同阶 */
  verify_items: z.array(VerifyItemSchema).max(76).optional(),
});
export type NormalizedTravelRequest = z.infer<typeof NormalizedTravelRequestSchema>;
