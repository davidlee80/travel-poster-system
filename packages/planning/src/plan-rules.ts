import type {
  BudgetIncludedItem,
  NormalizedTravelRequest,
  TravelPlanContent,
  ViolationSeverity,
} from '@tps/schemas';

import { planCities } from './normalize.js';
import { collectAmountSlots, collectCurrencySlots, collectStringSlots } from './plan-slots.js';
import {
  ANGLE_BRACKET_PATTERN,
  MARKDOWN_PATTERNS,
  PLACEHOLDER_PATTERN,
  URL_PATTERN,
  normalizeText,
} from './plan-text.js';
import { dateForDay, timeToMinutes } from './plan-time.js';

/**
 * 业务规则校验规则集 V-01～V-45（TP-2-12，设计稿 3.2.1）。
 *
 * ## 与 Schema 校验的分工
 *
 * schema 管「字段在不在、类型对不对」，这里管「数值合不合理、条目多不多、
 * 约束满不满足」。分工的理由见 `@tps/schemas` 的 travel-plan.ts：
 * schema 一律拒绝会把全部 `REPAIRABLE` 升级成 `BLOCKING`（16.3 把 Schema
 * 校验失败列为阻断项），自动修复机制就完全失效。
 *
 * 因此**本模块的输入是已通过 `TravelPlanContentSchema` 的对象** ——
 * 下面的检查可以假定字段存在且类型正确，只判断取值。
 *
 * ## 为什么返回全部违规而不是遇到第一条就停
 *
 * 3.2.2 的第一级修复要在一轮里把所有能程序化处理的问题一起改掉。
 * 只返回第一条会让每轮只修一个问题，3 轮上限下必然耗尽 ——
 * 而耗尽的表现是任务 `FAILED`，用户看到「多次校验未通过」。
 */

export const PLAN_RULE_IDS = [
  // 结构与一致性
  'V-01',
  'V-02',
  'V-03',
  'V-04',
  'V-05',
  'V-06',
  'V-07',
  'V-08',
  // 节奏与体力
  'V-10',
  'V-11',
  'V-12',
  'V-13',
  'V-14',
  // 预算
  'V-20',
  'V-21',
  'V-22',
  'V-23',
  'V-24',
  // 约束满足
  'V-30',
  'V-31',
  'V-32',
  'V-33',
  // 内容质量
  'V-40',
  'V-41',
  'V-42',
  'V-43',
  'V-44',
  'V-45',
] as const;

export type PlanRuleId = (typeof PLAN_RULE_IDS)[number];

/**
 * 3.2.1 冻结 28 条。
 *
 * 显式写出数量而不是用 `PLAN_RULE_IDS.length`：这样漏抄一条会让常量断言
 * 失败，而不是让「28 条」变成「27 条也算对」。
 */
export const PLAN_RULE_COUNT = 28;

export interface PlanRuleSpec {
  /** 3.2.1 声明的级别。V-44 会按情况升级为 BLOCKING，见该规则说明 */
  readonly severity: ViolationSeverity;
  readonly title: string;
}

export const PLAN_RULES: Record<PlanRuleId, PlanRuleSpec> = {
  'V-01': { severity: 'BLOCKING', title: '天数与请求一致' },
  'V-02': { severity: 'BLOCKING', title: 'day_number 从 1 连续递增无重复' },
  'V-03': { severity: 'BLOCKING', title: '日期锚定到请求的出发日期' },
  /* P9：从「与目的地一致」改为「属于城市序列」。单城时集合退化成等值 */
  'V-04': { severity: 'REPAIRABLE', title: '每日城市属于城市序列' },
  'V-05': { severity: 'BLOCKING', title: '每日至少一条行程' },
  'V-06': { severity: 'REPAIRABLE', title: '行程按时间升序且不重叠' },
  'V-07': { severity: 'REPAIRABLE', title: '结束时间与时长自洽' },
  'V-08': { severity: 'REPAIRABLE', title: '经纬度在合法范围' },
  'V-10': { severity: 'REPAIRABLE', title: '每日景点数在节奏区间内' },
  'V-11': { severity: 'REPAIRABLE', title: '每日步行距离不超上限' },
  'V-12': { severity: 'REPAIRABLE', title: '首条行程不早于最早出发时间' },
  'V-13': { severity: 'REPAIRABLE', title: '当日行程不过晚结束' },
  'V-14': { severity: 'ADVISORY', title: '有长者时步行上限收紧到 4 公里' },
  'V-20': { severity: 'REPAIRABLE', title: '预算分桶与明细自洽' },
  'V-21': { severity: 'REPAIRABLE', title: '总额不超预算上限' },
  'V-22': { severity: 'ADVISORY', title: '总额不显著低于预算下限' },
  'V-23': { severity: 'BLOCKING', title: '币种全文一致' },
  'V-24': { severity: 'REPAIRABLE', title: '数值非负且最多两位小数' },
  'V-30': { severity: 'BLOCKING', title: '每个硬约束都被满足' },
  'V-31': { severity: 'BLOCKING', title: '违反清单中没有硬约束' },
  'V-32': { severity: 'ADVISORY', title: '软约束满足率不低于 60%' },
  'V-33': { severity: 'ADVISORY', title: '有儿童时每日有适合儿童的安排' },
  'V-40': { severity: 'REPAIRABLE', title: '标题类文案不超长' },
  'V-41': { severity: 'REPAIRABLE', title: '每日美食推荐 1～4 条且餐次不重复' },
  'V-42': { severity: 'REPAIRABLE', title: '拍照机位对应当日行程地点' },
  'V-43': { severity: 'REPAIRABLE', title: '推荐路线至少 2 个节点' },
  'V-44': { severity: 'REPAIRABLE', title: '无空串、占位词与 Markdown 残留' },
  'V-45': { severity: 'REPAIRABLE', title: '无 URL 与 HTML' },
};

export interface PlanViolation {
  readonly rule: PlanRuleId;
  /** 取自 `PLAN_RULES`，V-44 可升级为 BLOCKING */
  readonly severity: ViolationSeverity;
  /** 点分路径，定位到具体字段，便于 LLM 定向重生成时指出问题所在 */
  readonly path: string;
  /** 面向排查与 LLM 提示的说明，不直接展示给用户 */
  readonly detail: string;
}

export interface PlanValidationContext {
  readonly normalized: NormalizedTravelRequest;
}

// ── 规则参数（全部来自 3.2.1，抽成常量便于测试与调参）──────────

/** V-07：`duration_minutes` 与时间差的容差 */
export const DURATION_TOLERANCE_MINUTES = 5;
/** V-11：步行距离容差 +20% */
export const WALKING_TOLERANCE_RATIO = 1.2;
/** V-14：有长者时的步行上限 */
export const SENIOR_WALKING_LIMIT_KM = 4;
/** V-13：默认最晚结束时间 */
export const DEFAULT_LATEST_END_TIME = '22:00';
/** V-13：自由文本含「不要太晚」类语义时收紧到 */
export const TIGHTENED_LATEST_END_TIME = '21:00';
/** V-21：预算上限容差 +10% */
export const BUDGET_MAX_TOLERANCE_RATIO = 1.1;
/** V-22：低于预算下限的这个比例才记入 assumptions */
export const BUDGET_MIN_RATIO = 0.6;
/** V-32：软约束满足率下限 */
export const SHOULD_SATISFACTION_MIN_RATIO = 0.6;
/** V-41：每日美食推荐条数 */
export const FOOD_MIN_PER_DAY = 1;
export const FOOD_MAX_PER_DAY = 4;
/** V-43：路线最少节点数 */
export const MIN_ROUTE_NODES = 2;
/** V-40：三处文案限长 */
export const TITLE_MAX_CHARS = 30;
export const THEME_MAX_CHARS = 18;
export const SUBTITLE_MAX_CHARS = 32;

/**
 * 金额比较的容差。
 *
 * 浮点加法让 `0.1 + 0.2 !== 0.3`，直接用 `!==` 比较分桶之和会产出
 * 一条**永远无法修复**的 V-20 违规 —— 修复函数写回的正是同一个浮点和，
 * 下一轮再比较又不相等，3 轮耗尽后任务失败。半分钱的容差消除这个死循环。
 */
const MONEY_EPSILON = 0.005;

/**
 * V-13 的「不要太晚」语义识别。
 *
 * 3.2.1 写的是「含 `custom_requirements` 中『不要太晚』类**语义**时收紧」。
 * V1 没有语义分析能力（3.2.3 的 L3 LLM 摘要都被推迟了），因此只能做关键词
 * 匹配。这是一个**已知的近似**：
 *   - 漏判 → 沿用 22:00，行程稍晚，用户可以自己调整；
 *   - 误判 → 收紧到 21:00，末位条目被压缩或删除。
 * 两者都不致命，且都是 `REPAIRABLE` 路径。关键词表保持保守（只收
 * 明确表达「结束早一点」的说法），宁可漏判也不误判。
 */
const LATE_NIGHT_PATTERNS: readonly RegExp[] = [
  /不要太晚/,
  /不太晚/,
  /别太晚/,
  /不要安排太晚/,
  /早点回/,
  /早些回/,
  /早点休息/,
  /早些休息/,
  /不熬夜/,
  /不要熬夜/,
  /避免夜间/,
  /避免太晚/,
];

// ── 共享派生量 ──────────────────────────────────────────────

/**
 * V-14 与 V-11 共用的实际步行上限。
 *
 * V-14 是 `ADVISORY`（只记 `assumptions`），它的作用是**定义**这个值；
 * V-11 是 `REPAIRABLE`，它按这个值执行。两条规则读同一个函数，
 * 否则会出现「V-14 告诉用户按 4 公里安排，V-11 却按 12 公里放行」。
 */
export function effectiveWalkingLimitKm(normalized: NormalizedTravelRequest): number {
  const declared = normalized.pace.walking_limit_km;
  return normalized.has_senior ? Math.min(declared, SENIOR_WALKING_LIMIT_KM) : declared;
}

/**
 * V-13：当日最晚允许的结束时间。
 *
 * 3.2.1 只提到从 `custom_requirements` 的自由文本里识别「不要太晚」类语义，
 * 但 5.1 的条件字典里本来就有 `schedule.no_late_night` —— 用户勾选了那个
 * 复选框时，按原文实现的 V-13 会**完全忽略它**，只因为他没有额外在自由文本里
 * 再写一遍。结构化条件比关键词可靠得多，因此优先读它，自由文本作为补充。
 * 见设计稿修订 R-23。
 */
export const NO_LATE_NIGHT_CODE = 'schedule.no_late_night';

export function latestEndTime(normalized: NormalizedTravelRequest): string {
  const declared = [...normalized.must_conditions, ...normalized.should_conditions].some(
    (condition) => condition.code === NO_LATE_NIGHT_CODE && condition.value,
  );
  const inferred = LATE_NIGHT_PATTERNS.some((pattern) => pattern.test(normalized.custom_text));

  return declared || inferred ? TIGHTENED_LATEST_END_TIME : DEFAULT_LATEST_END_TIME;
}

/** 四舍五入到两位小数（V-20/V-21/V-24 共用） */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function satisfiedCodes(plan: TravelPlanContent): ReadonlySet<string> {
  return new Set(plan.constraint_report.satisfied.map((entry) => entry.code));
}

/**
 * 由 `breakdown` 与住宿费推导出的全套预算数值（V-20）。
 *
 * 住宿是**唯一不由 `breakdown` 决定的输入** —— `BUDGET_BUCKET_VALUES` 只有
 * 门票／交通／餐饮／其他四个桶，没有住宿桶，因此住宿只存在于
 * `total_budget.accommodation`。校验与修复都以模型给出的住宿费为准。
 */
export interface DerivedBudget {
  readonly daily: readonly {
    readonly ticket: number;
    readonly transport: number;
    readonly meal: number;
    readonly other: number;
    readonly total: number;
  }[];
  readonly ticket: number;
  readonly transport: number;
  readonly meal: number;
  readonly other: number;
  readonly accommodation: number;
  readonly total: number;
  readonly perPerson: number;
}

export function deriveBudget(plan: TravelPlanContent): DerivedBudget {
  const daily = plan.days.map((day) => {
    const sumBucket = (bucket: 'TICKET' | 'TRANSPORT' | 'MEAL' | 'OTHER'): number =>
      round2(
        day.daily_budget.breakdown
          .filter((entry) => entry.bucket === bucket)
          .reduce((acc, entry) => acc + entry.amount, 0),
      );

    const ticket = sumBucket('TICKET');
    const transport = sumBucket('TRANSPORT');
    const meal = sumBucket('MEAL');
    const other = sumBucket('OTHER');

    return { ticket, transport, meal, other, total: round2(ticket + transport + meal + other) };
  });

  /*
   * `daily_budget` 是**每人每天**的金额（3.2.1 的 V-21 公式里乘了
   * `traveler_count` 就是这个含义），`total_budget` 是全团总额。
   */
  const travelers = Math.max(1, plan.traveler_count);
  const sum = (pick: (d: DerivedBudget['daily'][number]) => number): number =>
    round2(daily.reduce((acc, d) => acc + pick(d), 0) * travelers);

  const ticket = sum((d) => d.ticket);
  const transport = sum((d) => d.transport);
  const meal = sum((d) => d.meal);
  const other = sum((d) => d.other);
  const accommodation = plan.total_budget.accommodation;
  const total = round2(ticket + transport + meal + other + accommodation);

  return {
    daily,
    ticket,
    transport,
    meal,
    other,
    accommodation,
    total,
    perPerson: round2(total / travelers),
  };
}

/**
 * 按**用户的预算口径**折算出可比总额（V-21 / V-22）。
 *
 * ## 为什么需要它
 *
 * `budget.included_items` 声明这笔钱覆盖哪些开支。而 `deriveBudget().total`
 * 恒等于「门票 + 交通 + 餐饮 + 其他 + 住宿」—— 拿它直接比一个「不含住宿」的
 * 上限，会把 5 晚房费算成超支，V-21 随即让 `repair-plan.ts` 去砍门票与餐饮。
 * 计划本来是合规的，被削掉的是用户真正想要的东西。
 *
 * ## 两个可选字段缺省时读作 0，而不是「不知道」
 *
 * 住宿／门票／餐饮各有独立的桶或字段，可直接扣。往返大交通与市内交通同在
 * `transport` 桶里、购物混在 `other` 里，要靠 `total_budget.intercity_transport`
 * 与 `total_budget.shopping` 才能拆开 —— 而它们是可选的。
 *
 * 缺省读作 0（「这份总额里没有这一项」），理由有两条：
 *
 * 1. **提示词第 8 条正是这么要求的**：含才给，不含就省略、不要写 0。
 * 2. 读作「不知道」的代价是它会命中**绝大多数请求**：契约默认口径
 *    `DEFAULT_BUDGET_ITEMS` 只有住宿／餐饮／市内交通／门票，本来就不含
 *    往返大交通与购物。于是每一份默认请求都要带一句「无法区分…」的说明，
 *    而 `assumptions` 是我们告知「签证未核验」这类要紧事的同一个位置 ——
 *    在那里放一句 100% 出现的废话，等于训练用户忽略它。
 *
 * 代价是不守规矩的模型（把机票塞进 `transport` 又省略 `intercity_transport`）
 * 会让比较偏严。这与 `total_budget.accommodation` 的信任级别一致 ——
 * V-20 校验的是内部自洽，从来不校验金额是否属实。
 *
 * ## 不夹到 0
 *
 * 模型给出 `intercity_transport > transport` 时结果会是负数。不夹 ——
 * 那是一处真实的不一致，由 V-20 的子集检查报出并修复；
 * 夹到 0 只会让它变成「预算低于下限」这种指错方向的违规。
 */
export function comparableTotal(
  plan: TravelPlanContent,
  includedItems: readonly BudgetIncludedItem[],
): number {
  const derived = deriveBudget(plan);
  const included = new Set<string>(includedItems);
  const intercity = plan.total_budget.intercity_transport ?? 0;

  let total = derived.total;
  const drop = (amount: number): void => {
    total = round2(total - amount);
  };

  if (!included.has('ACCOMMODATION')) drop(derived.accommodation);
  if (!included.has('TICKETS')) drop(derived.ticket);
  if (!included.has('MEALS')) drop(derived.meal);

  /* 两者都不含时整桶扣掉，不必拆 —— 也就不受 intercity 缺省的影响 */
  if (!included.has('INTERCITY_TRANSPORT') && !included.has('LOCAL_TRANSPORT')) {
    drop(derived.transport);
  } else if (!included.has('INTERCITY_TRANSPORT')) {
    drop(intercity);
  } else if (!included.has('LOCAL_TRANSPORT')) {
    drop(round2(derived.transport - intercity));
  }

  if (!included.has('SHOPPING')) drop(plan.total_budget.shopping ?? 0);

  return total;
}

// ── 规则实现 ────────────────────────────────────────────────

type RuleCheck = (plan: TravelPlanContent, ctx: PlanValidationContext) => PlanViolation[];

function violation(
  rule: PlanRuleId,
  path: string,
  detail: string,
  severity?: ViolationSeverity,
): PlanViolation {
  return { rule, severity: severity ?? PLAN_RULES[rule].severity, path, detail };
}

const RULE_CHECKS: Record<PlanRuleId, RuleCheck> = {
  'V-01': (plan, { normalized }) =>
    plan.days.length === normalized.total_days
      ? []
      : [
          violation(
            'V-01',
            'days',
            `计划包含 ${plan.days.length} 天，请求为 ${normalized.total_days} 天`,
          ),
        ],

  'V-02': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, index) => {
      if (day.day_number !== index + 1) {
        out.push(
          violation(
            'V-02',
            `days[${index}].day_number`,
            `第 ${index + 1} 个元素的 day_number 是 ${day.day_number}`,
          ),
        );
      }
    });
    return out;
  },

  /*
   * V-03：日期锚定到**请求的** start_date，而不是计划自己声明的 start_date。
   *
   * 这一点是 R-19 修订的核心。若以 `plan.start_date` 为锚，模型把出发日期
   * 整体写错一周时，各天日期与它自洽，28 条规则全部通过 ——
   * 用户拿到一份日期完全错误、但内部一致的计划。请求是唯一权威。
   *
   * 同时校验计划级的三个锚点字段（`start_date` / `end_date` / `total_days`）：
   * 3.2.1 原文没有任何规则约束它们，而 12.1 的页眉直接展示它们，
   * 于是会出现「页眉写 10 月，日卡写 4 月」。见设计稿修订 R-19。
   */
  'V-03': (plan, { normalized }) => {
    const out: PlanViolation[] = [];

    if (plan.start_date !== normalized.start_date) {
      out.push(
        violation(
          'V-03',
          'start_date',
          `计划出发日期 ${plan.start_date} 与请求 ${normalized.start_date} 不一致`,
        ),
      );
    }
    if (plan.end_date !== normalized.end_date) {
      out.push(
        violation(
          'V-03',
          'end_date',
          `计划返回日期 ${plan.end_date} 与请求 ${normalized.end_date} 不一致`,
        ),
      );
    }
    if (plan.total_days !== normalized.total_days) {
      out.push(
        violation(
          'V-03',
          'total_days',
          `计划天数 ${plan.total_days} 与请求 ${normalized.total_days} 不一致`,
        ),
      );
    }

    plan.days.forEach((day, index) => {
      const expected = dateForDay(normalized.start_date, day.day_number);
      if (day.date !== expected) {
        out.push(violation('V-03', `days[${index}].date`, `日期为 ${day.date}，应为 ${expected}`));
      }
    });

    return out;
  },

  /**
   * V-04：每日城市 **∈ 城市序列**（P9 从等值校验改为集合校验）。
   *
   * ## 为什么是集合而不是等值
   *
   * 规范 7 支持 1～5 个城市的多城行程，而原来这条规则要求每日 city 等于
   * `destination_name`（单个）。不改的话每一个多城行程的第 2～5 城的所有日子
   * 都会被判违规，然后被 V-04 的修复覆写成第一个城市 —— 一份「东京 + 京都」
   * 的行程会变成全程东京，而修复动作看起来完全正常。
   *
   * ## 单城行程的行为一字不变
   *
   * `planCities` 对没有 `cities` 的存量行退化成单元素序列，因此集合校验
   * 自动退化成原来的等值校验（见 `normalize.ts` 的 helper）。
   * 这条规则因此不需要区分「单城」与「多城」两个分支。
   */
  'V-04': (plan, { normalized }) => {
    const out: PlanViolation[] = [];
    const cities = planCities(normalized);
    const allowed = new Set(cities.map((city) => city.text));
    plan.days.forEach((day, index) => {
      if (!allowed.has(day.city)) {
        out.push(
          violation(
            'V-04',
            `days[${index}].city`,
            `城市为 ${day.city}，不在城市序列 ${[...allowed].join(' → ')} 之内`,
          ),
        );
      }
    });
    return out;
  },

  'V-05': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, index) => {
      if (day.schedule.length < 1) {
        out.push(violation('V-05', `days[${index}].schedule`, '当日没有任何行程条目'));
      }
    });
    return out;
  },

  'V-06': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      for (let i = 1; i < day.schedule.length; i += 1) {
        const prev = day.schedule[i - 1]!;
        const current = day.schedule[i]!;
        const prevStart = timeToMinutes(prev.start_time);
        const prevEnd = timeToMinutes(prev.end_time);
        const start = timeToMinutes(current.start_time);

        if (start < prevStart) {
          out.push(
            violation(
              'V-06',
              `days[${d}].schedule[${i}].start_time`,
              `${current.start_time} 早于上一条的 ${prev.start_time}`,
            ),
          );
        } else if (start < prevEnd) {
          out.push(
            violation(
              'V-06',
              `days[${d}].schedule[${i}].start_time`,
              `${current.start_time} 与上一条的结束时间 ${prev.end_time} 重叠`,
            ),
          );
        }
      }
    });
    return out;
  },

  'V-07': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      day.schedule.forEach((item, s) => {
        const start = timeToMinutes(item.start_time);
        const end = timeToMinutes(item.end_time);
        const path = `days[${d}].schedule[${s}].end_time`;

        if (end <= start) {
          out.push(
            violation('V-07', path, `结束时间 ${item.end_time} 不晚于开始时间 ${item.start_time}`),
          );
          return;
        }
        const drift = Math.abs(end - start - item.duration_minutes);
        if (drift > DURATION_TOLERANCE_MINUTES) {
          out.push(
            violation(
              'V-07',
              path,
              `时间差 ${end - start} 分钟与 duration_minutes ${item.duration_minutes} 相差 ${drift} 分钟`,
            ),
          );
        }
      });
    });
    return out;
  },

  'V-08': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      day.schedule.forEach((item, s) => {
        const { latitude, longitude } = item.location;
        const path = `days[${d}].schedule[${s}].location`;
        if (latitude !== null && (latitude < -90 || latitude > 90)) {
          out.push(violation('V-08', `${path}.latitude`, `纬度 ${latitude} 超出 [-90, 90]`));
        }
        if (longitude !== null && (longitude < -180 || longitude > 180)) {
          out.push(violation('V-08', `${path}.longitude`, `经度 ${longitude} 超出 [-180, 180]`));
        }
      });
    });
    return out;
  },

  'V-10': (plan, { normalized }) => {
    const { attractions_per_day_min: min, attractions_per_day_max: max } = normalized.pace;
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      const count = day.schedule.length;
      // 空行程由 V-05 以 BLOCKING 报出，这里不重复报「低于下限」
      if (count === 0) return;
      if (count > max) {
        out.push(violation('V-10', `days[${d}].schedule`, `${count} 条行程超过节奏上限 ${max} 条`));
      } else if (count < min) {
        out.push(violation('V-10', `days[${d}].schedule`, `${count} 条行程低于节奏下限 ${min} 条`));
      }
    });
    return out;
  },

  'V-11': (plan, { normalized }) => {
    const limit = effectiveWalkingLimitKm(normalized) * WALKING_TOLERANCE_RATIO;
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      const total = round2(day.schedule.reduce((acc, item) => acc + item.estimated_walking_km, 0));
      if (total > limit + MONEY_EPSILON) {
        out.push(
          violation(
            'V-11',
            `days[${d}].schedule`,
            `步行合计 ${total} 公里超过上限 ${round2(limit)} 公里（含 20% 容差）`,
          ),
        );
      }
    });
    return out;
  },

  'V-12': (plan, { normalized }) => {
    const earliest = timeToMinutes(normalized.pace.earliest_departure_time);
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      const first = day.schedule[0];
      if (first === undefined) return;
      if (timeToMinutes(first.start_time) < earliest) {
        out.push(
          violation(
            'V-12',
            `days[${d}].schedule[0].start_time`,
            `${first.start_time} 早于最早出发时间 ${normalized.pace.earliest_departure_time}`,
          ),
        );
      }
    });
    return out;
  },

  'V-13': (plan, { normalized }) => {
    const limitText = latestEndTime(normalized);
    const limit = timeToMinutes(limitText);
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      day.schedule.forEach((item, s) => {
        if (timeToMinutes(item.end_time) > limit) {
          out.push(
            violation(
              'V-13',
              `days[${d}].schedule[${s}].end_time`,
              `${item.end_time} 晚于当日上限 ${limitText}`,
            ),
          );
        }
      });
    });
    return out;
  },

  'V-14': (_plan, { normalized }) =>
    normalized.has_senior && normalized.pace.walking_limit_km > SENIOR_WALKING_LIMIT_KM
      ? [
          violation(
            'V-14',
            'pace.walking_limit_km',
            `同行有长者，步行上限由 ${normalized.pace.walking_limit_km} 公里收紧为 ${SENIOR_WALKING_LIMIT_KM} 公里`,
          ),
        ]
      : [],

  /*
   * V-20：预算内部自洽。
   *
   * 3.2.1 原文只要求「`daily_budget` 四项之和 = `breakdown[]` 之和」。
   * R-21 把它扩展到 `daily_budget.total` 与整个 `total_budget`：
   * 原文没有任何规则约束这两处，而 V-21/V-22 要拿总额跟用户预算比，
   * 12.1 的预算模块也直接展示它们。不约束的表现是模型随手写一个
   * `total_budget.total`，页面上显示的总价与各天明细加起来不是一个数。
   */
  'V-20': (plan) => {
    const derived = deriveBudget(plan);
    const out: PlanViolation[] = [];

    const differs = (actual: number, expected: number): boolean =>
      Math.abs(actual - expected) > MONEY_EPSILON;

    plan.days.forEach((day, d) => {
      const expected = derived.daily[d];
      if (expected === undefined) return;
      const budget = day.daily_budget;
      const fields = ['ticket', 'transport', 'meal', 'other', 'total'] as const;
      for (const field of fields) {
        if (differs(budget[field], expected[field])) {
          out.push(
            violation(
              'V-20',
              `days[${d}].daily_budget.${field}`,
              `${budget[field]} 与 breakdown 推导值 ${expected[field]} 不一致`,
            ),
          );
        }
      }
    });

    const totalChecks = [
      ['ticket', derived.ticket],
      ['transport', derived.transport],
      ['meal', derived.meal],
      ['other', derived.other],
      ['total', derived.total],
      ['per_person', derived.perPerson],
    ] as const;
    for (const [field, expected] of totalChecks) {
      if (differs(plan.total_budget[field], expected)) {
        out.push(
          violation(
            'V-20',
            `total_budget.${field}`,
            `${plan.total_budget[field]} 与各日明细推导值 ${expected} 不一致`,
          ),
        );
      }
    }

    /*
     * 两个可选字段是**子集**而不是新增项。
     *
     * 放在 V-20 而不是开一条 V-46：`PLAN_RULE_COUNT = 28` 对应 3.2.1 冻结的
     * 28 条，加一条要动冻结条款；而 V-20 的题目本来就是「预算分桶与明细自洽」，
     * 「往返大交通不能超过整个交通桶」正是这个题目下的一条。
     *
     * 不检查它会让 `comparableTotal` 算出负数总额 —— 而负数会让 V-22 报
     * 「低于预算下限」，把一处金额不一致指成一个完全无关的问题。
     */
    const subsetChecks = [
      ['intercity_transport', plan.total_budget.intercity_transport, 'transport', derived.transport],
      ['shopping', plan.total_budget.shopping, 'other', derived.other],
    ] as const;
    for (const [field, actual, parent, ceiling] of subsetChecks) {
      if (actual !== undefined && actual > ceiling + MONEY_EPSILON) {
        out.push(
          violation(
            'V-20',
            `total_budget.${field}`,
            `${actual} 超过它所属的 ${parent} 桶（${ceiling}）`,
          ),
        );
      }
      /* 负数金额同样是不一致。schema 只要求 finite，不要求非负 */
      if (actual !== undefined && actual < -MONEY_EPSILON) {
        out.push(violation('V-20', `total_budget.${field}`, `${actual} 是负数`));
      }
    }

    return out;
  },

  /*
   * V-21：总额不超预算上限。
   *
   * 3.2.1 的公式是 `sum(daily_budget 总额) × traveler_count`，它**不含住宿**
   * —— `BUDGET_BUCKET_VALUES` 没有住宿桶。而 `budget.included_items` 默认
   * 包含 `ACCOMMODATION`，用户给的上限是含住宿的。按原文实现的结果是：
   * 5 晚 1600 元住宿对这条规则完全不可见，超预算的计划照常放行。
   * 因此改用 `deriveBudget().total`（= 各日明细 × 人数 + 住宿），见 R-21。
   *
   * 那次改动假定「口径一定含住宿」。现在不再假定：口径由
   * `included_items` 说，`comparableTotal` 据它折算 —— 用户把住宿从口径里去掉
   * （已经订好、住亲友家）时，这条规则不再拿房费去撞他的上限。
   */
  'V-21': (plan, { normalized }) => {
    const ceiling = normalized.budget.total_max * BUDGET_MAX_TOLERANCE_RATIO;
    /*
     * 按用户口径折算后再比（见 `comparableTotal`）。口径默认含住宿，
     * 因此不改口径的请求走到的是与从前逐字相同的比较。
     */
    const total = comparableTotal(plan, normalized.budget.included_items);
    return total > ceiling + MONEY_EPSILON
      ? [
          violation(
            'V-21',
            'total_budget.total',
            `总额 ${total} 超过预算上限 ${normalized.budget.total_max} 的 110%（${round2(ceiling)}）`,
          ),
        ]
      : [];
  },

  'V-22': (plan, { normalized }) => {
    const floor = normalized.budget.total_min * BUDGET_MIN_RATIO;
    const total = comparableTotal(plan, normalized.budget.included_items);
    return total < floor - MONEY_EPSILON
      ? [
          violation(
            'V-22',
            'total_budget.total',
            `总额 ${total} 低于预算下限 ${normalized.budget.total_min} 的 60%（${round2(floor)}）`,
          ),
        ]
      : [];
  },

  /*
   * V-23：币种全文一致。
   *
   * V1 的 `CURRENCY_VALUES` 只有 `CNY`，因此本规则在当前枚举下不可能触发 ——
   * 与 N-10 的 `mode` 检查同类。仍然实现：币种一旦放宽（V2 支持境外目的地），
   * 这条检查会自动接管，不需要有人记得回来补。
   */
  'V-23': (plan, { normalized }) => {
    const expected: string = normalized.budget.currency;
    const out: PlanViolation[] = [];
    for (const slot of collectCurrencySlots(plan)) {
      const actual: string = slot.get();
      if (actual !== expected) {
        out.push(violation('V-23', slot.path, `币种为 ${actual}，请求为 ${expected}`));
      }
    }
    return out;
  },

  'V-24': (plan) => {
    const out: PlanViolation[] = [];
    for (const slot of collectAmountSlots(plan)) {
      const value = slot.get();
      if (value < 0) {
        out.push(violation('V-24', slot.path, `数值 ${value} 为负`));
        continue;
      }
      const scaled = value * 100;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
        out.push(violation('V-24', slot.path, `数值 ${value} 超过两位小数`));
      }
    }
    return out;
  },

  'V-30': (plan, { normalized }) => {
    const satisfied = satisfiedCodes(plan);
    const out: PlanViolation[] = [];
    normalized.must_conditions.forEach((condition, index) => {
      if (!satisfied.has(condition.code)) {
        out.push(
          violation(
            'V-30',
            `constraint_report.satisfied`,
            `硬约束 ${condition.code}（must_conditions[${index}]）未出现在 satisfied 中`,
          ),
        );
      }
    });
    return out;
  },

  'V-31': (plan) => {
    const out: PlanViolation[] = [];
    plan.constraint_report.violated.forEach((entry, index) => {
      if (entry.mode === 'MUST') {
        out.push(
          violation(
            'V-31',
            `constraint_report.violated[${index}]`,
            `硬约束 ${entry.code} 出现在 violated 中：${entry.reason}`,
          ),
        );
      }
    });
    return out;
  },

  'V-32': (plan, { normalized }) => {
    const total = normalized.should_conditions.length;
    if (total === 0) return [];

    const satisfied = satisfiedCodes(plan);
    const hit = normalized.should_conditions.filter((c) => satisfied.has(c.code)).length;
    const ratio = hit / total;

    return ratio < SHOULD_SATISFACTION_MIN_RATIO
      ? [
          violation(
            'V-32',
            'constraint_report.satisfied',
            `软约束满足 ${hit}/${total}（${Math.round(ratio * 100)}%），低于 ${SHOULD_SATISFACTION_MIN_RATIO * 100}%`,
          ),
        ]
      : [];
  },

  'V-33': (plan, { normalized }) => {
    if (!normalized.has_child) return [];
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      if (!day.schedule.some((item) => item.child_friendly)) {
        out.push(
          violation('V-33', `days[${d}].schedule`, '同行有儿童，但当日没有标注适合儿童的安排'),
        );
      }
    });
    return out;
  },

  'V-40': (plan) => {
    const out: PlanViolation[] = [];
    const check = (path: string, text: string, max: number): void => {
      if ([...text].length > max) {
        out.push(violation('V-40', path, `长度 ${[...text].length} 超过 ${max} 字`));
      }
    };

    check('title', plan.title, TITLE_MAX_CHARS);
    plan.days.forEach((day, d) => {
      check(`days[${d}].theme`, day.theme, THEME_MAX_CHARS);
      check(`days[${d}].subtitle`, day.subtitle, SUBTITLE_MAX_CHARS);
    });
    return out;
  },

  'V-41': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      const list = day.food_recommendations;
      const path = `days[${d}].food_recommendations`;

      if (list.length < FOOD_MIN_PER_DAY) {
        out.push(violation('V-41', path, `美食推荐 ${list.length} 条少于 ${FOOD_MIN_PER_DAY} 条`));
      } else if (list.length > FOOD_MAX_PER_DAY) {
        out.push(violation('V-41', path, `美食推荐 ${list.length} 条超过 ${FOOD_MAX_PER_DAY} 条`));
      }

      const seen = new Set<string>();
      list.forEach((food, f) => {
        if (seen.has(food.meal)) {
          out.push(violation('V-41', `${path}[${f}].meal`, `餐次 ${food.meal} 重复`));
        }
        seen.add(food.meal);
      });
    });
    return out;
  },

  'V-42': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      const names = new Set(day.schedule.map((item) => item.location.name));
      day.photo_spots.forEach((spot, p) => {
        if (!names.has(spot.entity_name)) {
          out.push(
            violation(
              'V-42',
              `days[${d}].photo_spots[${p}].entity_name`,
              `${spot.entity_name} 不在当日行程地点中`,
            ),
          );
        }
      });
    });
    return out;
  },

  'V-43': (plan) => {
    const out: PlanViolation[] = [];
    plan.days.forEach((day, d) => {
      day.route_recommendations.forEach((route, r) => {
        if (route.nodes.length < MIN_ROUTE_NODES) {
          out.push(
            violation(
              'V-43',
              `days[${d}].route_recommendations[${r}].nodes`,
              `节点数 ${route.nodes.length} 少于 ${MIN_ROUTE_NODES}`,
            ),
          );
        }
      });
    });
    return out;
  },

  /*
   * V-44：空串、占位词与 Markdown 残留。
   *
   * 「无 `null` 必填字段」在这里表现为**空串**：真正的 `null` 已经被
   * `TravelPlanContentSchema` 拦在外面（本模块的输入必然已通过 schema），
   * 而模型把某字段填成 `""` 或 `"null"` 是 schema 拦不住的。
   *
   * 三档处理：
   *   - 必填字段**清洗后无有效内容**（`"   "`、`"**"`、`"null"`）→ 升级为
   *     `BLOCKING`。程序化修复无从下手 —— 编造一个地名比留空更糟 ——
   *     只能交给第二级重生成。判据用清洗后的结果而不是原文，
   *     否则 `"**"` 会被判成「含 Markdown」的 REPAIRABLE，而清洗它得到空串，
   *     于是修复要么写出非法的空必填字段，要么原地不动、每轮重复报同一条。
   *   - 可空字段为纯空白 → `REPAIRABLE`，归一化为空串。
   *   - 可空字段本就是空串 → **不报**。`subtitle`、`description` 允许为空
   *     （schema 用的是 `z.string()`），把它们一律当违规会让每份计划都带上
   *     一串修不掉的 REPAIRABLE，真正重要的假设反而被噪音埋掉。
   */
  'V-44': (plan) => {
    const out: PlanViolation[] = [];
    for (const slot of collectStringSlots(plan)) {
      const value = slot.get();

      if (slot.required && normalizeText(value).length === 0) {
        out.push(violation('V-44', slot.path, '必填字段清洗后无有效内容', 'BLOCKING'));
        continue;
      }
      if (!slot.required && value.length > 0 && value.trim().length === 0) {
        out.push(violation('V-44', slot.path, '字段为纯空白字符串'));
        continue;
      }
      if (PLACEHOLDER_PATTERN.test(value)) {
        out.push(violation('V-44', slot.path, `含占位词：${value}`));
        continue;
      }
      if (MARKDOWN_PATTERNS.some((pattern) => pattern.test(value))) {
        out.push(violation('V-44', slot.path, `含 Markdown 标记：${value}`));
        continue;
      }
      if (value !== value.trim()) {
        out.push(violation('V-44', slot.path, '含首尾空白'));
      }
    }
    return out;
  },

  'V-45': (plan) => {
    const out: PlanViolation[] = [];
    for (const slot of collectStringSlots(plan)) {
      const value = slot.get();
      if (URL_PATTERN.test(value)) {
        out.push(violation('V-45', slot.path, `含 URL：${value}`));
        continue;
      }
      if (ANGLE_BRACKET_PATTERN.test(value)) {
        out.push(violation('V-45', slot.path, `含尖括号或 HTML 标签：${value}`));
      }
    }
    return out;
  },
};

/**
 * 执行全部 28 条规则。
 *
 * 按 `PLAN_RULE_IDS` 的顺序返回，因此结果稳定可断言 ——
 * 顺序随机的话，「第一条违规」在不同运行里会不同，
 * 而 3.2.2 的第二级重生成会把违规清单发给模型，清单顺序影响模型的关注点。
 */
export function validatePlan(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
): readonly PlanViolation[] {
  const out: PlanViolation[] = [];
  for (const rule of PLAN_RULE_IDS) {
    out.push(...RULE_CHECKS[rule](plan, ctx));
  }
  return out;
}

/** 是否存在阻断级违规 —— 3.2.2 的终止条件 */
export function hasBlocking(violations: readonly PlanViolation[]): boolean {
  return violations.some((v) => v.severity === 'BLOCKING');
}

export function violationsBySeverity(
  violations: readonly PlanViolation[],
  severity: ViolationSeverity,
): readonly PlanViolation[] {
  return violations.filter((v) => v.severity === severity);
}
