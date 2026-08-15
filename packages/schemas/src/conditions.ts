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

/** 6 个域。新增域必须同时更新 Prompt 模板（5.1 的冻结条款） */
export const CONDITION_DOMAIN_VALUES = [
  'interest',
  'transport',
  'accommodation',
  'accessibility',
  'diet',
  'schedule',
] as const;
export const ConditionDomainSchema = z.enum(CONDITION_DOMAIN_VALUES);
export type ConditionDomain = (typeof CONDITION_DOMAIN_VALUES)[number];

/**
 * 5.1 冻结的 24 项。这是**唯一**的手写清单。
 *
 * 必须是 `as const` 字面量元组而不是从分域表 `flat()` 派生：
 * `Object.values(...).flat()` 的类型是 `string[]`，`ConditionCode` 会退化成
 * `string`，白名单在编译期就失去了全部意义 —— 而这正是本文件要防的事。
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
  // transport
  'transport.public_transit',
  'transport.self_drive',
  'transport.walking_first',
  'transport.avoid_transfer',
  // accommodation
  'accommodation.elevator',
  'accommodation.near_transit',
  'accommodation.private_bath',
  'accommodation.family_room',
  // accessibility
  'accessibility.wheelchair',
  'accessibility.stroller',
  'accessibility.low_walking',
  // diet
  'diet.vegetarian',
  'diet.halal',
  'diet.no_spicy',
  'diet.allergy_seafood',
  // schedule
  'schedule.no_late_night',
] as const;

/** 5.1 冻结的条目数。写成常量供测试断言，防止无意增删 */
export const CONDITION_CODE_COUNT = 24;

export const ConditionCodeSchema = z.enum(CONDITION_CODE_VALUES);
export type ConditionCode = (typeof CONDITION_CODE_VALUES)[number];

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
