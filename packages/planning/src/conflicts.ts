import {
  TEMPLATE_ID_VALUES,
  isKnownConditionCode,
  type Currency,
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
  /** P9：信息使用授权（规范 15、4.1）*/
  'N-13',
  /** P9：阻塞生成的待确认项（规范 5.3、18）*/
  'N-14',
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

/**
 * N-12 的每币种物理下限（P9）。
 *
 * ## 为什么必须按币种查表
 *
 * P9 把币种从「仅 CNY」扩到 6 种，而 50 **日元**每人每天是一个荒谬的下限 ——
 * 它比真实下限低了两个数量级，于是 N-12 对所有日元请求完全失效：
 * 一个填了「每人每天 200 日元」（约 10 元人民币）的请求会被放行，
 * 而生成出的计划里每一餐都排不出来。
 *
 * ## 为什么不引入汇率
 *
 * 汇率是一个会变的外部依赖，而这里要的是一条「物理上排不出来」的硬下限 ——
 * 它的精度要求远低于汇率精度。用汇率意味着 N-12 的结果取决于某个 API
 * 当天的返回值，而一个昨天通过、今天被拒的请求无法向用户解释。
 *
 * 因此这是一张**声明式的每币种阈值表**，与原来声明「50 CNY」同性质。
 * 数值按各币种取整到一个好记的量级，宁可略低（宁可漏拒一个极端便宜的请求，
 * 也不要错拒一个正常请求 —— 后者用户完全无法理解）。
 *
 * `Record<Currency, number>` 而不是普通对象：新增币种漏填是**编译错误**。
 * 漏填的运行期表现是那个币种的下限是 undefined，比较结果恒为 false，
 * 于是 N-12 对它静默失效。
 */
export const MIN_DAILY_BUDGET_PER_PERSON: Record<Currency, number> = {
  CNY: MIN_DAILY_BUDGET_PER_PERSON_CNY,
  JPY: 1_000,
  USD: 8,
  EUR: 7,
  GBP: 6,
  HKD: 60,
};

/** 允许的行程天数（1.1 支持范围） */
export const MIN_TRIP_DAYS = 1;
export const MAX_TRIP_DAYS = 14;

/**
 * 允许的目的地数量（P9，规范 7 的多城市）。
 *
 * 上限 5 与契约里 `planner_profile.trip.destinations` 的 `.max(5)` 是同一个数。
 * 两处都写而不是只写一处：schema 层拒绝会给出 `REQ_SCHEMA_INVALID`
 * （定位不到表单项），而这里能给出 `REQ_MULTI_DESTINATION_UNSUPPORTED` +
 * 精确的 `field` —— 13.7 要求的正是后者。
 */
export const MAX_DESTINATIONS = 5;

/**
 * 弹性日期的天数上限（P9）。
 *
 * 30 天对应问卷里最松的一档「只定月份」（见前端的 `FLEXIBILITY_DAYS`）。
 * 留一条上限而不是完全放开：`flexibility_days` 本轮不参与任何排期计算，
 * 它只是告诉模型「日期可以动」，而一个 365 的值会让模型自由发挥。
 */
export const MAX_FLEXIBILITY_DAYS = 30;

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

  /*
   * N-09：弹性日期的天数上限（P9 放开）。
   *
   * ## 原来这条是「必须为 0」
   *
   * V1 不支持弹性日期，因此任何非 0 都被拒。P9 的规范 7 把日期弹性列为
   * 必填字段（五档：固定 / ±1 / ±3 / 整周 / 只定月份），因此这条规则从
   * 「等于 0」改成「不超过 30」——「只定月份」折成 30 天（见前端的
   * `FLEXIBILITY_DAYS`），而 30 就是这条规则的上限。
   *
   * ## 为什么还留一条上限
   *
   * `flexibility_days` 参与不了任何计算（本轮没有「在窗口内选日期」的排期器），
   * 它的作用是让模型知道「日期可以动」。一个 365 的值传下去只会让模型
   * 自由发挥，而用户实际是想表达「今年内某个时候」—— 那不是本轮支持的场景。
   * 上限拦住它并给出精确错误码，比静默按 365 天生成好。
   */
  if (ui.trip.dates.flexibility_days > MAX_FLEXIBILITY_DAYS) {
    add(
      'N-09',
      'REQ_DATE_FLEXIBILITY_UNSUPPORTED',
      'trip.dates.flexibility_days',
      `弹性天数 ${ui.trip.dates.flexibility_days} 超过上限 ${MAX_FLEXIBILITY_DAYS}`,
    );
  }

  /*
   * N-10：目的地数量 1～5（P9 放开）。
   *
   * ## 原来这条是「必须单目的地」
   *
   * V1 不支持多目的地，因此 `allow_multiple_destinations: true` 被直接拒。
   * P9 的规范 7 支持 1～5 个城市，因此这条规则改成检查**数量**。
   *
   * 数量取 `planner_profile.trip.destinations`：`trip.destination` 在契约里
   * 永远是单个（它是数据库提取列的来源，见陷阱 3），因此它数不出多城。
   *
   * ## `allow_multiple_destinations` 与实际数量必须一致
   *
   * 两者不一致有两种走法，都很糟：标了 true 却只发一个城市，会让模型以为
   * 还有城市没告诉它；发了三个城市却没标 true，会让任何按这个布尔分支的
   * 下游（当前是 Prompt 的城市序列渲染）只安排第一个城市 ——
   * 而那份计划看起来完全正常。
   */
  const destinations = ui.planner_profile?.trip?.destinations ?? [];
  if (destinations.length > MAX_DESTINATIONS) {
    add(
      'N-10',
      'REQ_MULTI_DESTINATION_UNSUPPORTED',
      'planner_profile.trip.destinations',
      `目的地数量 ${destinations.length} 超过上限 ${MAX_DESTINATIONS}`,
    );
  }
  if (destinations.length > 1 !== ui.trip.destination.allow_multiple_destinations) {
    add(
      'N-10',
      'REQ_MULTI_DESTINATION_UNSUPPORTED',
      'trip.destination.allow_multiple_destinations',
      `多目的地标记为 ${String(ui.trip.destination.allow_multiple_destinations)}，` +
        `而实际目的地数量为 ${destinations.length}`,
    );
  }

  /*
   * `destination.mode` 仍然只接受 `FIXED`。
   *
   * 多城市与「目的地未定」是两件不同的事：前者是「去这几个城市」，后者是
   * 「还没想好去哪，帮我推荐」。规范 7 的目的地发现分支不在本轮范围内
   * （`DESTINATION_MODE_VALUES` 至今只有 `FIXED` 一个值），因此这条保持原样。
   *
   * 单值枚举下取反即 never，显式加宽才能把实际值写进错误消息。
   */
  const destinationMode: string = ui.trip.destination.mode;
  if (destinationMode !== 'FIXED') {
    add(
      'N-10',
      'REQ_MULTI_DESTINATION_UNSUPPORTED',
      'trip.destination.mode',
      `目的地模式 ${destinationMode} 暂不支持`,
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
    /*
     * P9：下限按币种查表。
     *
     * 原来这里写死 50（CNY）。币种从「仅 CNY」扩到 6 种之后，50 日元每人每天
     * 比真实下限低两个数量级 —— 于是 N-12 对所有日元请求静默失效，
     * 一个「每人每天 200 日元」的请求会被放行而生成出的计划里每一餐都排不出来。
     */
    const perPersonPerDay = MIN_DAILY_BUDGET_PER_PERSON[normalized.budget.currency];
    const floor = normalized.total_days * normalized.traveler_count * perPersonPerDay;
    if (normalized.budget.total_min < floor) {
      add(
        'N-12',
        'REQ_BUDGET_INFEASIBLE',
        'budget.min',
        `预算总下限 ${normalized.budget.total_min} 低于物理下限 ${floor}` +
          `（${normalized.total_days} 天 × ${normalized.traveler_count} 人 × ` +
          `${perPersonPerDay} ${normalized.budget.currency}）`,
      );
    }
  }

  /*
   * N-13：必须有本次服务的信息使用授权（P9，规范 15 与 4.1）。
   *
   * ## 只对**发了问卷**的请求生效
   *
   * P8 及之前的客户端没有 `planner_profile`，它们的请求里压根没有这个字段。
   * 一律要求会让所有存量客户端立刻全部失败，而它们并没有做错任何事 ——
   * 授权是 V2 才引入的采集项。因此判定条件是「发了问卷但没勾授权」。
   *
   * ## 为什么不在 schema 里要求它
   *
   * 用户可以中途离开、可以提交一份草稿（规范 18 允许 `research-needed`
   * 状态下生成）。schema 拦住会让整个请求以 `REQ_SCHEMA_INVALID` 被拒 ——
   * 一个定位不到任何表单项的码。这里能给出 `REQ_CONSENT_REQUIRED`
   * 与指向那个勾选框的 `field`。
   */
  const profile = ui.planner_profile;
  if (profile !== undefined && profile.privacy?.trip_processing_consent !== true) {
    add(
      'N-13',
      'REQ_CONSENT_REQUIRED',
      'planner_profile.privacy.trip_processing_consent',
      '缺少本次服务的信息使用授权',
    );
  }

  /*
   * N-14：阻塞生成的待确认项必须已回答（P9，规范 5.3 与 18）。
   *
   * ## 判定的是「有没有回答」，不是「有没有核验」
   *
   * 规范 4.3 的核心是「用户自报永远不等于官方核验结论」，而后台核验不在本轮
   * 范围内（见实施计划的「明确不在本轮范围」）。因此这里能且只能要求
   * **用户那一侧做完了** —— 也就是 `verify_items` 里的 blocking 项都已登记。
   *
   * 反过来说：这条规则拦的是「跨境行程但护照状态一片空白」这种情况。
   * 那时 `verify_items` 里压根没有护照那一项（`deriveConstraints` 只为
   * 有答案的字段产出条目），因此判定方式是**比对应有与实有**：
   * 前端的 Field/Step 状态机已经算过一遍（`snapshot.blockers`），
   * 而服务端不能信任前端算的结果 —— 它只能看请求里有没有那些答案。
   *
   * 这里采用一个刻意保守的口径：**只检查跨境三件套**（国籍、护照、签证）。
   * 把 9 个 VERIFY 字段全查一遍需要在服务端复刻整个触发引擎，
   * 而那会造出第二套触发规则 —— 两套不一致的表现是
   * 「界面说可以生成，服务端说还缺项」，且用户无从判断谁是对的。
   * 跨境三件套的触发条件（出发国 ≠ 目的国）在服务端可独立、无歧义地判断。
   */
  for (const violation of checkBlockingVerify(profile)) violations.push(violation);

  return violations;
}

/**
 * 跨境三件套的完整性（N-14 的实现）。
 *
 * 跨境判定与前端的 D-02 同口径：**两边国家都已知且不同**。国家未知时不判跨境 ——
 * 猜错的两个方向都很糟（漏触发让用户拿到没查签证的跨境方案，误触发让国内游
 * 用户被拦住要求填护照）。
 */
function checkBlockingVerify(
  profile: TravelRequestUI['planner_profile'],
): readonly RequestViolation[] {
  if (profile === undefined) return [];

  const originCountry = profile.trip?.origin?.country;
  const destinations = profile.trip?.destinations ?? [];
  const international =
    originCountry !== undefined &&
    originCountry.length > 0 &&
    destinations.some(
      (place) =>
        place.country !== undefined && place.country.length > 0 && place.country !== originCountry,
    );
  if (!international) return [];

  const out: RequestViolation[] = [];
  const require = (ok: boolean, field: string, detail: string): void => {
    if (ok) return;
    out.push({
      rule: 'N-14',
      code: 'REQ_BLOCKING_VERIFY_INCOMPLETE',
      field,
      detail,
    });
  };

  require(profile.documents?.nationality_residency?.nationality !==
    undefined, 'planner_profile.documents.nationality_residency.nationality', '跨境行程缺少国籍 —— 签证与入境规则由它决定');
  require(profile.documents?.passport_status?.user_reported?.status !==
    undefined, 'planner_profile.documents.passport_status', '跨境行程缺少护照状态 —— 它决定能否做不可退预订');
  require(profile.documents?.visa_status?.user_reported?.status !==
    undefined, 'planner_profile.documents.visa_status', '跨境行程缺少签证状态 —— 办理时间需要排进时间线');

  return out;
}
