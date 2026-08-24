import { makeTravelPlanFixture, type TravelPlan, type TravelPlanDay } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  CITY_LABEL_SEPARATOR,
  MAX_LISTED_CITIES,
  destinationLabel,
  isMultiCityPlan,
  planCityNames,
} from './cities.js';
import { buildDailyPoster } from './build-view-model.js';
import { buildFullPlan } from './build-full-plan.js';
import { requirementsForDay } from './requirements.js';
import { FULL_PLAN_CONTENT_LIMITS } from './content-limits.js';

/**
 * 多城行程的显示（P9，规范 7）。
 *
 * 单城行程（含全部存量计划与视觉基线）的输出必须**一字不变** ——
 * 那是这组断言里最重要的一条：`day.city === plan.destination.name` 时
 * 所有路径都退化成原来的行为。
 */

/** 把 fixture 的每日城市改成给定序列。天数不足时循环取 */
function withCities(cities: readonly string[]): TravelPlan {
  const base = makeTravelPlanFixture({ totalDays: 5 });
  const days: TravelPlanDay[] = base.days.map((day, index) => ({
    ...day,
    city: cities[index % cities.length] ?? day.city,
  }));
  return { ...base, days };
}

describe('城市序列聚合', () => {
  it('单城行程给出单元素序列', () => {
    const plan = makeTravelPlanFixture({ totalDays: 5 });
    expect(planCityNames(plan)).toEqual([plan.destination.name]);
    expect(isMultiCityPlan(plan)).toBe(false);
    expect(destinationLabel(plan)).toBe(plan.destination.name);
  });

  it('按首次出现顺序去重', () => {
    /*
     * 按首次出现顺序而不是排序：那个顺序就是行程顺序，
     * 而按字母或拼音排会让「东京 → 京都」在某些组合下显示成反的。
     */
    const base = makeTravelPlanFixture({ totalDays: 5 });
    const days = base.days.map((day, index) => ({
      ...day,
      city: index < 2 ? '东京' : '京都',
    }));
    const plan: TravelPlan = { ...base, days };
    expect(planCityNames(plan)).toEqual(['东京', '京都']);
    expect(isMultiCityPlan(plan)).toBe(true);
  });

  it('三城以内全列', () => {
    const plan = withCities(['东京', '京都', '大阪']);
    expect(destinationLabel(plan)).toBe(['东京', '京都', '大阪'].join(CITY_LABEL_SEPARATOR));
  });

  it('超过三城收尾成「等 N 城」', () => {
    /*
     * 五城的完整标签在信息图的固定宽度标题区会被 `toCompact` 从中间截断，
     * 而「东京 · 京都 · 大阪 · 奈…」比「东京 · 京都 · 大阪 等 5 城」信息量更少。
     */
    const plan = withCities(['东京', '京都', '大阪', '奈良', '神户']);
    const label = destinationLabel(plan);
    expect(label).toContain('等 5 城');
    expect(label.split(CITY_LABEL_SEPARATOR)).toHaveLength(MAX_LISTED_CITIES);
  });

  it('分隔符不是箭头 —— 那个符号已经被行程条用掉了', () => {
    /* 同一个符号在同一页表达两种不同层级的顺序会让人读错层级 */
    expect(CITY_LABEL_SEPARATOR).not.toContain('→');
  });
});

describe('单日海报的 header 显示当天所在城市', () => {
  it('多城时第 N 天显示第 N 天的城市', () => {
    const base = makeTravelPlanFixture({ totalDays: 5 });
    const days = base.days.map((day, index) => ({ ...day, city: index === 0 ? '东京' : '京都' }));
    const plan: TravelPlan = { ...base, days };

    const first = buildDailyPoster({ plan, dayNumber: 1 });
    const second = buildDailyPoster({ plan, dayNumber: 2 });
    expect(first.viewModel.header.destination).toBe('东京');
    expect(second.viewModel.header.destination).toBe('京都');
  });

  it('单城时与 plan 级目的地一致 —— 存量计划与视觉基线不受影响', () => {
    const plan = makeTravelPlanFixture({ totalDays: 5 });
    const built = buildDailyPoster({ plan, dayNumber: 1 });
    expect(built.viewModel.header.destination).toBe(plan.destination.name);
  });
});

describe('完整页 overview 显示聚合标签', () => {
  it('多城时列出经过的城市', () => {
    const base = makeTravelPlanFixture({ totalDays: 5 });
    const days = base.days.map((day, index) => ({ ...day, city: index === 0 ? '东京' : '京都' }));
    const plan: TravelPlan = { ...base, days };
    const result = buildFullPlan({ plan });
    expect(result.viewModel.overview.destination).toBe(`东京${CITY_LABEL_SEPARATOR}京都`);
  });

  it('单城时与 plan 级目的地一致', () => {
    const plan = makeTravelPlanFixture({ totalDays: 5 });
    expect(buildFullPlan({ plan }).viewModel.overview.destination).toBe(plan.destination.name);
  });
});

describe('每日配图按 day.city 取材', () => {
  it('多城时第二城的槽位不带第一城的 place_id', () => {
    /*
     * 把东京的 place_id 配上「京都」这个名字比不带 place_id 更糟：
     * 素材检索会按 place_id 命中东京的图，然后以为那就是京都。
     * 缓存键也含目的地段，因此不改的话两个城市会共用同一张图。
     */
    const base = makeTravelPlanFixture({ totalDays: 5 });
    const days = base.days.map((day, index) => ({ ...day, city: index === 0 ? base.destination.name : '京都' }));
    const plan: TravelPlan = { ...base, days };

    const firstDay = plan.days[0];
    const secondDay = plan.days[1];
    expect(firstDay).toBeDefined();
    expect(secondDay).toBeDefined();
    if (firstDay === undefined || secondDay === undefined) return;

    const firstItems = requirementsForDay({ plan, day: firstDay, limits: FULL_PLAN_CONTENT_LIMITS });
    const secondItems = requirementsForDay({
      plan,
      day: secondDay,
      limits: FULL_PLAN_CONTENT_LIMITS,
    });

    /* 路线图槽位没有 subject（它带的是 route_data），因此逐个判空 */
    for (const item of firstItems) {
      const subject = item.subject;
      if (subject === undefined || subject === null) continue;
      expect(subject.destination).toBe(base.destination.name);
      expect(subject.destination_place_id).toBe(base.destination.place_id);
    }
    for (const item of secondItems) {
      const subject = item.subject;
      if (subject === undefined || subject === null) continue;
      expect(subject.destination).toBe('京都');
      /* 不带 place_id：`TravelPlanDay` 只有 city，没有那一城的 place_id */
      expect(subject.destination_place_id ?? null).toBeNull();
    }
  });

  it('单城时 place_id 照带 —— 缓存键与存量一致', () => {
    const plan = makeTravelPlanFixture({ totalDays: 5 });
    const day = plan.days[0];
    expect(day).toBeDefined();
    if (day === undefined) return;
    const items = requirementsForDay({ plan, day, limits: FULL_PLAN_CONTENT_LIMITS });
    const hero = items.find((item) => item.role === 'HERO_BACKGROUND');
    expect(hero?.subject?.destination).toBe(plan.destination.name);
    expect(hero?.subject?.destination_place_id).toBe(plan.destination.place_id);
  });
});
