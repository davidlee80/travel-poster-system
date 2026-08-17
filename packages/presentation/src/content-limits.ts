import { COMPACT_LIMITS } from './compact.js';

/**
 * `content_limits` —— 每页各模块显示多少条内容（设计稿 3.3）。
 *
 * `null` 表示不限制。`FULL_PLAN` 全部为 `null`（3.3.1：完整页不裁剪内容）。
 */
export interface ContentLimits {
  readonly title_max_chars: number | null;
  readonly subtitle_max_chars: number | null;
  readonly schedule_max_items: number | null;
  readonly food_max_items: number | null;
  readonly photo_spot_max_items: number | null;
  readonly ticket_max_items: number | null;
  readonly booking_tip_max_items: number | null;
}

/**
 * 每日信息图的限额（3.3 的示例值，`schedule_max_items` 见下）。
 *
 * ## R-25：`schedule_max_items` 不能取 3.3 示例里的 3
 *
 * 3.1.1 的节奏档位允许每日 2～6 条行程（`PACKED` 上限 6，且请求可自定义
 * 更高的 `attractions_per_day_max`），业务规则 V-10 保证的正是「条数落在
 * 所选节奏的区间内」。编排层再砍到 3 条，结果是**选了「紧凑」的用户，
 * 每日海报静默丢掉一半行程** —— 完整页 6 条、海报 3 条，页面上没有任何
 * 说明，而任务是成功的。
 *
 * 行程是计划本身，不是配图。海报画幅装不下时的正确处置是 17.3 那一整套
 * （压缩文案 → 隐藏低优先级模块 → 宽松版式 → 标 `DEGRADED`），
 * 那套机制存在的意义就是「不靠丢内容来适配画幅」。
 *
 * 因此这里是 `null`（不截断），条数由 V-10 与节奏区间约束。
 * 其余模块沿用 3.3 的值 —— 拍照机位第 4 条、门票提醒第 5 条属于补充信息，
 * 少一条不影响用户按这份计划出行。
 */
export const DAILY_CONTENT_LIMITS: ContentLimits = {
  title_max_chars: COMPACT_LIMITS.title,
  subtitle_max_chars: COMPACT_LIMITS.subtitle,
  schedule_max_items: null,
  food_max_items: 3,
  photo_spot_max_items: 3,
  ticket_max_items: 4,
  booking_tip_max_items: 4,
};

/** 3.3.1：完整计划页不裁剪内容 */
export const FULL_PLAN_CONTENT_LIMITS: ContentLimits = {
  title_max_chars: null,
  subtitle_max_chars: null,
  schedule_max_items: null,
  food_max_items: null,
  photo_spot_max_items: null,
  ticket_max_items: null,
  booking_tip_max_items: null,
};

/** 按限额截断；`null` 表示不截断 */
export function applyLimit<T>(items: readonly T[], limit: number | null): readonly T[] {
  if (limit === null || items.length <= limit) return items;
  return items.slice(0, limit);
}
