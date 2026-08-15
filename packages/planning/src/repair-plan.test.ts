import { TravelPlanSchema, type TravelPlan } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import type { RequestFixtureOverrides } from './fixtures.js';
import { makeValidContext, makeValidPlan } from './plan-fixtures.js';
import {
  TITLE_MAX_CHARS,
  deriveBudget,
  validatePlan,
  type PlanRuleId,
  type PlanValidationContext,
} from './plan-rules.js';
import { MIN_SCHEDULE_MINUTES, repairPlan } from './repair-plan.js';

/**
 * 第一级程序化修复（TP-2-13，设计稿 3.2.2）。
 *
 * 两类断言：
 *   1. **表驱动**：每条规则的违规输入过一遍修复后，该规则是否消失。
 *      「不该消失」的同样写进表里 —— 3.2.2 明确第一级只处理 `REPAIRABLE`
 *      与结构类 `BLOCKING`，V-05/V-30/V-31 必须留给第二级。若某天有人给
 *      V-30 加了个「往 satisfied 里补一条」的修复，这张表会立刻失败，
 *      而那种修复是**伪造证据**：约束没被满足，只是报告里写了满足。
 *   2. **逐条行为**：修复得对不对。「V-11 删掉了一条」不等于「删对了」——
 *      删掉步行最短的那条同样能让总和下降，但那是把行程里最省力的部分删了。
 */

type MutablePlan = TravelPlan & Record<string, any>;

const MAX_ROUNDS = 3;

/** 跑到不动点或轮次上限，返回最终计划与实际轮数 */
function repairToFixedPoint(
  plan: MutablePlan,
  ctx: PlanValidationContext,
): { plan: MutablePlan; rounds: number } {
  let current = plan;
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    const result = repairPlan(current, ctx);
    rounds += 1;
    current = result.plan;
    if (!result.changed) break;
  }

  return { plan: current, rounds };
}

interface RepairCase {
  readonly rule: PlanRuleId;
  readonly name: string;
  readonly request?: RequestFixtureOverrides;
  readonly mutate: (plan: MutablePlan) => void;
  /** 第一级修复后该规则是否应当消失 */
  readonly resolved: boolean;
}

const CASES: readonly RepairCase[] = [
  {
    rule: 'V-01',
    name: '多一天 → 截断尾部',
    mutate: (plan) => {
      plan.days.push(structuredClone(plan.days[4]!));
    },
    resolved: true,
  },
  {
    rule: 'V-01',
    name: '少一天 → 只能交给第二级补生成',
    mutate: (plan) => {
      plan.days.pop();
    },
    resolved: false,
  },
  {
    rule: 'V-02',
    name: '天号跳号 → 重编号',
    mutate: (plan) => {
      plan.days[2]!.day_number = 9;
    },
    resolved: true,
  },
  {
    rule: 'V-03',
    name: '日期错位 → 按天号重算',
    mutate: (plan) => {
      plan.days[1]!.date = '2026-05-01';
    },
    resolved: true,
  },
  {
    rule: 'V-03',
    name: '计划级出发日期错误 → 覆写为请求值',
    mutate: (plan) => {
      plan.start_date = '2026-04-17';
    },
    resolved: true,
  },
  {
    rule: 'V-04',
    name: '城市不符 → 覆写为目的地',
    mutate: (plan) => {
      plan.days[0]!.city = '苏州';
    },
    resolved: true,
  },
  {
    rule: 'V-05',
    name: '空行程 → 只能交给第二级补生成',
    mutate: (plan) => {
      plan.days[0]!.schedule = [];
    },
    resolved: false,
  },
  {
    rule: 'V-06',
    name: '时间倒序 → 重排',
    mutate: (plan) => {
      const schedule = plan.days[0]!.schedule;
      const [first, second] = [schedule[0]!, schedule[1]!];
      schedule[0] = second;
      schedule[1] = first;
    },
    resolved: true,
  },
  {
    rule: 'V-06',
    name: '区间重叠 → 顺延',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[1]!;
      item.start_time = '11:00';
      item.end_time = '12:30';
    },
    resolved: true,
  },
  {
    rule: 'V-07',
    name: '时长不符 → 重算结束时间',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.duration_minutes = 40;
    },
    resolved: true,
  },
  {
    rule: 'V-07',
    name: '时长为 0 → 补最短时长',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.duration_minutes = 0;
      plan.days[0]!.schedule[0]!.end_time = '09:30';
    },
    resolved: true,
  },
  {
    rule: 'V-08',
    name: '坐标越界 → 置 null',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.location.latitude = 91;
    },
    resolved: true,
  },
  {
    rule: 'V-10',
    name: '超上限 → 删除最便宜的条目',
    mutate: (plan) => {
      plan.days[0]!.schedule.push(structuredClone(plan.days[0]!.schedule[0]!));
    },
    resolved: true,
  },
  {
    rule: 'V-10',
    name: '低于下限 → 不强补，记入假设',
    mutate: (plan) => {
      plan.days[0]!.schedule.splice(1, 2);
    },
    resolved: false,
  },
  {
    rule: 'V-11',
    name: '步行超限 → 删除步行最长的条目',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_walking_km = 10;
    },
    resolved: true,
  },
  {
    rule: 'V-12',
    name: '出发过早 → 整日平移',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[0]!;
      item.start_time = '07:00';
      item.end_time = '09:30';
    },
    resolved: true,
  },
  {
    rule: 'V-13',
    name: '结束过晚且压不下 → 删除末位',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[2]!;
      item.start_time = '21:00';
      item.end_time = '23:00';
      item.duration_minutes = 120;
    },
    resolved: true,
  },
  {
    rule: 'V-13',
    name: '结束过晚但能压缩 → 压缩时长',
    mutate: (plan) => {
      const item = plan.days[0]!.schedule[2]!;
      item.start_time = '20:00';
      item.end_time = '22:00';
      item.duration_minutes = 120;
    },
    resolved: true,
  },
  {
    rule: 'V-14',
    name: '长者步行上限 → 只记假设不修',
    request: { travelers: { seniors: [{ age: 70 }] } },
    mutate: () => {
      /* 违规完全来自请求侧 */
    },
    resolved: false,
  },
  {
    rule: 'V-20',
    name: '分桶不符 → 由明细重算',
    mutate: (plan) => {
      plan.days[0]!.daily_budget.meal = 999;
    },
    resolved: true,
  },
  {
    rule: 'V-20',
    name: '总预算不符 → 由各日明细重算',
    mutate: (plan) => {
      plan.total_budget.total = 99_999;
    },
    resolved: true,
  },
  {
    rule: 'V-21',
    name: '小幅超预算 → 下调到上限内',
    request: { budget: { min: 100, max: 180 } },
    mutate: () => {},
    resolved: true,
  },
  {
    rule: 'V-21',
    name: '超预算幅度大于可下调空间 → 修不平，记入假设',
    request: { budget: { min: 100, max: 101 } },
    mutate: () => {},
    resolved: false,
  },
  {
    rule: 'V-22',
    name: '低于预算下限 → 只记假设不修',
    request: { budget: { min: 2_000, max: 4_000 } },
    mutate: () => {},
    resolved: false,
  },
  {
    rule: 'V-23',
    name: '币种不一致 → 覆写为请求币种',
    mutate: (plan) => {
      (plan.days[0]!.daily_budget as Record<string, unknown>)['currency'] = 'USD';
    },
    resolved: true,
  },
  {
    rule: 'V-24',
    name: '负数 → 置 0',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_cost.amount = -5;
    },
    resolved: true,
  },
  {
    rule: 'V-24',
    name: '三位小数 → 四舍五入',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.estimated_cost.amount = 12.345;
    },
    resolved: true,
  },
  {
    rule: 'V-30',
    name: '硬约束未满足 → 不可程序化修复',
    mutate: (plan) => {
      plan.constraint_report.satisfied = plan.constraint_report.satisfied.filter(
        (entry) => entry.mode !== 'MUST',
      );
    },
    resolved: false,
  },
  {
    rule: 'V-31',
    name: 'violated 含硬约束 → 不可程序化修复',
    mutate: (plan) => {
      plan.constraint_report.violated.push({
        code: 'accommodation.elevator',
        mode: 'MUST',
        reason: '该区域无带电梯的房源。',
        severity: 'BLOCKING',
      });
    },
    resolved: false,
  },
  {
    rule: 'V-32',
    name: '软约束满足率低 → 只记假设',
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
    mutate: () => {},
    resolved: false,
  },
  {
    rule: 'V-33',
    name: '无适合儿童的安排 → 只记假设',
    mutate: (plan) => {
      for (const item of plan.days[0]!.schedule) {
        item.child_friendly = false;
      }
    },
    resolved: false,
  },
  {
    rule: 'V-40',
    name: '标题超长 → 交给文案压缩',
    mutate: (plan) => {
      plan.title = '杭州运河与西湖人文深度慢游五日行程（含博物馆与茶山）精选安排建议参考版本';
    },
    resolved: true,
  },
  {
    rule: 'V-41',
    name: '餐次重复 → 去重保留首条',
    mutate: (plan) => {
      plan.days[0]!.food_recommendations[1]!.meal = 'BREAKFAST';
    },
    resolved: true,
  },
  {
    rule: 'V-42',
    name: '机位对不上 → 删除',
    mutate: (plan) => {
      plan.days[0]!.photo_spots[0]!.entity_name = '雷峰塔';
    },
    resolved: true,
  },
  {
    rule: 'V-43',
    name: '路线节点不足 → 删除该路线',
    mutate: (plan) => {
      plan.days[0]!.route_recommendations[0]!.nodes = ['拱宸桥'];
    },
    resolved: true,
  },
  {
    rule: 'V-44',
    name: 'Markdown 残留 → 清洗',
    mutate: (plan) => {
      plan.days[0]!.theme = '**运河人文**';
    },
    resolved: true,
  },
  {
    rule: 'V-44',
    name: '必填字段无有效内容 → 不可程序化修复',
    mutate: (plan) => {
      /*
       * 用 `'null'` 而不是 `'   '`：必填字段用的是 `NonEmptyStringSchema`
       * （`z.string().trim().min(1)`），纯空白值连 schema 都过不去，
       * 在业务规则这一层根本不可能出现。真正会漏进来的是**清洗后为空**
       * 的内容 —— 占位词、纯 Markdown 标记这类。
       */
      plan.days[0]!.schedule[0]!.location.name = 'null';
    },
    resolved: false,
  },
  {
    rule: 'V-45',
    name: 'URL → 剥离',
    mutate: (plan) => {
      plan.days[0]!.schedule[0]!.description = '详见 https://example.com/opening 的说明';
    },
    resolved: true,
  },
  {
    rule: 'V-45',
    name: 'HTML 标签 → 剥离',
    mutate: (plan) => {
      plan.summary = '<b>杭州</b>五日游';
    },
    resolved: true,
  },
];

describe('修复表', () => {
  it.each(CASES)('$rule $name', ({ rule, request, mutate, resolved }) => {
    const ctx = makeValidContext(request ?? {});
    const input = makeValidPlan() as MutablePlan;
    mutate(input);

    // 前置条件：这个输入真的触发了该规则，否则本用例什么都没验证
    expect(
      validatePlan(input, ctx).some((v) => v.rule === rule),
      `${rule} 的输入没有触发违规`,
    ).toBe(true);

    const { plan } = repairToFixedPoint(input, ctx);
    const remaining = validatePlan(plan, ctx).filter((v) => v.rule === rule);

    if (resolved) {
      expect(remaining, `${rule} 修复后仍有违规`).toEqual([]);
    } else {
      expect(remaining.length, `${rule} 被意外「修复」了`).toBeGreaterThan(0);
    }
  });

  it('修复后的计划仍然满足 schema', () => {
    /*
     * 清洗与删减都会写回字段，而 `NonEmptyStringSchema` 不接受空串。
     * 修复把某个必填字段清成空串时，落库的 plan_json 会变成一份
     * 读不回来的数据 —— 而那要到排查 REJECTED 版本时才会发现。
     */
    for (const testCase of CASES) {
      const ctx = makeValidContext(testCase.request ?? {});
      const input = makeValidPlan() as MutablePlan;
      testCase.mutate(input);
      const { plan } = repairToFixedPoint(input, ctx);
      expect(
        TravelPlanSchema.safeParse(plan).success,
        `${testCase.rule} ${testCase.name} 修复后不满足 schema`,
      ).toBe(true);
    }
  });
});

describe('不动点', () => {
  it('零违规的计划一轮都不改', () => {
    const result = repairPlan(makeValidPlan(), makeValidContext());
    expect(result.changed).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it('修完一轮后第二轮不再改动', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.city = '苏州';
    input.days[1]!.date = '2026-05-01';

    const first = repairPlan(input, ctx);
    expect(first.changed).toBe(true);

    const second = repairPlan(first.plan, ctx);
    expect(second.changed).toBe(false);
  });

  it('反复修复不会重复追加同一条假设', () => {
    // 幂等性：ADVISORY 违规在修复后依然成立，不去重就会累积三份
    const ctx = makeValidContext({ travelers: { seniors: [{ age: 70 }] } });
    const { plan } = repairToFixedPoint(makeValidPlan() as MutablePlan, ctx);

    const keys = plan.constraint_report.assumptions.map((a) => `${a.code}|${a.text}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('逐条修复行为', () => {
  it('V-01 截断的是日期最靠后的那几天', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    // 插一天到最前面，日期比第 1 天更早
    const extra = structuredClone(input.days[0]!);
    extra.date = '2026-04-09';
    input.days.unshift(extra);

    const { plan } = repairToFixedPoint(input, ctx);
    expect(plan.days).toHaveLength(5);
    expect(plan.days.map((d) => d.date)).toEqual([
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
      '2026-04-13',
      '2026-04-14',
    ]);
    expect(plan.days.map((d) => d.day_number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('V-10 删掉的是最便宜的条目，不是最贵的', () => {
    /*
     * 3.2.1「按 estimated_cost 降序删除末位低优先条目」。写反的后果是
     * 门票类核心项目被删光，行程只剩免费的街区漫步 —— 而条数确实合规了。
     */
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.schedule.push(structuredClone(input.days[0]!.schedule[0]!));

    const { plan } = repairToFixedPoint(input, ctx);
    const costs = plan.days[0]!.schedule.map((item) => item.estimated_cost.amount);
    expect(plan.days[0]!.schedule).toHaveLength(3);
    expect(costs).toContain(10);
  });

  it('V-11 删掉的是步行最长的条目', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.schedule[0]!.estimated_walking_km = 10;

    const { plan } = repairToFixedPoint(input, ctx);
    const walking = plan.days[0]!.schedule.map((item) => item.estimated_walking_km);
    expect(walking).not.toContain(10);
    expect(walking).toEqual([1.8, 0.6]);
  });

  it('V-12 平移保持各条时长不变', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    const before = input.days[0]!.schedule.map((item) => item.duration_minutes);
    input.days[0]!.schedule[0]!.start_time = '07:00';
    input.days[0]!.schedule[0]!.end_time = '09:30';

    const { plan } = repairToFixedPoint(input, ctx);
    expect(plan.days[0]!.schedule[0]!.start_time).toBe('09:00');
    expect(plan.days[0]!.schedule.map((item) => item.duration_minutes)).toEqual(before);
  });

  it('V-13 能压缩时压缩，压不下才删', () => {
    const ctx = makeValidContext();

    const compressible = makeValidPlan() as MutablePlan;
    const late = compressible.days[0]!.schedule[2]!;
    late.start_time = '20:00';
    late.end_time = '22:00';
    late.duration_minutes = 120;

    const compressed = repairToFixedPoint(compressible, ctx).plan;
    expect(compressed.days[0]!.schedule).toHaveLength(3);
    expect(compressed.days[0]!.schedule[2]!.end_time).toBe('21:00');
    expect(compressed.days[0]!.schedule[2]!.duration_minutes).toBe(60);

    const undeletable = makeValidPlan() as MutablePlan;
    const tooLate = undeletable.days[0]!.schedule[2]!;
    tooLate.start_time = '21:00';
    tooLate.end_time = '23:00';
    tooLate.duration_minutes = 120;

    const trimmed = repairToFixedPoint(undeletable, ctx).plan;
    expect(trimmed.days[0]!.schedule).toHaveLength(2);
  });

  it('V-13 不会把某天删空', () => {
    // 删空会把一个 REPAIRABLE 换成一个 BLOCKING（V-05），
    // 还得再花一次 LLM 重生成才能补回来
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.schedule = [
      {
        ...structuredClone(input.days[0]!.schedule[0]!),
        start_time: '22:00',
        end_time: '23:30',
        duration_minutes: 90,
      },
    ];

    const { plan } = repairToFixedPoint(input, ctx);
    expect(plan.days[0]!.schedule.length).toBeGreaterThanOrEqual(1);
  });

  it('V-07 时长非正时给出最短时长而不是零长条目', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.schedule[0]!.duration_minutes = -30;
    input.days[0]!.schedule[0]!.end_time = '09:30';

    const { plan } = repairToFixedPoint(input, ctx);
    expect(plan.days[0]!.schedule[0]!.duration_minutes).toBeGreaterThanOrEqual(
      MIN_SCHEDULE_MINUTES,
    );
  });

  it('V-20 重算后 total_budget 与各日明细严格一致', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.daily_budget.meal = 999;
    input.total_budget.total = 12;

    const { plan } = repairToFixedPoint(input, ctx);
    const derived = deriveBudget(plan);
    expect(plan.total_budget.total).toBe(derived.total);
    expect(plan.days[0]!.daily_budget.meal).toBe(derived.daily[0]!.meal);
  });

  it('V-21 按「门票 → 其他 → 餐饮」顺序下调，且不编造条目名称', () => {
    /*
     * 3.2.1 还写了「替换对应条目为更低价选项标注」。程序化修复不可能知道
     * 某个景点的更低价替代叫什么 —— 编造一个店名会让用户看到一个不存在的
     * 地方，比预算数字偏高严重得多。因此只下调金额，并记入假设。
     */
    const ctx = makeValidContext({ budget: { min: 100, max: 180 } });
    const input = makeValidPlan() as MutablePlan;
    const labelsBefore = input.days.flatMap((d) => d.daily_budget.breakdown.map((b) => b.label));

    const { plan } = repairToFixedPoint(input, ctx);
    const labelsAfter = plan.days.flatMap((d) => d.daily_budget.breakdown.map((b) => b.label));
    expect(labelsAfter).toEqual(labelsBefore);

    // OTHER 先被削到 0，MEAL 只削到刚好够
    const others = plan.days.flatMap((d) =>
      d.daily_budget.breakdown.filter((b) => b.bucket === 'OTHER').map((b) => b.amount),
    );
    const meals = plan.days.flatMap((d) =>
      d.daily_budget.breakdown.filter((b) => b.bucket === 'MEAL').map((b) => b.amount),
    );
    expect(others.every((amount) => amount === 0)).toBe(true);
    expect(meals.some((amount) => amount > 0)).toBe(true);

    expect(plan.constraint_report.assumptions.map((a) => a.code)).toContain('BUDGET_SCALED_DOWN');
  });

  it('V-40 压缩后不超限', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.title = '杭州运河与西湖人文深度慢游五日行程精选安排建议参考版本';

    const { plan } = repairToFixedPoint(input, ctx);
    expect([...plan.title].length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('V-41 去重保留首条并截断到 4 条', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    const first = input.days[0]!.food_recommendations[0]!;
    input.days[0]!.food_recommendations[1]!.meal = 'BREAKFAST';

    const { plan } = repairToFixedPoint(input, ctx);
    const meals = plan.days[0]!.food_recommendations.map((f) => f.meal);
    expect(new Set(meals).size).toBe(meals.length);
    expect(plan.days[0]!.food_recommendations[0]!.name).toBe(first.name);
  });

  it('V-45 剥离 URL 后保留句子其余部分', () => {
    // URL 用 `\S*` 匹配会把中文一起吃掉 —— 中文不是空白字符
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.schedule[0]!.description = '详见 https://example.com/a?b=1 的开放时间';

    const { plan } = repairToFixedPoint(input, ctx);
    const description = plan.days[0]!.schedule[0]!.description;
    expect(description).toContain('详见');
    expect(description).toContain('的开放时间');
    expect(description).not.toContain('://');
  });

  it('V-44 清洗必填字段得到空串时保持原值', () => {
    const ctx = makeValidContext();
    const input = makeValidPlan() as MutablePlan;
    input.days[0]!.theme = '**';

    const { plan } = repairToFixedPoint(input, ctx);
    expect(plan.days[0]!.theme).toBe('**');
    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      validatePlan(plan, ctx).some((v) => v.rule === 'V-44' && v.severity === 'BLOCKING'),
    ).toBe(true);
  });

  it('假设文案面向用户，不含字段路径', () => {
    const ctx = makeValidContext({ travelers: { seniors: [{ age: 70 }] } });
    const input = makeValidPlan() as MutablePlan;
    input.days[1]!.city = '苏州';

    const { plan } = repairToFixedPoint(input, ctx);
    expect(plan.constraint_report.assumptions.length).toBeGreaterThan(0);
    for (const assumption of plan.constraint_report.assumptions) {
      expect(assumption.text, `${assumption.code} 的文案泄漏了字段路径`).not.toMatch(
        /days\[|schedule\[|_budget\./,
      );
      expect(assumption.text).toMatch(/[一-龥]/);
    }
    expect(plan.constraint_report.assumptions.some((a) => a.text.includes('第 2 天'))).toBe(true);
  });
});
