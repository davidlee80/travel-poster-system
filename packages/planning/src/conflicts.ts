import {
  TEMPLATE_ID_VALUES,
  isKnownConditionCode,
  type NormalizedTravelRequest,
  type RequestErrorCode,
  type TravelRequestUI,
} from '@tps/schemas';

/**
 * 输入冲突检查 N-01～N-12（TP-2-05，设计稿 3.1.2）。
 *
 * 全部在标准化阶段**同步**执行，失败直接返回 4xx，不入队、不调用 LLM。
 * 这一点是成本控制的关键：一次 LLM 调用几分钱，而「出发日期在过去」
 * 这类错误在入队前就能拦住。
 *
 * ## 为什么返回全部违规而不是第一条
 *
 * 表单有十几个字段，用户一次只被告知一个错误就要提交十几次。
 * 13.7 要求每条错误带 `field`，正是为了让前端一次高亮全部出错项。
 */

export interface RequestViolation {
  readonly rule: RequestRuleId;
  readonly code: RequestErrorCode;
  /** 13.7：`field` 必填，前端据此高亮表单项。用点分路径指向 UI 模型 */
  readonly field: string;
  /** 面向排查的英文/中文混合说明，不直接展示给用户（用户看 code 对应的 message） */
  readonly detail: string;
}

export const REQUEST_RULE_IDS = [
  'N-01',
  'N-02',
  'N-03',
  'N-04',
  'N-05',
  'N-06',
  'N-07',
  'N-08',
  'N-09',
  'N-10',
  'N-11',
  'N-12',
] as const;
export type RequestRuleId = (typeof REQUEST_RULE_IDS)[number];

/**
 * N-12 的物理下限：每人每天 50 CNY。
 *
 * 3.1.2 给的是这个数值，含义是「低于此额度连基本吃住行都排不出来」。
 * 抽成常量而不是内联，因为它是**业务参数**而不是算法细节 ——
 * 通胀或市场变化时要改的是它，而不是校验逻辑。
 */
export const MIN_DAILY_BUDGET_PER_PERSON_CNY = 50;

/** 允许的行程天数（1.1 支持范围） */
export const MIN_TRIP_DAYS = 1;
export const MAX_TRIP_DAYS = 14;

export interface ConflictCheckContext {
  /**
   * 「今天」在请求时区下的日期（`YYYY-MM-DD`）。
   *
   * 由调用方按 `normalized.timezone` 算好传入，而不是在这里读系统时钟：
   * N-01 是唯一依赖当前时间的规则，把时间源留在外面才能测「跨时区的
   * 边界日」—— 用户在 UTC+14 选今天出发，服务器在 UTC 上看来还是昨天。
   */
  readonly todayInRequestTimezone: string;
  /** 缺省使用内置字典；API 传入数据库当前发布版本的标签机器码。 */
  readonly allowedConditionCodes?: ReadonlySet<string>;
}

/**
 * 按请求时区算出「今天」的日期字符串。
 *
 * 用 `Intl.DateTimeFormat` 的 `en-CA` —— 它的短日期格式正好是
 * `YYYY-MM-DD`，避免手工拼接月日补零。Node 24 自带 full-icu，任意 IANA
 * 时区都可用。
 */
export function todayInTimezone(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * 执行 N-01～N-12。
 *
 * 同时需要 UI 原文与标准化结果：
 *   - N-08/N-09/N-10/N-11 检查的是 UI 上的原始字段；
 *   - N-03/N-12 检查的是标准化算出的派生值。
 * 只传一个都会导致某几条规则无法实现。
 */
export function checkRequestConflicts(
  ui: TravelRequestUI,
  normalized: NormalizedTravelRequest,
  context: ConflictCheckContext,
): readonly RequestViolation[] {
  const violations: RequestViolation[] = [];
  const add = (
    rule: RequestRuleId,
    code: RequestErrorCode,
    field: string,
    detail: string,
  ): void => {
    violations.push({ rule, code, field, detail });
  };

  // N-01：start_date 不早于今天（按请求时区）
  if (normalized.start_date < context.todayInRequestTimezone) {
    add(
      'N-01',
      'REQ_START_DATE_IN_PAST',
      'trip.dates.start_date',
      `出发日期 ${normalized.start_date} 早于请求时区（${normalized.timezone}）的今天 ${context.todayInRequestTimezone}`,
    );
  }

  // N-02：end_date >= start_date
  if (normalized.end_date < normalized.start_date) {
    add(
      'N-02',
      'REQ_DATE_RANGE_INVALID',
      'trip.dates.end_date',
      `返回日期 ${normalized.end_date} 早于出发日期 ${normalized.start_date}`,
    );
  }

  /*
   * N-03：total_days ∈ [1, 14]
   *
   * 与 N-02 会同时触发（日期倒置必然导致天数 ≤ 0），这是有意的：
   * 两条各指向不同的表单项，用户看到两处高亮比只看到一处更清楚。
   */
  if (normalized.total_days < MIN_TRIP_DAYS || normalized.total_days > MAX_TRIP_DAYS) {
    add(
      'N-03',
      'REQ_TRIP_DAYS_OUT_OF_RANGE',
      'trip.dates.end_date',
      `行程天数 ${normalized.total_days} 超出 ${MIN_TRIP_DAYS}～${MAX_TRIP_DAYS}`,
    );
  }

  // N-04：budget.max >= budget.min > 0
  if (!(normalized.budget.min > 0) || normalized.budget.max < normalized.budget.min) {
    add(
      'N-04',
      'REQ_BUDGET_RANGE_INVALID',
      'budget.min',
      `预算区间 [${normalized.budget.min}, ${normalized.budget.max}] 不满足 max >= min > 0`,
    );
  }

  // N-05：attractions_per_day_max >= attractions_per_day_min >= 1
  const pace = normalized.pace;
  if (
    pace.attractions_per_day_min < 1 ||
    pace.attractions_per_day_max < pace.attractions_per_day_min
  ) {
    add(
      'N-05',
      'REQ_PACE_RANGE_INVALID',
      'pace.attractions_per_day_min',
      `每日景点区间 [${pace.attractions_per_day_min}, ${pace.attractions_per_day_max}] 不满足 max >= min >= 1`,
    );
  }

  /*
   * N-06：origin.place_id != destination.place_id
   *
   * 只在**两侧都有 place_id** 时比较。用文本比较会误判：
   * 「杭州」与「杭州市」是同一地点的不同写法，而 place_id 才是权威标识。
   * 两侧缺 place_id 时无法可靠判断，放行 —— 误报比漏报更糟，
   * 因为用户会看到一条自己无法理解也无法修正的错误。
   */
  const originPlaceId = normalized.origin_place_id;
  const destinationPlaceId = normalized.destination_place_id;
  if (
    originPlaceId !== undefined &&
    destinationPlaceId !== undefined &&
    originPlaceId === destinationPlaceId
  ) {
    add(
      'N-06',
      'REQ_ORIGIN_EQUALS_DESTINATION',
      'trip.destination.place_id',
      `出发地与目的地是同一地点：${originPlaceId}`,
    );
  }

  // N-07：traveler_count >= 1
  if (normalized.traveler_count < 1) {
    add(
      'N-07',
      'REQ_TRAVELER_COUNT_INVALID',
      'travelers.adults',
      `出行人数 ${normalized.traveler_count} 少于 1`,
    );
  }

  /*
   * N-08：conditions[].code 必须在字典内（5.1）。
   *
   * schema 已经用 z.enum 拦了大部分，但这条仍然必要：标准化也会作用于
   * 从 travel_requests.raw_request 重放的历史请求，而字典是会演进的
   * （5.1 明确说「新增 code 需要同时更新字典与 Prompt 模板」）。
   * 字典删掉某个 code 后，旧请求重放时必须报错而不是静默丢弃 ——
   * 静默丢弃会让 MUST 约束凭空消失。
   */
  ui.conditions.forEach((condition, index) => {
    /*
     * 先加宽再判断。`isKnownConditionCode` 是类型守卫，取反后 TS 会把
     * `condition.code` 收窄成 `never` —— 这恰好证明了「按当前类型这条分支
     * 不可达」，而它存在的理由正是处理**类型之外**的输入（重放历史请求）。
     * 不加宽的话连错误消息里都插不进这个值。
     */
    const code: string = condition.code;
    const known = context.allowedConditionCodes?.has(code) ?? isKnownConditionCode(code);
    if (!known) {
      add(
        'N-08',
        'REQ_CONDITION_CODE_UNKNOWN',
        `conditions[${index}].code`,
        `条件 code ${code} 不在 5.1 的字典内`,
      );
    }
  });

  // N-09：flexibility_days === 0（V1 不支持弹性日期）
  if (ui.trip.dates.flexibility_days !== 0) {
    add(
      'N-09',
      'REQ_DATE_FLEXIBILITY_UNSUPPORTED',
      'trip.dates.flexibility_days',
      `弹性天数 ${ui.trip.dates.flexibility_days} 不为 0`,
    );
  }

  /*
   * N-10：destination.mode === 'FIXED' 且 allow_multiple_destinations === false
   *
   * mode 一侧在 V1 由 schema 的单值枚举兜住（DESTINATION_MODE_VALUES 只有
   * FIXED），因此那条分支当前不可达。仍然写出来：V2 加入 SUGGESTED 后
   * 枚举放宽，这条检查会自动接管，不需要有人记得回来补。
   */
  // 同上：单值枚举下取反即 never，显式加宽才能把实际值写进错误消息
  const destinationMode: string = ui.trip.destination.mode;
  if (destinationMode !== 'FIXED') {
    add(
      'N-10',
      'REQ_MULTI_DESTINATION_UNSUPPORTED',
      'trip.destination.mode',
      `目的地模式 ${destinationMode} 在 V1 不支持`,
    );
  }
  if (ui.trip.destination.allow_multiple_destinations) {
    add(
      'N-10',
      'REQ_MULTI_DESTINATION_UNSUPPORTED',
      'trip.destination.allow_multiple_destinations',
      '多目的地行程在 V1 不支持',
    );
  }

  // N-11：template_id 在已注册模板列表中
  if (!(TEMPLATE_ID_VALUES as readonly string[]).includes(ui.output_preferences.template_id)) {
    add(
      'N-11',
      'REQ_TEMPLATE_UNKNOWN',
      'output_preferences.template_id',
      `模板 ${ui.output_preferences.template_id} 未注册`,
    );
  }

  /*
   * N-12：预算下限在物理上可行。
   *
   * 3.1.2 的公式是 `budget_total_min >= total_days × traveler_count × 50`。
   * 注意左侧是**折算后的总额**：PER_PERSON_PER_DAY 下用户填 30 元/人/天
   * 会被折算成总额后再比较，因此这条规则对两种 basis 都成立。
   *
   * 天数或人数非法时跳过：那时右侧是 0 或负数，比较结果毫无意义，
   * 而用户真正需要修的是 N-03 / N-07 报出的问题。
   */
  const feasibleDays = normalized.total_days >= MIN_TRIP_DAYS;
  const feasibleTravelers = normalized.traveler_count >= 1;
  if (feasibleDays && feasibleTravelers) {
    const floor =
      normalized.total_days * normalized.traveler_count * MIN_DAILY_BUDGET_PER_PERSON_CNY;
    if (normalized.budget.total_min < floor) {
      add(
        'N-12',
        'REQ_BUDGET_INFEASIBLE',
        'budget.min',
        `预算总下限 ${normalized.budget.total_min} 低于物理下限 ${floor}` +
          `（${normalized.total_days} 天 × ${normalized.traveler_count} 人 × ${MIN_DAILY_BUDGET_PER_PERSON_CNY} 元）`,
      );
    }
  }

  return violations;
}
