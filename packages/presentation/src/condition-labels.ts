import { CONDITION_CODE_VALUES, type ConditionCode, type ConditionDomain } from '@tps/schemas';

/**
 * 条件字典的中文标签（设计稿 5.1）。
 *
 * ## 为什么在 presentation 而不是 schemas
 *
 * `@tps/schemas` 是契约层，它约束的是「哪些 code 合法」。标签是**展示**：
 * 同一个 code 在表单里叫「电梯房」、在约束报告里可能要叫「住宿有电梯」，
 * 而 code 本身不会因此改变。把标签放进契约层会让「改个文案」变成
 * 「改契约」，进而牵动所有依赖包的版本。
 *
 * `Record<ConditionCode, …>` 而不是 `Partial`：5.1 新增 code 时漏配标签
 * 会让表单出现一个没有文字的复选框，而那种缺陷在类型上应当是错误。
 */
export const CONDITION_LABEL: Record<ConditionCode, string> = {
  'interest.history_culture': '历史与人文',
  'interest.nature': '自然风光',
  'interest.food': '本地美食',
  'interest.shopping': '购物',
  'interest.art_museum': '艺术与博物馆',
  'interest.nightlife': '夜间活动',
  'interest.photography': '摄影机位',
  'interest.family_kids': '亲子友好',

  'transport.public_transit': '优先公共交通',
  'transport.self_drive': '自驾',
  'transport.walking_first': '优先步行',
  'transport.avoid_transfer': '尽量少换乘',

  'accommodation.elevator': '住宿有电梯',
  'accommodation.near_transit': '住宿靠近地铁或车站',
  'accommodation.private_bath': '独立卫浴',
  'accommodation.family_room': '家庭房',

  'accessibility.wheelchair': '需轮椅通行',
  'accessibility.stroller': '需推车通行',
  'accessibility.low_walking': '步行量要少',

  'diet.vegetarian': '素食',
  'diet.halal': '清真',
  'diet.no_spicy': '不吃辣',
  'diet.allergy_seafood': '海鲜过敏',

  'schedule.no_late_night': '不安排太晚的行程',
};

/** 分域的中文标题，用于表单分组 */
export const CONDITION_DOMAIN_LABEL: Record<ConditionDomain, string> = {
  interest: '兴趣偏好',
  transport: '交通方式',
  accommodation: '住宿要求',
  accessibility: '无障碍需求',
  diet: '饮食限制',
  schedule: '时间安排',
};

/**
 * 默认按「尽量满足」呈现的域。
 *
 * `accessibility` 与 `diet` 默认是**硬约束**：轮椅通行与食物过敏不是偏好，
 * 勾了却被当成「尽量满足」，生成出的计划可能根本无法使用 ——
 * 而用户看不出这个区别（界面上都是一个勾）。
 */
export const MUST_BY_DEFAULT_DOMAINS: readonly ConditionDomain[] = ['accessibility', 'diet'];

/** 供表单遍历：按 5.1 的顺序 */
export const CONDITION_CODES = CONDITION_CODE_VALUES;
