import { describe, expect, it } from 'vitest';
import { TravelPosterViewModelSchema, makeTravelPlanFixture } from '@tps/schemas';
import { buildFullPlan } from './build-full-plan.js';

describe('buildFullPlan（3.3.1 FULL_PLAN）', () => {
  it('page_type 为 FULL_PLAN 且 day_number 为 null（数据库同名约束）', () => {
    const { viewModel } = buildFullPlan({ plan: makeTravelPlanFixture({ totalDays: 7 }) });

    expect(viewModel.page_type).toBe('FULL_PLAN');
    expect(viewModel.day_number).toBeNull();
    expect(viewModel.template_id).toBe('travel_full_plan_v1');
  });

  it.each([1, 7, 14])('%i 天计划的每一天都产出合法的日 ViewModel', (totalDays) => {
    const { viewModel } = buildFullPlan({ plan: makeTravelPlanFixture({ totalDays }) });

    expect(viewModel.days).toHaveLength(totalDays);
    for (const day of viewModel.days) {
      expect(TravelPosterViewModelSchema.safeParse(day).success).toBe(true);
      expect(day.page_type).toBe('DAILY_POSTER');
    }
  });

  it('各日按 day_number 升序，即使输入乱序（V-02 的廉价防御）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 5 });
    // 打乱数组顺序
    const shuffled = { ...plan, days: [...plan.days].reverse() };

    const { viewModel } = buildFullPlan({ plan: shuffled });

    expect(viewModel.days.map((d) => d.day_number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('计划级概览文案正确', () => {
    const plan = makeTravelPlanFixture({ totalDays: 5, startDate: '2026-10-01' });
    const { viewModel } = buildFullPlan({ plan });

    expect(viewModel.overview.destination).toBe('杭州');
    expect(viewModel.overview.total_days).toBe(5);
    expect(viewModel.overview.date_range_text).toBe('2026-10-01 – 2026-10-05');
    expect(viewModel.overview.traveler_text).toBe('3 人');
    expect(viewModel.overview.per_person_text).toMatch(/^¥\d+ \/ 人$/);
  });

  it('单日行程的日期区间只显示一个日期', () => {
    const { viewModel } = buildFullPlan({ plan: makeTravelPlanFixture({ totalDays: 1 }) });
    expect(viewModel.overview.date_range_text).toBe('2026-10-01');
  });

  it('不新增素材槽位：各日素材由同一个 lookup 提供（3.3.1）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 3 });
    const queried: string[] = [];

    buildFullPlan({
      plan,
      assets: (slotId) => {
        queried.push(slotId);
        return undefined;
      },
    });

    // 只查询按天的槽位，不存在 full_plan.* 这类新槽位
    expect(queried.length).toBeGreaterThan(0);
    for (const slotId of queried) {
      expect(slotId).toMatch(/^day_\d+\./);
    }
  });

  it('任一天预算不一致时上报 budgetMismatch', () => {
    const plan = makeTravelPlanFixture({ totalDays: 3 });
    plan.days[1]!.daily_budget.total = 99999;

    const { budgetMismatch } = buildFullPlan({ plan });
    expect(budgetMismatch).toBe(true);
  });

  it('全部天正常时 budgetMismatch 为 false', () => {
    const { budgetMismatch } = buildFullPlan({ plan: makeTravelPlanFixture({ totalDays: 7 }) });
    expect(budgetMismatch).toBe(false);
  });

  it('icons 与各日一致（同一套图标，不为完整页另建一套）', () => {
    const { viewModel } = buildFullPlan({ plan: makeTravelPlanFixture({ totalDays: 2 }) });

    expect(viewModel.icons).toEqual(viewModel.days[0]?.icons);
  });
});
