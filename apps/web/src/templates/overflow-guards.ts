/**
 * 溢出守卫标注（TP-1-05，设计稿 17.3）。
 *
 * 17.3 的溢出检测只检查带 `data-overflow-guard` 的元素 —— V1.0 的写法对
 * 全部元素判 `scrollWidth > clientWidth`，会对 inline 元素（clientWidth 恒为 0）
 * 与滚动容器大量误报，一张信息图能报出成百上千个「溢出」。
 *
 * `priority` 决定降级顺序：**从低优先级开始隐藏**。
 * 触及 priority >= 80 时停止隐藏并转为切换宽松版式（17.3 第 4 轮）。
 *
 * ## 为什么在 `templates/` 而不在某个套件里（R-85 P2）
 *
 * 这里的槽位名与优先级是 **17.3 的契约**，不是样式选择。
 * 每套套件复制一份的后果是两套在优先级上漂移 —— 比如一套把
 * `foodCard` 设成 60、另一套设成 70，于是「先隐藏哪个」变成套件相关的，
 * 而 17.3 的行为本应与样式无关。那种漂移不会报错，
 * 只会让两套套件在同一份过长的计划上降级成不同的样子。
 */

export const OVERFLOW_PRIORITY = {
  /** 最高优先，必须完整显示 */
  headerTitle: 100,
  headerSubtitle: 90,
  scheduleItem: 80,
  /** 金额不可截断 */
  budgetTotal: 80,
  foodCard: 60,
  photoSpotCard: 50,
  /** 最先被隐藏 */
  bookingTip: 30,
  transportTip: 30,
} as const;

export type OverflowSlot = keyof typeof OVERFLOW_PRIORITY;

/** 与 17.3 表格中的槽位名一一对应 */
export const OVERFLOW_SLOT_NAME: Record<OverflowSlot, string> = {
  headerTitle: 'header.title',
  headerSubtitle: 'header.subtitle',
  scheduleItem: 'schedule.item',
  budgetTotal: 'budget.total',
  foodCard: 'food.card',
  photoSpotCard: 'photo_spot.card',
  bookingTip: 'booking_tip.item',
  transportTip: 'transport_tip.item',
};

/** 展开到 JSX 属性上：`<div {...guard('headerTitle')}>` */
export function guard(slot: OverflowSlot): {
  'data-overflow-guard': string;
  'data-overflow-priority': number;
} {
  return {
    'data-overflow-guard': OVERFLOW_SLOT_NAME[slot],
    'data-overflow-priority': OVERFLOW_PRIORITY[slot],
  };
}
