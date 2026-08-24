import type { SatisfiedConstraint, TravelPlan, ViolationSeverity } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import type { RequestFixtureOverrides } from './fixtures.js';
import { makeValidContext, makeValidPlan } from './plan-fixtures.js';
import {
  PLAN_RULES,
  PLAN_RULE_COUNT,
  PLAN_RULE_IDS,
  TITLE_MAX_CHARS,
  deriveBudget,
  effectiveWalkingLimitKm,
  latestEndTime,
  validatePlan,
  type PlanRuleId,
} from './plan-rules.js';

/**
 * 3.2.1 的 28 条业务规则（TP-2-12）。
 *
 * 验收要求是「每条规则 1 个违规用例 + 1 个通过用例 = ≥ 56 个用例」。
 * 覆盖率不靠人工清点，而由本文件末尾的穷尽性断言保证：
 * `PLAN_RULE_IDS` 里每个 id 都必须在两张表里各出现至少一次，
 * 漏一条是测试失败而不是「少了两个用例但没人发现」。
 *
 * ## 违规用例只断言「该规则被报出」，不断言「只报这一条」
 *
 * 一处改动常常真的会触发两条规则 —— 删掉一天会让 V-01（天数不符）与
 * V-20（总额与各日明细不符）同时成立，那不是测试的缺陷而是规则集的正确行为。
 * 强求「只报一条」会逼着测试去构造不自然的输入，或者更糟：
 * 逼着实现去互相屏蔽，而屏蔽掉的那条正是修复阶段需要看到的。
 *
 * 精度由 `path` 断言提供：它确认报出的是**这个字段**的问题，
 * 而不是碰巧同一条规则在别处触发。
 */

/**
 * 可任意改写的计划。
 *
 * 交集 `Record<string, any>` 而不是直接用 `any`：`any` 传给 `validatePlan`
 * 会触发 `no-unsafe-argument`，而且会让所有字段访问失去补全 ——
 * 构造违规用例时最容易犯的错就是改错字段名，那样测试会「通过」
 * （规则没报违规，因为输入其实合法），却什么都没验证到。
 */
type MutablePlan = TravelPlan & Record<string, any>;

function base(): MutablePlan {
  return makeValidPlan();
}

interface ViolationCase {
  readonly rule: PlanRuleId;
  readonly name: string;
  /** 请求侧覆写（V-14/V-21/V-22/V-32/V-33 的违规必须从请求侧构造） */
  readonly request?: RequestFixtureOverrides;
  readonly mutate?: (plan: MutablePlan) => void;
  /** 期望报出的字段路径。留空表示只断言规则被报出 */
  readonly path?: string;
  /** 期望的级别，默认取 `PLAN_RULES` 声明值（仅 V-44 会升级） */
  readonly severity?: ViolationSeverity;
}

interface PassCase {
  readonly rule: PlanRuleId;
  readonly name: string;
  readonly request?: RequestFixtureOverrides;
  readonly mutate?: (plan: MutablePlan) => void;
}

// ── 违规用例 ────────────────────────────────────────────────

const VIOLATION_CASES: readonly ViolationCase[] = [
  {
    rule: 'V-01',
    name: '少一天',
    mutate: (plan) => {
      plan.days.pop();
    },
    path: 'days',
  },
  {
    rule: 'V-02',
    name: 'day_number 跳号',
    mutate: (plan) => {
      plan.days[2]!.day_number = 9;
    },
    path: 'days[2].day_number',
  },
  {
    rule: 'V-03',
    name: '某天日期错位',
    mutate: (plan) => {
      plan.days[1]!.date = '2026-05-01';
    },
    path: 'days[1].date',
  },
  {
    /*
     * R-19 的核心用例：模型把整趟行程的出发日期写错一周。
     * 各天日期与它自洽，若 V-03 以 plan.start_date 为锚就一条都报不出来 ——
     * 用户拿到一份日期完全错误、内部却完全一致的计划。
     */
    rule: 'V-03',
    name: '计划级出发日期与请求不一致（R-19）',
    mutate: (plan) => {
      plan.start_date = '2026-04-17';
    },
    path: 'start_date',
  },
  {
    rule: 'V-04',
    name: '城市不是目的地',
    mutate: (plan) => {
      plan.days[0]!.city = '苏州';
    },
    path: 'days[0].city',
  },
  {
    rule: 'V-05',
    name: '某天没有行程',
    mutate: (plan) => {
      plan.days[0]!.schedule = [];
    },
    path: 'days[0].schedule',
  },
  {
    rule: 'V-06',
    name: '时间倒序',
    mutate: (plan) => {
      const schedule = plan.days[0]!.schedule;
      const [first, second] = [schedule[0]!, schedule[1]!];
      schedule[0] = second;
      schedule[1] = first;
    },
    path: 'days[0].schedule[1].start_time',
  },
  {
    rule: 'V-06',
    name: '时间区间重叠',
    mutate: (plan) => {
      // 第二条提前到第一条结束之前，制造重叠而不改变顺序
      const item = plan.days[0]!.schedule[1]!;
      item.start_time = '11:00';
      item.end_time = '12:30';
      item.duration_minutes = 90;
    },
    path: 'days[0].schedule[1].start_time',
  },
  {
    rule: 'V-07',
    name: 'duration 与时间差不符',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.duration_minutes = 40;
    },
    path: 'days[0].schedule[0].end_time',
  },
  {
    rule: 'V-07',
    name: '结束时间早于开始时间',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.end_time = '08:00';
    },
    path: 'days[0].schedule[0].end_time',
  },
  {
    rule: 'V-08',
    name: '纬度越界',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.location.latitude = 91;
    },
    path: 'days[0].schedule[0].location.latitude',
  },
  {
    rule: 'V-10',
    name: '景点数超上限',
    mutate: (plan) => {
      const schedule = plan.days[0]!.schedule;
      schedule.push(structuredClone(schedule[0]!));
    },
    path: 'days[0].schedule',
  },
  {
    rule: 'V-10',
    name: '景点数低于下限',
    mutate: (plan) => {
      plan.days[0]!.schedule.splice(1, 2);
    },
    path: 'days[0].schedule',
  },
  {
    rule: 'V-11',
    name: '步行距离超上限',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_walking_km = 10;
    },
    path: 'days[0].schedule',
  },
  {
    rule: 'V-12',
    name: '首条早于最早出发时间',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[0]!;
      item.start_time = '07:00';
      item.end_time = '09:30';
    },
    path: 'days[0].schedule[0].start_time',
  },
  {
    rule: 'V-13',
    name: '结束过晚',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[2]!;
      item.start_time = '21:00';
      item.end_time = '23:00';
      item.duration_minutes = 120;
    },
    path: 'days[0].schedule[2].end_time',
  },
  {
    rule: 'V-14',
    name: '同行有长者但步行上限未收紧',
    request: { travelers: { seniors: [{ age: 70 }] } },
    path: 'pace.walking_limit_km',
  },
  {
    rule: 'V-20',
    name: '日预算分桶与明细不符',
    mutate: (plan) => {
      plan.days[0]!.daily_budget.meal = 999;
    },
    path: 'days[0].daily_budget.meal',
  },
  {
    /*
     * R-21 的核心用例：3.2.1 原文只约束 daily_budget 的四项，
     * total_budget 完全没有规则覆盖。模型随手写一个总额，页面上显示的
     * 总价与各天明细加起来不是一个数，而 28 条规则一条都不报。
     */
    rule: 'V-20',
    name: '总预算与各日明细不符（R-21）',
    mutate: (plan) => {
      plan.total_budget.total = 99_999;
    },
    path: 'total_budget.total',
  },
  {
    rule: 'V-21',
    name: '总额超预算上限',
    request: { budget: { min: 100, max: 101 } },
    path: 'total_budget.total',
  },
  {
    rule: 'V-22',
    name: '总额低于预算下限的 60%',
    request: { budget: { min: 2_000, max: 4_000 } },
    path: 'total_budget.total',
  },
  {
    rule: 'V-23',
    name: '某处币种不一致',
    mutate: (plan) => {
      // 币种枚举当前只有 CNY，非法值必须绕过类型系统才构造得出来
      (plan.days[0]!.daily_budget as Record<string, unknown>)['currency'] = 'USD';
    },
    path: 'days[0].daily_budget.currency',
  },
  {
    rule: 'V-24',
    name: '金额为负',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_cost.amount = -5;
    },
    path: 'days[0].schedule[0].estimated_cost.amount',
  },
  {
    rule: 'V-24',
    name: '金额超过两位小数',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_cost.amount = 12.345;
    },
    path: 'days[0].schedule[0].estimated_cost.amount',
  },
  {
    rule: 'V-24',
    name: '步行距离为负（R-22）',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_walking_km = -1.2;
    },
    path: 'days[0].schedule[0].estimated_walking_km',
  },
  {
    rule: 'V-30',
    name: '硬约束未出现在 satisfied',
    mutate: (plan) => {
      plan.constraint_report.satisfied = plan.constraint_report.satisfied.filter(
        (entry) => entry.mode !== 'MUST',
      );
    },
    path: 'constraint_report.satisfied',
  },
  {
    rule: 'V-31',
    name: 'violated 中出现硬约束',
    mutate: (plan) => {
      plan.constraint_report.violated.push({
        code: 'accommodation.elevator',
        mode: 'MUST',
        reason: '目的地该区域无带电梯的房源。',
        severity: 'BLOCKING',
      });
    },
    path: 'constraint_report.violated[0]',
  },
  {
    rule: 'V-32',
    name: '软约束满足率低于 60%',
    request: {
      conditions: [
        { code: 'interest.history_culture', mode: 'SHOULD', value: true },
        { code: 'interest.nature', mode: 'SHOULD', value: true },
        { code: 'interest.food', mode: 'SHOULD', value: true },
        { code: 'interest.shopping', mode: 'SHOULD', value: true },
        { code: 'interest.photography', mode: 'SHOULD', value: true },
        { code: 'accommodation.elevator', mode: 'MUST', value: true },
      ],
    },
    path: 'constraint_report.satisfied',
  },
  {
    rule: 'V-33',
    name: '有儿童但当日无适合儿童的安排',
    mutate: (plan) => {
      for (const item of plan.days[0]!.schedule) {
        item.child_friendly = false;
      }
    },
    path: 'days[0].schedule',
  },
  {
    rule: 'V-40',
    name: '标题超长',
    mutate: (plan) => {
      plan.title = '一'.repeat(TITLE_MAX_CHARS + 1);
    },
    path: 'title',
  },
  {
    rule: 'V-41',
    name: '餐次重复',
    mutate: (plan) => {
      plan.days[0]!.food_recommendations[1]!.meal = 'BREAKFAST';
    },
    path: 'days[0].food_recommendations[1].meal',
  },
  {
    rule: 'V-42',
    name: '拍照机位对不上当日地点',
    mutate: (plan) => {
      plan.days[0]!.photo_spots[0]!.entity_name = '雷峰塔';
    },
    path: 'days[0].photo_spots[0].entity_name',
  },
  {
    rule: 'V-43',
    name: '路线只有一个节点',
    mutate: (plan) => {
      plan.days[0]!.route_recommendations[0]!.nodes = ['拱宸桥'];
    },
    path: 'days[0].route_recommendations[0].nodes',
  },
  {
    rule: 'V-44',
    name: 'Markdown 残留',
    mutate: (plan) => {
      plan.days[0]!.theme = '**运河人文**';
    },
    path: 'days[0].theme',
  },
  {
    rule: 'V-44',
    name: '必填字段清洗后无内容（升级为 BLOCKING）',
    mutate: (plan) => {
      /*
       * 纯空白连 `NonEmptyStringSchema` 都过不去，因此业务规则这一层看不到；
       * 真正会漏进来的是「看着有内容、清洗后什么都不剩」的值。
       */
      plan.days[0]!.schedule[0]!.location.name = 'null';
    },
    path: 'days[0].schedule[0].location.name',
    severity: 'BLOCKING',
  },
  {
    rule: 'V-44',
    name: '占位词进了文案',
    mutate: (plan) => {
      plan.days[0]!.daily_summary = '今天前往undefined，傍晚返回。';
    },
    path: 'days[0].daily_summary',
  },
  {
    rule: 'V-45',
    name: '正文含 URL',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.description = '详见 https://example.com/opening';
    },
    path: 'days[0].schedule[0].description',
  },
  {
    rule: 'V-45',
    name: '正文含 HTML 标签',
    mutate: (plan) => {
      plan.summary = '<b>杭州</b>五日游';
    },
    path: 'summary',
  },
];

// ── 通过用例（尽量取边界值，而不是重复检查基准 fixture）────────

const PASS_CASES: readonly PassCase[] = [
  { rule: 'V-01', name: '天数与请求一致' },
  { rule: 'V-02', name: '天号连续' },
  { rule: 'V-03', name: '日期与请求锚点一致' },
  { rule: 'V-04', name: '城市与目的地一致' },
  { rule: 'V-05', name: '每天都有行程' },
  {
    rule: 'V-06',
    name: '首尾相接不算重叠',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[1]!;
      item.start_time = '12:00';
      item.end_time = '13:30';
      item.duration_minutes = 90;
    },
  },
  {
    rule: 'V-07',
    name: '偏差恰好等于 5 分钟容差',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.duration_minutes = 145;
    },
  },
  {
    rule: 'V-08',
    name: '纬度恰好在边界上',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.location.latitude = 90;
      plan.days[0]!.schedule[0]!.location.longitude = -180;
    },
  },
  {
    rule: 'V-08',
    name: '坐标为 null 不算越界',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.location.latitude = null;
      plan.days[0]!.schedule[0]!.location.longitude = null;
    },
  },
  { rule: 'V-10', name: '景点数恰好等于上限' },
  {
    rule: 'V-11',
    name: '步行距离恰好用满 20% 容差',
    mutate: (plan) => {
      const schedule = plan.days[0]!.schedule;
      // 上限 5 公里 × 1.2 = 6.0，把总和精确凑到 6.0
      schedule[0]!.estimated_walking_km = 3.6;
      schedule[1]!.estimated_walking_km = 1.8;
      schedule[2]!.estimated_walking_km = 0.6;
    },
  },
  {
    rule: 'V-12',
    name: '首条恰好等于最早出发时间',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[0]!;
      item.start_time = '09:00';
      item.end_time = '11:30';
    },
  },
  {
    rule: 'V-13',
    name: '恰好在当日上限结束',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[2]!;
      item.start_time = '20:00';
      item.end_time = '21:00';
      item.duration_minutes = 60;
    },
  },
  { rule: 'V-14', name: '无长者时不收紧' },
  { rule: 'V-20', name: '预算分桶与明细自洽' },
  {
    /*
     * 这条用例的价值在于：它**只靠 +10% 容差通过**。
     * 总额 3175 元，预算上限 3000 元 —— 去掉容差就是违规。
     * 容差被误删或写成 +1% 时，这条会失败。
     */
    rule: 'V-21',
    name: '超出预算但仍在 10% 容差内',
    request: { budget: { min: 100, max: 200 } },
  },
  { rule: 'V-22', name: '总额在预算下限的 60% 以上' },
  { rule: 'V-23', name: '全文币种一致' },
  {
    rule: 'V-24',
    name: '恰好两位小数',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_cost.amount = 12.34;
    },
  },
  { rule: 'V-30', name: '硬约束已在 satisfied 中' },
  {
    rule: 'V-31',
    name: 'violated 中只有软约束',
    mutate: (plan) => {
      plan.constraint_report.violated.push({
        code: 'interest.shopping',
        mode: 'SHOULD',
        reason: '行程以人文为主，未安排购物。',
        severity: 'ADVISORY',
      });
    },
  },
  {
    rule: 'V-32',
    name: '满足率恰好 60%',
    request: {
      conditions: [
        { code: 'interest.history_culture', mode: 'SHOULD', value: true },
        { code: 'interest.nature', mode: 'SHOULD', value: true },
        { code: 'interest.food', mode: 'SHOULD', value: true },
        { code: 'interest.shopping', mode: 'SHOULD', value: true },
        { code: 'interest.photography', mode: 'SHOULD', value: true },
        { code: 'accommodation.elevator', mode: 'MUST', value: true },
      ],
    },
    mutate: (plan) => {
      const extra: SatisfiedConstraint[] = [
        { code: 'interest.nature', mode: 'SHOULD', evidence: '安排了山径与茶山。' },
        { code: 'interest.food', mode: 'SHOULD', evidence: '每日安排本地餐饮。' },
      ];
      plan.constraint_report.satisfied.push(...extra);
    },
  },
  {
    rule: 'V-33',
    name: '无儿童时不检查',
    request: { travelers: { adults: 2, children: [], seniors: [] } },
    mutate: (plan) => {
      for (const day of plan.days) {
        for (const item of day.schedule) {
          item.child_friendly = false;
        }
      }
    },
  },
  {
    rule: 'V-40',
    name: '标题恰好等于限长',
    mutate: (plan) => {
      plan.title = '一'.repeat(TITLE_MAX_CHARS);
    },
  },
  {
    rule: 'V-41',
    name: '4 条且餐次互不相同',
    mutate: (plan) => {
      plan.days[0]!.food_recommendations.push({
        meal: 'SNACK',
        name: '定胜糕',
        description: '街头小食，适合下午垫一垫。',
        entity_type: 'DISH',
      });
    },
  },
  { rule: 'V-42', name: '拍照机位都能对上地点' },
  {
    rule: 'V-43',
    name: '路线恰好两个节点',
    mutate: (plan) => {
      plan.days[0]!.route_recommendations[0]!.nodes = ['拱宸桥', '大兜路'];
    },
  },
  {
    rule: 'V-44',
    name: '中文标点与间隔号不算 Markdown',
    mutate: (plan) => {
      plan.days[0]!.theme = '运河人文·古今交融';
      plan.days[0]!.subtitle = '在水巷与博物馆之间（约 3 小时）慢慢读';
    },
  },
  {
    rule: 'V-45',
    name: '不含协议头与尖括号的正文',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.description = '开放时间见馆内公告，建议提前一天预约。';
    },
  },
];

// ── 断言 ────────────────────────────────────────────────────

describe('基准配对', () => {
  it('零违规', () => {
    /*
     * 这条先于其余全部用例：基准若本身有违规，
     * 28 个通过用例会全部因为无关原因失败，而 28 个违规用例会「通过」——
     * 那时最容易得出的错误结论是「规则实现是对的」。
     */
    expect(validatePlan(base(), makeValidContext())).toEqual([]);
  });

  it('deriveBudget 与 fixture 的 total_budget 完全一致', () => {
    const plan = base();
    const derived = deriveBudget(plan);
    expect({
      ticket: plan.total_budget.ticket,
      transport: plan.total_budget.transport,
      meal: plan.total_budget.meal,
      other: plan.total_budget.other,
      total: plan.total_budget.total,
      per_person: plan.total_budget.per_person,
    }).toEqual({
      ticket: derived.ticket,
      transport: derived.transport,
      meal: derived.meal,
      other: derived.other,
      total: derived.total,
      per_person: derived.perPerson,
    });
  });
});

describe('规则表', () => {
  it('冻结 28 条', () => {
    expect(PLAN_RULE_IDS).toHaveLength(PLAN_RULE_COUNT);
    expect(new Set(PLAN_RULE_IDS).size).toBe(PLAN_RULE_COUNT);
  });

  it('每条规则都有级别与标题', () => {
    for (const rule of PLAN_RULE_IDS) {
      expect(PLAN_RULES[rule].title.length, `${rule} 缺标题`).toBeGreaterThan(0);
      expect(['BLOCKING', 'REPAIRABLE', 'ADVISORY']).toContain(PLAN_RULES[rule].severity);
    }
  });

  it('3.2.1 的级别逐条正确', () => {
    // 表驱动比对：级别写错的后果是分级失效 —— 把 ADVISORY 写成 BLOCKING
    // 会让「低于预算下限」这种小事直接让任务失败
    const actual = Object.fromEntries(PLAN_RULE_IDS.map((r) => [r, PLAN_RULES[r].severity]));
    expect(actual).toEqual({
      'V-01': 'BLOCKING',
      'V-02': 'BLOCKING',
      'V-03': 'BLOCKING',
      'V-04': 'REPAIRABLE',
      'V-05': 'BLOCKING',
      'V-06': 'REPAIRABLE',
      'V-07': 'REPAIRABLE',
      'V-08': 'REPAIRABLE',
      'V-10': 'REPAIRABLE',
      'V-11': 'REPAIRABLE',
      'V-12': 'REPAIRABLE',
      'V-13': 'REPAIRABLE',
      'V-14': 'ADVISORY',
      'V-20': 'REPAIRABLE',
      'V-21': 'REPAIRABLE',
      'V-22': 'ADVISORY',
      'V-23': 'BLOCKING',
      'V-24': 'REPAIRABLE',
      'V-30': 'BLOCKING',
      'V-31': 'BLOCKING',
      'V-32': 'ADVISORY',
      'V-33': 'ADVISORY',
      'V-40': 'REPAIRABLE',
      'V-41': 'REPAIRABLE',
      'V-42': 'REPAIRABLE',
      'V-43': 'REPAIRABLE',
      'V-44': 'REPAIRABLE',
      'V-45': 'REPAIRABLE',
    });
  });

  it('28 条规则每条都有违规用例与通过用例', () => {
    // 这是「≥ 56 个用例」的机器化表达
    for (const rule of PLAN_RULE_IDS) {
      expect(
        VIOLATION_CASES.some((c) => c.rule === rule),
        `${rule} 缺违规用例`,
      ).toBe(true);
      expect(
        PASS_CASES.some((c) => c.rule === rule),
        `${rule} 缺通过用例`,
      ).toBe(true);
    }
    expect(VIOLATION_CASES.length + PASS_CASES.length).toBeGreaterThanOrEqual(56);
  });
});

describe('违规用例', () => {
  it.each(VIOLATION_CASES)('$rule $name', ({ rule, request, mutate, path, severity }) => {
    const plan = base();
    mutate?.(plan);

    const violations = validatePlan(plan, makeValidContext(request ?? {}));
    const own = violations.filter((v) => v.rule === rule);

    expect(own.length, `${rule} 未报出违规`).toBeGreaterThan(0);
    if (path !== undefined) {
      expect(own.map((v) => v.path)).toContain(path);
    }
    expect(own[0]!.severity).toBe(severity ?? PLAN_RULES[rule].severity);
    expect(own[0]!.detail.length).toBeGreaterThan(0);
  });
});

describe('通过用例', () => {
  it.each(PASS_CASES)('$rule $name', ({ rule, request, mutate }) => {
    const plan = base();
    mutate?.(plan);

    const violations = validatePlan(plan, makeValidContext(request ?? {}));
    expect(violations.filter((v) => v.rule === rule)).toEqual([]);
  });
});

describe('派生量', () => {
  it('有长者时步行上限收紧到 4 公里', () => {
    const withSenior = makeValidContext({ travelers: { seniors: [{ age: 70 }] } }).normalized;
    expect(effectiveWalkingLimitKm(withSenior)).toBe(4);
  });

  it('长者上限只收紧不放宽', () => {
    // 用户自己选了 3 公里时不该被「收紧到 4」反而放宽
    const ctx = makeValidContext({
      travelers: { seniors: [{ age: 70 }] },
      pace: { walking_limit_km: 3 },
    }).normalized;
    expect(effectiveWalkingLimitKm(ctx)).toBe(3);
  });

  it('自由文本含「不要太晚」时收紧到 21:00', () => {
    // 请求 fixture 的自由文本本身就含「晚上不要太晚」
    expect(latestEndTime(makeValidContext().normalized)).toBe('21:00');
  });

  it('自由文本无相关表述时用 22:00', () => {
    const ctx = makeValidContext({
      custom_requirements: { raw_text: '希望多安排博物馆。' },
      conditions: [{ code: 'interest.history_culture', mode: 'SHOULD', value: true }],
    }).normalized;
    expect(latestEndTime(ctx)).toBe('22:00');
  });

  it('勾选 schedule.no_late_night 即收紧，无需自由文本（R-23）', () => {
    /*
     * 5.1 的条件字典里本来就有这个 code。按 3.2.1 的字面实现只看自由文本，
     * 用户勾了复选框却没再写一遍文字时，V-13 会完全忽略他的要求。
     */
    const ctx = makeValidContext({
      custom_requirements: { raw_text: '希望多安排博物馆。' },
      conditions: [{ code: 'schedule.no_late_night', mode: 'MUST', value: true }],
    }).normalized;
    expect(latestEndTime(ctx)).toBe('21:00');
  });
});

/**
 * V-04 从等值校验改为集合校验（P9，规范 7 的多城市）。
 *
 * 不改的话每一个多城行程的第 2～5 城的所有日子都会被判违规，然后被 V-04 的
 * 修复覆写成第一个城市 —— 一份「东京 + 京都」的行程会变成全程东京，
 * 而修复动作看起来完全正常。
 */
describe('V-04 每日城市属于城市序列（P9）', () => {
  const multiCityContext = () => {
    const base = makeValidContext();
    return {
      ...base,
      normalized: {
        ...base.normalized,
        cities: [{ text: base.normalized.destination_name }, { text: '苏州' }],
      },
    };
  };

  it('多城时第二城的日子不再违规', () => {
    const plan = makeValidPlan();
    plan.days[1]!.city = '苏州';
    expect(validatePlan(plan, multiCityContext()).map((v) => v.rule)).not.toContain('V-04');
  });

  it('序列外的城市仍然违规，且错误消息列出序列', () => {
    const plan = makeValidPlan();
    plan.days[1]!.city = '南京';
    const violations = validatePlan(plan, multiCityContext()).filter((v) => v.rule === 'V-04');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('days[1].city');
    expect(violations[0]?.detail).toContain('苏州');
  });

  it('单城行程的行为一字不变 —— 集合退化成等值', () => {
    /*
     * `planCities` 对没有 `cities` 的存量行退化成单元素序列，
     * 因此这条规则不需要区分「单城」与「多城」两个分支。
     */
    const plan = makeValidPlan();
    plan.days[0]!.city = '苏州';
    expect(validatePlan(plan, makeValidContext()).map((v) => v.rule)).toContain('V-04');

    const clean = makeValidPlan();
    expect(validatePlan(clean, makeValidContext()).map((v) => v.rule)).not.toContain('V-04');
  });
});
