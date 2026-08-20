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
  // P8 新增（R-55）
  'interest.city_walk': '城市漫步',
  'interest.cafe': '咖啡馆探店',
  'interest.hot_spring': '温泉体验',
  'interest.theme_park': '主题乐园',
  'interest.zoo_aquarium': '动物园与水族馆',
  'interest.light_hiking': '轻量徒步',

  'transport.public_transit': '优先公共交通',
  'transport.self_drive': '自驾',
  'transport.walking_first': '优先步行',
  'transport.avoid_transfer': '尽量少换乘',
  // P8 新增
  'transport.cycling': '单车出行',
  'transport.rail': '铁路出行',

  'accommodation.elevator': '住宿有电梯',
  'accommodation.near_transit': '住宿靠近地铁或车站',
  'accommodation.private_bath': '独立卫浴',
  'accommodation.family_room': '家庭房',
  // P8 新增：类型 5 项
  'accommodation.hotel': '住酒店',
  'accommodation.homestay': '住民宿',
  'accommodation.apartment': '住公寓',
  'accommodation.resort': '住度假村',
  'accommodation.hostel': '住青年旅舍',
  // P8 新增：设施 3 项
  'accommodation.breakfast': '含早餐',
  'accommodation.kitchen': '带厨房',
  'accommodation.shared_dorm': '合住多人间',
  // P8 新增：稳定性 1 项
  'accommodation.single_base': '全程固定一处住宿',

  // P8 新增域：愿意把钱花在哪
  'budget.lodging_quality': '预算侧重住宿品质',
  'budget.unique_experience': '预算侧重特色体验',
  'budget.transport_convenience': '预算侧重交通便利',

  'accessibility.wheelchair': '需轮椅通行',
  'accessibility.stroller': '需推车通行',
  'accessibility.low_walking': '步行量要少',
  // P8 新增
  'accessibility.child_car_seat': '需儿童安全座椅',

  'diet.vegetarian': '素食',
  'diet.halal': '清真',
  'diet.no_spicy': '不吃辣',
  'diet.allergy_seafood': '海鲜过敏',

  'schedule.no_late_night': '不安排太晚的行程',
  // P8 新增
  'schedule.daily_rest': '每日固定午休',
};

/** 分域的中文标题，用于表单分组 */
export const CONDITION_DOMAIN_LABEL: Record<ConditionDomain, string> = {
  interest: '兴趣偏好',
  transport: '交通方式',
  accommodation: '住宿要求',
  /** P8 新增域。措辞是「侧重」而不是「预算」—— 它约束的是花钱倾向，不是金额 */
  budget: '预算侧重',
  accessibility: '无障碍需求',
  diet: '饮食限制',
  schedule: '时间安排',
};

/**
 * 默认按「必须满足」呈现的域。
 *
 * `accessibility` 与 `diet` 默认是**硬约束**：轮椅通行与食物过敏不是偏好，
 * 勾了却被当成「尽量满足」，生成出的计划可能根本无法使用 ——
 * 而用户看不出这个区别（界面上都是一个勾）。
 *
 * P8 新增的 `budget` 域**不**在此列：花钱侧重是偏好而不是约束，
 * 「预算侧重住宿品质」没有一个可判定的满足条件供 V-30 校验。
 * 同一轮新增的 `accessibility.child_car_seat` 落在既有域里，
 * 因此自动继承 MUST —— 安全座椅不是「尽量」。
 */
export const MUST_BY_DEFAULT_DOMAINS: readonly ConditionDomain[] = ['accessibility', 'diet'];

/** 供表单遍历：按 5.1 的顺序 */
export const CONDITION_CODES = CONDITION_CODE_VALUES;
