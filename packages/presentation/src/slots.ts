import type { Meal } from '@tps/schemas';

/**
 * 素材槽位 ID 生成（设计稿七章 AssetRequirement）。
 *
 * 槽位 ID 是**展示编排器与素材服务之间的唯一约定**，也是
 * `plan_asset_bindings` 的唯一约束组成部分（`UNIQUE(plan_version_id,
 * template_id, slot_id)`）。因此它必须是确定性的纯函数：同一天同一位置
 * 每次生成的 ID 必须完全一致，否则素材复用与去重都会失效。
 *
 * 格式与设计稿七章的示例一致：
 *   day_3.hero_background
 *   day_3.food.breakfast
 *   day_3.photo_spot.1
 *   day_3.route_map
 *
 * 完整计划页（FULL_PLAN）不新增槽位，只复用各日已解析的素材（3.3.1），
 * 因此这里只有按天的生成函数。
 */

function dayPrefix(dayNumber: number): string {
  return `day_${dayNumber}`;
}

export function heroSlotId(dayNumber: number): string {
  return `${dayPrefix(dayNumber)}.hero_background`;
}

export function routeMapSlotId(dayNumber: number): string {
  return `${dayPrefix(dayNumber)}.route_map`;
}

/** 按餐次而非下标 —— 同日餐次不重复（V-41），用餐次做键更稳定 */
export function foodSlotId(dayNumber: number, meal: Meal): string {
  return `${dayPrefix(dayNumber)}.food.${meal.toLowerCase()}`;
}

/** 拍照机位按 1 起的序号（与设计稿七章示例 `day_3.photo_spot.1` 一致） */
export function photoSpotSlotId(dayNumber: number, index: number): string {
  return `${dayPrefix(dayNumber)}.photo_spot.${index + 1}`;
}
