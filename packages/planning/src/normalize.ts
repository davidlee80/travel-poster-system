import {
  PACE_LEVEL_VALUES,
  SCHEMA_VERSIONS,
  type NormalizedTravelRequest,
  type PaceLevel,
  type ResolvedPace,
  type TravelRequestUI,
} from '@tps/schemas';

/**
 * 标准化计算（TP-2-04，设计稿 3.1.1、5.1）。
 *
 * ## 这是纯计算，不做判断
 *
 * 3.1.1 与 3.1.2 分工明确：这里只算派生值，合不合法交给 N-01～N-12。
 * 因此本函数**对任何结构合法的输入都能返回结果** ——
 * `end_date` 早于 `start_date` 时 `total_days` 是负数，`traveler_count`
 * 可以是 0。这不是漏校验，而是让冲突检查能引用算好的值：
 * N-03 判 `total_days ∈ [1,14]`、N-12 判 `budget_total_min` 是否够用，
 * 两者都必须在计算之后。
 *
 * 反过来若在这里边算边抛，第一个问题就会中断计算，用户一次只能看到一个错误。
 */

/** 自由文本上限（5.1）。超长截断并记入 assumptions，不是拒绝 */
export const CUSTOM_TEXT_MAX_CHARS = 500;

/**
 * 5.1 的节奏默认值表。
 *
 * `Record<PaceLevel, ...>` 而不是普通对象：新增档位时漏填是编译错误。
 * 漏填的运行期表现是该档位下四个参数全为 undefined，
 * 而下游把 undefined 当 0 处理 —— 生成出「每天 0 个景点」的计划。
 */
export const PACE_DEFAULTS: Record<PaceLevel, Omit<ResolvedPace, 'level'>> = {
  RELAXED: {
    attractions_per_day_min: 2,
    attractions_per_day_max: 3,
    walking_limit_km: 5,
    earliest_departure_time: '09:00',
  },
  BALANCED: {
    attractions_per_day_min: 3,
    attractions_per_day_max: 4,
    walking_limit_km: 8,
    earliest_departure_time: '08:30',
  },
  PACKED: {
    attractions_per_day_min: 4,
    attractions_per_day_max: 6,
    walking_limit_km: 12,
    earliest_departure_time: '08:00',
  },
};

/**
 * `level` 缺省时的档位。
 *
 * 取 `BALANCED` 而不是 `RELAXED`：缺省意味着用户没有表达偏好，
 * 应该落在中间档而不是最松的一档。
 */
export const DEFAULT_PACE_LEVEL: PaceLevel = 'BALANCED';

/** 天数（含首尾）。可能为 0 或负 —— 由 N-02/N-03 判定 */
export function computeTotalDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);

  /*
   * 用 UTC 解析而不是本地时区：只关心两个日历日之间差几天，
   * 而本地时区在夏令时切换日会让相差 86400000ms 的两天算出 23 或 25 小时。
   * 日期字符串的格式已由 DateStringSchema 保证。
   */
  return Math.round((end - start) / 86_400_000) + 1;
}

/** 3.1.1：`adults + children.length + seniors.length`。可能为 0 —— 由 N-07 判定 */
export function computeTravelerCount(travelers: TravelRequestUI['travelers']): number {
  return travelers.adults + travelers.children.length + travelers.seniors.length;
}

/**
 * 解析节奏参数（5.1）。
 *
 * 规则：**数值字段优先**，`level` 只在数值缺省时提供默认值。
 * 两者同时提供是合法输入，不是冲突 —— 这条常被写反，写反的后果是
 * 用户填的具体数字被档位默认值覆盖，而界面上显示的仍是用户填的值。
 */
export function resolvePace(pace: TravelRequestUI['pace']): ResolvedPace {
  const level = pace.level ?? DEFAULT_PACE_LEVEL;
  const defaults = PACE_DEFAULTS[level];

  return {
    level,
    attractions_per_day_min: pace.attractions_per_day_min ?? defaults.attractions_per_day_min,
    attractions_per_day_max: pace.attractions_per_day_max ?? defaults.attractions_per_day_max,
    walking_limit_km: pace.walking_limit_km ?? defaults.walking_limit_km,
    earliest_departure_time: pace.earliest_departure_time ?? defaults.earliest_departure_time,
  };
}

/**
 * 预算折算（3.1.1）。
 *
 * `PER_PERSON_PER_DAY` → 乘人数与天数；`TOTAL` → 直接取原值。
 * 折算用 `traveler_count` 与 `total_days` 的**已算出值**，因此在
 * 天数越界或人数为 0 时会得到 0 或负数 —— 交给 N-04/N-12 判定。
 */
export function computeBudgetTotals(
  budget: TravelRequestUI['budget'],
  travelerCount: number,
  totalDays: number,
): { readonly total_min: number; readonly total_max: number } {
  if (budget.basis === 'TOTAL') {
    return { total_min: budget.min, total_max: budget.max };
  }

  const factor = travelerCount * totalDays;
  return { total_min: budget.min * factor, total_max: budget.max * factor };
}

/**
 * 截断自由文本（5.1）。
 *
 * 返回截断事实而不是只返回文本：5.1 要求「超长截断并记入 `assumptions`」，
 * 而 `assumptions` 会随计划返回给用户。悄悄截掉 300 字需求再生成一份
 * 「看起来完整」的计划，是最容易让用户产生错误信任的做法。
 */
export function truncateCustomText(raw: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const trimmed = raw.trim();
  // 按码点计数而不是 UTF-16 码元：中文与 emoji 都不该被算成两个字
  const codePoints = [...trimmed];

  if (codePoints.length <= CUSTOM_TEXT_MAX_CHARS) {
    return { text: trimmed, truncated: false };
  }

  return { text: codePoints.slice(0, CUSTOM_TEXT_MAX_CHARS).join(''), truncated: true };
}

/**
 * 3.1.1 全量标准化。
 *
 * 输入必须是**已通过 schema 校验**的 `TravelRequestUI`。
 */
export function normalizeTravelRequest(ui: TravelRequestUI): NormalizedTravelRequest {
  const totalDays = computeTotalDays(ui.trip.dates.start_date, ui.trip.dates.end_date);
  const travelerCount = computeTravelerCount(ui.travelers);
  const totals = computeBudgetTotals(ui.budget, travelerCount, totalDays);
  const custom = truncateCustomText(ui.custom_requirements.raw_text);

  const assumptions: string[] = [];
  if (custom.truncated) {
    assumptions.push(`自定义需求超过 ${CUSTOM_TEXT_MAX_CHARS} 字，已截断后半部分。`);
  }
  if (ui.pace.level === undefined) {
    assumptions.push(`未指定行程节奏，按「${DEFAULT_PACE_LEVEL}」处理。`);
  }

  return {
    schema_version: SCHEMA_VERSIONS.normalizedTravelRequest,
    client_request_id: ui.client_request_id,
    locale: ui.locale,
    timezone: ui.timezone,

    destination_name: ui.trip.destination.text,
    ...(ui.trip.destination.place_id !== undefined
      ? { destination_place_id: ui.trip.destination.place_id }
      : {}),
    origin_name: ui.trip.origin.text,
    ...(ui.trip.origin.place_id !== undefined ? { origin_place_id: ui.trip.origin.place_id } : {}),

    start_date: ui.trip.dates.start_date,
    end_date: ui.trip.dates.end_date,
    total_days: totalDays,

    traveler_count: travelerCount,
    has_child: ui.travelers.children.length > 0,
    has_senior: ui.travelers.seniors.length > 0,

    budget: {
      currency: ui.budget.currency,
      basis: ui.budget.basis,
      min: ui.budget.min,
      max: ui.budget.max,
      total_min: totals.total_min,
      total_max: totals.total_max,
      included_items: ui.budget.included_items,
    },

    pace: resolvePace(ui.pace),

    /*
     * 3.1.1：按 mode 拆成硬约束与软约束。
     *
     * 拆分而不是保留一个带 mode 的数组：MUST 与 SHOULD 在 Prompt 里的地位
     * 完全不同（前者不可违反，后者尽量满足），而 V-30/V-31 只校验 MUST。
     * 保留混合数组会让每个下游都要自己过滤一遍，漏一处就等于把硬约束降级。
     */
    must_conditions: ui.conditions.filter((condition) => condition.mode === 'MUST'),
    should_conditions: ui.conditions.filter((condition) => condition.mode === 'SHOULD'),

    custom_text: custom.text,
    output_preferences: ui.output_preferences,
    assumptions,
  };
}

/** 供测试与 Prompt 构造遍历档位 */
export const PACE_LEVELS = PACE_LEVEL_VALUES;
