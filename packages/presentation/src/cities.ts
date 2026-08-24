import type { TravelPlan } from '@tps/schemas';

/**
 * 多城行程的显示（P9，规范 7）。
 *
 * ## 为什么不直接读 `plan.destination.name`
 *
 * `TravelPlan.destination` 是**单个**地点 —— 它是数据库提取列的来源
 * （`travel_requests.destination_name NOT NULL`，见 P9 实施计划的陷阱 3），
 * 因此不能变成数组。多城信息在**每日的 `day.city`** 里。
 *
 * 于是一份「东京 3 天 + 京都 2 天」的行程，plan 级目的地是「东京」。
 * 完整页的标题若直接用它，用户会看到一份写着「东京 · 5 天」的行程，
 * 而里面有两天在京都 —— 那不是排版问题，那是一份**说错了自己是什么**的文档。
 *
 * ## 为什么从每日 city 聚合，而不是从 `normalized.cities`
 *
 * 展示层拿到的是 `TravelPlan`，它不带 `NormalizedTravelRequest`。而且这里要显示的
 * 是**实际排出来的行程**去了哪几个城市，而不是用户当初要求了哪几个 ——
 * 两者可能不同（模型可能把某一城压掉，那时 V-04 不会报错，
 * 因为「每日 city ∈ 城市序列」仍然成立）。显示实际的更诚实。
 */

/**
 * 行程实际经过的城市，按首次出现顺序去重。
 *
 * 去重而不是逐日列出：一份 5 天的行程会给出 `[东京, 东京, 东京, 京都, 京都]`，
 * 而标题需要的是 `[东京, 京都]`。
 *
 * 按**首次出现顺序**而不是排序：那个顺序就是行程顺序，而按字母或拼音排
 * 会让「东京 → 京都」在某些组合下显示成反的。
 */
export function planCityNames(plan: TravelPlan): readonly string[] {
  const seen: string[] = [];
  for (const day of plan.days) {
    if (!seen.includes(day.city)) seen.push(day.city);
  }
  /*
   * 一天都没有时回退到 plan 级目的地。`TravelPlanContentSchema` 要求
   * `days` 至少一条，因此这条路径取不到 —— 留着是为了让这个函数对任意输入
   * 都返回非空数组，调用方因此不需要处理空标签。
   */
  return seen.length > 0 ? seen : [plan.destination.name];
}

/** 是否跨多个城市 */
export function isMultiCityPlan(plan: TravelPlan): boolean {
  return planCityNames(plan).length > 1;
}

/**
 * 完整页与信息图 header 用的目的地标签。
 *
 * ## 分隔符用 `·` 而不是 `→`
 *
 * 箭头在小字号下与减号难以分辨，且它已经被路线图与行程条用掉了
 * （`schedule` 的 POI 串就是 `A → B → C`）。同一个符号在同一页表达两种
 * 不同层级的顺序会让人读错层级。
 *
 * ## 超过三城时收尾成「等 N 城」
 *
 * 五城的标签是 `东京 · 京都 · 大阪 · 奈良 · 神户`，在信息图的标题区
 * （固定宽度）会撑破或被 `toCompact` 从中间截断 —— 而截断后的
 * 「东京 · 京都 · 大阪 · 奈…」比「东京 · 京都 · 大阪 等 5 城」信息量更少。
 * 三城以内全列：那是绝大多数多城行程的情形。
 */
export const CITY_LABEL_SEPARATOR = ' · ';
export const MAX_LISTED_CITIES = 3;

export function destinationLabel(plan: TravelPlan): string {
  const cities = planCityNames(plan);
  if (cities.length <= MAX_LISTED_CITIES) return cities.join(CITY_LABEL_SEPARATOR);
  return `${cities.slice(0, MAX_LISTED_CITIES).join(CITY_LABEL_SEPARATOR)} 等 ${cities.length} 城`;
}
