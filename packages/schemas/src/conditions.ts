import { z } from 'zod';
import { ConditionModeSchema } from './enums.js';

/**
 * 条件字典（TP-2-03，设计稿 5.1）。
 *
 * V1 冻结 24 项，`<域>.<项>` 两段式命名。
 *
 * ## 为什么必须是白名单而不是自由字符串
 *
 * 5.1 写得很明确：`code` 不在字典内时返回 `REQ_CONDITION_CODE_UNKNOWN`，
 * **不做静默丢弃**。原因是 `mode: 'MUST'` 的条件是硬约束 —— 静默丢弃一个
 * 拼错的 `accessibility.wheelchar` 会让轮椅需求凭空消失，而生成出的计划
 * 看起来完全正常。用户要到出行当天才会发现。
 *
 * ## 为什么域也要显式建模
 *
 * LLM Prompt 按域分组注入（6.3），素材检索也按域取偏好。只有一个扁平
 * code 列表时，「新增一个域」会变成在多处字符串前缀匹配 —— 而漏改一处
 * 的后果是该域的条件被忽略，同样没有任何报错。
 */

/**
 * 7 个域。新增域必须同时更新 Prompt 模板（5.1 的冻结条款）。
 *
 * ## P8 新增 `budget`，且**确实不需要**改 Prompt（R-55）
 *
 * 冻结条款那句话针对的是「Prompt 里按域写死了段落」的实现。而
 * `packages/llm/src/prompt.ts` 的 `describeConditions` 是对 code 列表的
 * 泛型遍历，分域靠 code 前缀而不是硬编码的小节 —— 已逐行核对。
 *
 * 这一段写在这里而不只写在修订记录里：下一个加域的人会先看这个数组，
 * 而「条款说要改 Prompt，但代码里找不到要改的地方」会让他以为自己漏了什么。
 */
export const CONDITION_DOMAIN_VALUES = [
  'interest',
  'transport',
  'accommodation',
  /**
   * P8：愿意把钱花在哪。与 `interest`（想玩什么）正交 ——
   * 同一个用户可以对美食毫无兴趣，却要求住宿品质。
   */
  'budget',
  'accessibility',
  'diet',
  'schedule',
] as const;
export const ConditionDomainSchema = z.enum(CONDITION_DOMAIN_VALUES);
export type ConditionDomain = (typeof CONDITION_DOMAIN_VALUES)[number];

/**
 * 冻结的条件清单。这是**唯一**的手写清单。
 *
 * 5.1 原为 24 项；P8 扩到 46 项（R-55），让原型界面上的每一个标签都有结构化
 * 落点 —— 落进 `conditions` 的诉求受 V-30 硬约束校验保护，而落进自由文本的
 * 不受。判定过程见 `docs/前端字段清单.md`。
 *
 * 必须是 `as const` 字面量元组而不是从分域表 `flat()` 派生：
 * `Object.values(...).flat()` 的类型是 `string[]`，`ConditionCode` 会退化成
 * `string`，白名单在编译期就失去了全部意义 —— 而这正是本文件要防的事。
 *
 * ## 两条命名约定
 *
 * 1. **正向命名**：否定语义走 `value: false`，不进 code 名。
 *    「不要多人间」= `accommodation.shared_dorm` + `value: false`；
 *    建一个 `no_shared_dorm` 会让「不要它」变成读不懂的双重否定。
 *    四个反向命名的历史例外见 conditions.test.ts 的白名单。
 * 2. **既有 code 一律不改名不删除**：它们已写入 `plan_json` 与
 *    `constraint_report.satisfied`，改名会让存量计划的条件比对静默错位。
 */
export const CONDITION_CODE_VALUES = [
  // interest
  'interest.history_culture',
  'interest.nature',
  'interest.food',
  'interest.shopping',
  'interest.art_museum',
  'interest.nightlife',
  'interest.photography',
  'interest.family_kids',
  // interest（P8 新增）
  'interest.city_walk',
  'interest.cafe',
  'interest.hot_spring',
  'interest.theme_park',
  'interest.zoo_aquarium',
  'interest.light_hiking',
  // transport
  'transport.public_transit',
  'transport.self_drive',
  'transport.walking_first',
  'transport.avoid_transfer',
  // transport（P8 新增）
  'transport.cycling',
  'transport.rail',
  /*
   * transport（P9 新增）：补全 V2 字段表的跨城与当地交通两组三态标签。
   *
   * 跨城 5 项（飞机 / 高铁 / 长途巴士 / 轮渡 / 自驾）里 `rail` 与 `self_drive`
   * 已有；当地 6 项（公共交通 / 步行 / 打车 / 包车 / 骑行 / 自驾）里
   * `public_transit`、`walking_first`、`cycling`、`self_drive` 已有。
   *
   * `flight` 与既有的 `avoid_transfer` 不重复：前者是「用不用飞机」，
   * 后者是「能不能接受转机」。同时表达是合理输入。
   */
  'transport.flight',
  'transport.coach',
  'transport.ferry',
  'transport.ride_hailing',
  'transport.private_car',
  // accommodation
  'accommodation.elevator',
  'accommodation.near_transit',
  'accommodation.private_bath',
  'accommodation.family_room',
  /*
   * accommodation（P8 新增）：住宿类型 5 项 + 设施 3 项 + 稳定性 1 项。
   *
   * 类型与设施同域：用户在原型里是分两组勾的，但对生成来说都是「住哪」的
   * 约束，分成两个域会让 Prompt 多一个只有五项的小节而没有额外信息。
   */
  'accommodation.hotel',
  'accommodation.homestay',
  'accommodation.apartment',
  'accommodation.resort',
  'accommodation.hostel',
  'accommodation.breakfast',
  'accommodation.kitchen',
  'accommodation.shared_dorm',
  'accommodation.single_base',
  /*
   * accommodation（P9 新增）：V2 字段表的设施三态标签有 10 项，
   * P8 只覆盖了电梯 / 独立卫浴 / 早餐 / 厨房 四项。
   */
  'accommodation.laundry',
  'accommodation.bathtub',
  'accommodation.gym',
  'accommodation.pool',
  'accommodation.workspace',
  'accommodation.front_desk_24h',
  // budget（P8 新增域）
  'budget.lodging_quality',
  'budget.unique_experience',
  'budget.transport_convenience',
  /*
   * budget（P9 新增）：字段表的「愿意多花」四项里「直飞」没有对应码。
   *
   * 它与 `transport.flight_constraints`（HARD，只接受直飞/最多 1 次转机）
   * 不同：这里是「愿意为直飞多付钱」的消费取向，那里是硬约束。
   */
  'budget.direct_flight',
  // accessibility
  'accessibility.wheelchair',
  'accessibility.stroller',
  'accessibility.low_walking',
  /*
   * accessibility（P8 新增）。落在这个域而不是新建一个「儿童设施」域：
   * 它与轮椅、推车同类 —— 都是「需要某项设备才能出行」，
   * 且同域意味着它自动继承 MUST_BY_DEFAULT（安全座椅不是偏好）。
   */
  'accessibility.child_car_seat',
  // diet
  'diet.vegetarian',
  'diet.halal',
  'diet.no_spicy',
  'diet.allergy_seafood',
  /*
   * diet（P9 新增）：字段表的饮食方式有 6 项（+「其他」+「无」），
   * P8 覆盖了素食 / 清真 / 不吃辣 三项。
   *
   * `vegan` 与 `vegetarian` 分开而不是用 value 表达程度：纯素排除蛋奶，
   * 而「素食 + value:false」读作「不要素食」—— 命名约定 1 只允许用
   * `value: false` 表达否定，表达不了「更严格的同类要求」。
   */
  'diet.vegan',
  'diet.kosher',
  /*
   * 「不饮酒」写成 `alcohol_free` 而不是 `no_alcohol`：命名约定 1 要求正向命名，
   * 而 `alcohol_free`（无酒精的）本身就是餐厅的一个正向属性，
   * 因此不必像 `diet.no_spicy` 那样进历史例外白名单。
   *
   * 也不写成 `diet.alcohol` + `value: false`：同一组饮食要求里 `no_spicy` 是
   * `value: true`，两个选项一个用 true 一个用 false 会让前端投影逻辑出现
   * 按 code 分支的特例 —— 而漏掉那个特例的表现是「勾了不饮酒，发出去是要酒」。
   */
  'diet.alcohol_free',
  // schedule
  'schedule.no_late_night',
  // schedule（P8 新增）
  'schedule.daily_rest',
] as const;

/**
 * 冻结的条目数。写成常量供测试断言，防止无意增删。
 *
 * 5.1 原为 24；P8 扩到 46（R-55）；P9 扩到 61 —— 为 Planner V2 字段表里
 * 那些没有落点的三态标签选项补码（交通 5 个、住宿设施 6 个、消费重点 1 个、
 * 饮食 3 个）。全部落在既有 7 个域内，因此不触发 5.1 的「新增域必须同时
 * 更新 Prompt 模板」条款。
 *
 * ## 加码之后必须做的第二件事
 *
 * `apps/api` 在有已发布 planner config 时用**配置里的码集合替换**内置白名单
 * （`conflicts.ts` 的 `allowedConditionCodes?.has(code) ?? isKnownConditionCode(code)`
 * 是 `??` 而不是并集）。因此新码必须同时注册进 `planner_config_options`
 * 并发布新版本，否则在装了配置中心的环境里它们会被 N-08 拒 ——
 * 而界面上那个标签看起来完全正常。见 P9 实施计划的「陷阱 1」。
 */
export const CONDITION_CODE_COUNT = 61;

export type ConditionCode = (typeof CONDITION_CODE_VALUES)[number];

/**
 * 运行期允许配置中心发布七个既有域下的新机器码；是否已发布由 API 查询数据库校验。
 * 类型仍保留内置联合，避免全仓库的静态映射失去穷尽检查。
 */
export const ConditionCodeSchema = z
  .string()
  .regex(
    /^(?:interest|transport|accommodation|budget|accessibility|diet|schedule)\.[a-z][a-z0-9_]{1,63}$/,
  )
  .transform((value) => value as ConditionCode);

/**
 * 域 → 该域的全部 code，由扁平清单按前缀分组派生。
 *
 * 派生而不是再手写一遍：两份清单必然漂移，而漂移的表现是
 * 「某个 code 通过了校验但没进 Prompt」—— 条件静默失效，无任何报错。
 */
export const CONDITION_CODES_BY_DOMAIN: Record<ConditionDomain, readonly ConditionCode[]> = (() => {
  const grouped = Object.fromEntries(
    CONDITION_DOMAIN_VALUES.map((domain) => [domain, [] as ConditionCode[]]),
  ) as Record<ConditionDomain, ConditionCode[]>;

  for (const code of CONDITION_CODE_VALUES) {
    const domain = code.slice(0, code.indexOf('.')) as ConditionDomain;
    /*
     * 前缀不在域集合里 → 直接抛错，不静默丢弃。
     *
     * 静默丢弃的后果正是本文件开头说的那件事：条件通过了 schema 校验
     * 却没进 Prompt。宁可在模块加载时就崩，那时错误指向的是这份清单本身。
     */
    if (!(domain in grouped)) {
      throw new Error(`条件 code ${code} 的域前缀 "${domain}" 不在 CONDITION_DOMAIN_VALUES 中`);
    }
    grouped[domain].push(code);
  }

  return grouped;
})();

/**
 * 单条条件。
 *
 * `value` 在 V1 全部是 `boolean`（5.1 六个域的 value 类型都是 boolean）。
 * 将来若有非布尔域，这里要改成按 domain 的可辨识联合 —— 不要用
 * `unknown` 兜住，那会让「值类型写错」变成运行期问题。
 */
export const TravelConditionSchema = z.object({
  code: ConditionCodeSchema,
  mode: ConditionModeSchema,
  value: z.boolean(),
});
export type TravelCondition = z.infer<typeof TravelConditionSchema>;

/** 取 code 的域。code 已由 schema 保证合法，因此前缀一定在域集合内 */
export function conditionDomain(code: ConditionCode): ConditionDomain {
  const domain = code.slice(0, code.indexOf('.'));
  return domain as ConditionDomain;
}

/** 判断任意字符串是否为字典内的 code。N-08 用它给出精确错误 */
export function isKnownConditionCode(code: string): code is ConditionCode {
  return (CONDITION_CODE_VALUES as readonly string[]).includes(code);
}
