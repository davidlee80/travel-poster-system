import { describe, expect, it } from 'vitest';
import {
  BUDGET_BUCKET_VALUES,
  MEAL_VALUES,
  PERIOD_VALUES,
  TRANSPORT_MODE_VALUES,
} from './enums.js';
import { TRAVEL_PLAN_FIXTURES, makeTravelPlanFixture } from './fixtures.js';
import { TravelPlanLlmOutputSchema, TravelPlanSchema } from './travel-plan.js';
import { travelPlanLlmOutputJsonSchema } from './json-schema.js';

describe('TravelPlan schema', () => {
  it.each([
    ['1 天', TRAVEL_PLAN_FIXTURES.oneDay],
    ['7 天', TRAVEL_PLAN_FIXTURES.sevenDays],
    ['14 天', TRAVEL_PLAN_FIXTURES.fourteenDays],
  ])('%s fixture 通过校验', (_label, make) => {
    const result = TravelPlanSchema.safeParse(make());
    expect(result.success).toBe(true);
  });

  it('fixture 的天数、日期与天号自洽（避免用错误的 fixture 测正确性）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 14, startDate: '2026-10-01' });

    expect(plan.days).toHaveLength(plan.total_days);
    expect(plan.end_date).toBe('2026-10-14');

    plan.days.forEach((day, index) => {
      expect(day.day_number).toBe(index + 1);
    });
    expect(plan.days.at(-1)?.date).toBe('2026-10-14');
  });

  it('fixture 跨月边界日期正确', () => {
    const plan = makeTravelPlanFixture({ totalDays: 3, startDate: '2026-10-30' });
    expect(plan.days.map((d) => d.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(plan.end_date).toBe('2026-11-01');
  });

  it('fixture 的 daily_budget 四桶与 breakdown 之和一致（V-20 的前提）', () => {
    for (const day of TRAVEL_PLAN_FIXTURES.sevenDays().days) {
      const b = day.daily_budget;
      const sum = b.breakdown.reduce((acc, item) => acc + item.amount, 0);

      expect(b.total).toBe(sum);
      for (const bucket of BUDGET_BUCKET_VALUES) {
        const bucketSum = b.breakdown
          .filter((i) => i.bucket === bucket)
          .reduce((acc, i) => acc + i.amount, 0);
        const field = bucket.toLowerCase() as 'ticket' | 'transport' | 'meal' | 'other';
        expect(b[field]).toBe(bucketSum);
      }
    }
  });

  it('缺少必填字段时校验失败', () => {
    const plan = TRAVEL_PLAN_FIXTURES.oneDay() as unknown as Record<string, unknown>;
    delete plan['title'];
    expect(TravelPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('未定义的枚举值被拒绝', () => {
    const plan = TRAVEL_PLAN_FIXTURES.oneDay();
    const broken = structuredClone(plan);
    // @ts-expect-error 故意写入非法枚举值以验证运行期校验
    broken.days[0]!.schedule[0]!.period = 'MIDNIGHT';
    expect(TravelPlanSchema.safeParse(broken).success).toBe(false);
  });

  it('schema_version 不匹配时被拒绝', () => {
    const broken = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay()) as Record<string, unknown>;
    broken['schema_version'] = 'travel_plan_v2';
    expect(TravelPlanSchema.safeParse(broken).success).toBe(false);
  });
});

describe('schema 只做结构校验，取值合理性留给业务规则（3.2.1）', () => {
  /**
   * 这些用例守护一个容易被"顺手加强"破坏的设计决定：
   * schema 若拒绝这些取值，对应的 REPAIRABLE 违规会被升级为 BLOCKING
   * （Schema 校验失败是阻断项，见十六章 16.3），自动修复机制就失效了。
   */

  it('经纬度越界仍通过 schema（V-08 REPAIRABLE：修复为置 null）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());
    plan.days[0]!.schedule[0]!.location.latitude = 999;
    plan.days[0]!.schedule[0]!.location.longitude = -999;

    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('金额为负仍通过 schema（V-24 REPAIRABLE：修复为置 0）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());
    plan.days[0]!.daily_budget.total = -100;
    plan.days[0]!.schedule[0]!.estimated_cost.amount = -5;

    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('天数与 days 长度不一致仍通过 schema（V-01 BLOCKING：由业务规则触发补生成）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.sevenDays());
    plan.days = plan.days.slice(0, 3);

    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('daily_budget 四桶与 breakdown 不一致仍通过 schema（V-20 REPAIRABLE）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());
    plan.days[0]!.daily_budget.meal = 99999;

    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('路线节点不足 2 个仍通过 schema（V-43 REPAIRABLE：删除该条路线）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());
    plan.days[0]!.route_recommendations[0]!.nodes = ['只有一个节点'];

    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('日期形状非法则被 schema 拒绝（格式问题不是业务规则能修的）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());
    plan.days[0]!.date = '2026/10/01';

    expect(TravelPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('时间形状非法则被 schema 拒绝', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());
    plan.days[0]!.schedule[0]!.start_time = '9:30';

    expect(TravelPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('24:00 被拒绝，23:59 通过（边界）', () => {
    const plan = structuredClone(TRAVEL_PLAN_FIXTURES.oneDay());

    plan.days[0]!.schedule[0]!.start_time = '23:59';
    expect(TravelPlanSchema.safeParse(plan).success).toBe(true);

    plan.days[0]!.schedule[0]!.start_time = '24:00';
    expect(TravelPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe('LLM 输出 schema（6.3）', () => {
  it('不含程序注入的字段', () => {
    const shape = Object.keys(TravelPlanLlmOutputSchema.shape);

    for (const forbidden of [
      'plan_id',
      'plan_version_id',
      'request_id',
      'schema_version',
      'status',
    ]) {
      expect(shape).not.toContain(forbidden);
    }
  });

  it('仍包含全部内容字段', () => {
    const shape = Object.keys(TravelPlanLlmOutputSchema.shape);

    for (const required of [
      'title',
      'summary',
      'destination',
      'start_date',
      'end_date',
      'total_days',
      'traveler_count',
      'currency',
      'total_budget',
      'days',
      'constraint_report',
    ]) {
      expect(shape).toContain(required);
    }
  });

  it('导出的 JSON Schema 可用且不泄漏程序注入字段', () => {
    const json = travelPlanLlmOutputJsonSchema as {
      type?: string;
      properties?: Record<string, unknown>;
    };

    expect(json.type).toBe('object');
    expect(json.properties).toBeDefined();
    expect(Object.keys(json.properties ?? {})).not.toContain('plan_id');
    expect(Object.keys(json.properties ?? {})).toContain('days');
  });
});

describe('枚举完整性（6.1）', () => {
  it('时段五档，与 9.1 的时段图标一一对应', () => {
    expect(PERIOD_VALUES).toEqual(['MORNING', 'NOON', 'AFTERNOON', 'EVENING', 'NIGHT']);
  });

  it('餐次四档', () => {
    expect(MEAL_VALUES).toEqual(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);
  });

  it('交通方式六档，与 9.1 的交通图标一一对应', () => {
    expect(TRANSPORT_MODE_VALUES).toHaveLength(6);
  });

  it('预算分桶四档，与 daily_budget 的四个字段一一对应', () => {
    expect([...BUDGET_BUCKET_VALUES].map((b) => b.toLowerCase())).toEqual([
      'ticket',
      'transport',
      'meal',
      'other',
    ]);
  });
});
