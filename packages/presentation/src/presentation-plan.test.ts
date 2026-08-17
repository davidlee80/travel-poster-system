import {
  AssetRequirementSchema,
  MEAL_VALUES,
  makeTravelPlanFixture,
  type TravelPlan,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';
import { buildDailyPoster } from './build-view-model.js';
import { buildFullPlan } from './build-full-plan.js';
import { DAILY_CONTENT_LIMITS, FULL_PLAN_CONTENT_LIMITS } from './content-limits.js';
import { buildPresentationPlans } from './presentation-plan.js';
import { assetRequirementEnvelope, mergeRequirements } from './requirements.js';
import { foodSlotId, heroSlotId, photoSpotSlotId, routeMapSlotId } from './slots.js';

/**
 * Presentation Planner 与槽位生成（TP-3-03、TP-3-04、TP-3-05）。
 */

describe('N+1 个 PresentationPlan（TP-3-03）', () => {
  it.each([1, 3, 7, 14])('%i 天计划产出 天数+1 页', (totalDays) => {
    const plans = buildPresentationPlans({ plan: makeTravelPlanFixture({ totalDays }) });

    expect(plans).toHaveLength(totalDays + 1);
    expect(plans.filter((p) => p.page_type === 'DAILY_POSTER')).toHaveLength(totalDays);
    expect(plans.filter((p) => p.page_type === 'FULL_PLAN')).toHaveLength(1);
  });

  it('每日页带天号与信息图模板；完整页 day_number 为 null（3.3.1）', () => {
    const plans = buildPresentationPlans({ plan: makeTravelPlanFixture({ totalDays: 3 }) });

    expect(plans.slice(0, 3).map((p) => p.day_number)).toEqual([1, 2, 3]);
    expect(plans.slice(0, 3).every((p) => p.template_id === 'travel_infographic_v1')).toBe(true);

    const full = plans.at(-1)!;
    expect(full.day_number).toBeNull();
    expect(full.template_id).toBe('travel_full_plan_v1');
    expect(full.content_limits).toEqual(FULL_PLAN_CONTENT_LIMITS);
  });

  it('完整页不新增素材槽位（3.3.1 —— 否则完整页会多一整套 AI 成本）', () => {
    const plans = buildPresentationPlans({ plan: makeTravelPlanFixture({ totalDays: 5 }) });
    expect(plans.at(-1)!.asset_requirements).toEqual([]);
  });

  it('天号乱序的输入仍按升序编排', () => {
    const plan = makeTravelPlanFixture({ totalDays: 3 });
    const shuffled: TravelPlan = { ...plan, days: [plan.days[2]!, plan.days[0]!, plan.days[1]!] };

    const plans = buildPresentationPlans({ plan: shuffled });
    expect(plans.slice(0, 3).map((p) => p.day_number)).toEqual([1, 2, 3]);
  });
});

describe('槽位生成（TP-3-04）', () => {
  it('每日四类槽位，ID 与 slots.ts 的规则一致', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const slots = buildPresentationPlans({ plan })[0]!.asset_requirements.map((r) => r.slot_id);

    expect(slots[0]).toBe(heroSlotId(1));
    expect(slots[1]).toBe(routeMapSlotId(1));
    for (const food of day.food_recommendations) {
      expect(slots).toContain(foodSlotId(1, food.meal));
    }
    day.photo_spots.forEach((_spot, index) => {
      expect(slots).toContain(photoSpotSlotId(1, index));
    });
    expect(slots).toHaveLength(2 + day.food_recommendations.length + day.photo_spots.length);
  });

  it('14 天合并后无重复 slot_id，且槽位数 = 每天槽位数之和', () => {
    const plan = makeTravelPlanFixture({ totalDays: 14 });
    const plans = buildPresentationPlans({ plan });
    const merged = mergeRequirements(plans);

    expect(merged.duplicates).toEqual([]);
    expect(new Set(merged.requirements.map((r) => r.slot_id)).size).toBe(
      merged.requirements.length,
    );

    const perDay = plans
      .filter((p) => p.page_type === 'DAILY_POSTER')
      .reduce((acc, p) => acc + p.asset_requirements.length, 0);
    expect(merged.requirements).toHaveLength(perDay);
  });

  it('合并结果套上信封后通过 AssetRequirementSchema（14.1 的请求体）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 14 });
    const merged = mergeRequirements(buildPresentationPlans({ plan }));

    const parsed = AssetRequirementSchema.safeParse(
      assetRequirementEnvelope({
        planId: plan.plan_id,
        planVersionId: plan.plan_version_id,
        templateId: 'travel_infographic_v1',
        requirements: merged.requirements,
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it('重复槽位被丢弃并上报，不静默通过', () => {
    const plan = makeTravelPlanFixture({ totalDays: 2 });
    const plans = buildPresentationPlans({ plan });
    // 人为制造重复：把第 1 天的槽位再挂到第 2 天的页上
    const merged = mergeRequirements([
      plans[0]!,
      { asset_requirements: plans[0]!.asset_requirements },
    ]);

    expect(merged.requirements).toHaveLength(plans[0]!.asset_requirements.length);
    expect(merged.duplicates).toHaveLength(plans[0]!.asset_requirements.length);
  });

  it('Hero 槽位带主题与目的地但不带 entity_name（10.1 按 0.5 中性值计入）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const hero = buildPresentationPlans({ plan })[0]!.asset_requirements[0]!;

    expect(hero.role).toBe('HERO_BACKGROUND');
    expect(hero.subject?.theme).toBe(plan.days[0]!.theme);
    expect(hero.subject?.destination_place_id).toBe(plan.destination.place_id);
    expect(hero.subject?.entity_name ?? null).toBeNull();
  });

  it('拍照机位槽位带 place_id（19.2 的景点图缓存键以它为主键段）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const spotSlot = buildPresentationPlans({ plan })[0]!.asset_requirements.find(
      (r) => r.slot_id === photoSpotSlotId(1, 0),
    )!;

    const expected =
      day.schedule.find((s) => s.location.name === day.photo_spots[0]!.entity_name)?.location
        .place_id ?? null;
    expect(spotSlot.subject?.entity_place_id).toBe(expected);
    // fixture 的机位对应 schedule 里的地点（V-42），因此这里必须拿到值 ——
    // 拿不到说明 place_id 传递断了，缓存会退化成按名称命中
    expect(expected).not.toBeNull();
  });

  it('路线槽位保留全部节点，含坐标为 null 的（剔除由渲染器负责）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const patched: TravelPlan = {
      ...plan,
      days: [
        {
          ...day,
          schedule: day.schedule.map((item, index) =>
            index === 0
              ? { ...item, location: { ...item.location, latitude: null, longitude: null } }
              : item,
          ),
        },
      ],
    };

    const route = buildPresentationPlans({ plan: patched })[0]!.asset_requirements[1]!;
    expect(route.route_data?.nodes).toHaveLength(day.schedule.length);
    expect(route.route_data?.nodes[0]?.latitude).toBeNull();
  });

  it('美食槽位数受 content_limits 约束（不为看不见的图付费）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    // V-41 允许每日 1～4 条美食；限额是 3
    const withFourMeals: TravelPlan = {
      ...plan,
      days: [
        {
          ...day,
          food_recommendations: MEAL_VALUES.map((meal, index) => ({
            meal,
            name: `美食 ${index + 1}`,
            description: '说明。',
            entity_type: 'DISH' as const,
          })),
        },
      ],
    };

    const foodSlots = buildPresentationPlans({ plan: withFourMeals })[0]!.asset_requirements.filter(
      (r) => r.role === 'FOOD_IMAGE',
    );
    expect(foodSlots).toHaveLength(DAILY_CONTENT_LIMITS.food_max_items ?? 4);
  });
});

describe('content_limits 接入 ViewModel（TP-3-05）', () => {
  it('每日海报不裁剪行程（R-25：schedule_max_items 取 null）', () => {
    /*
     * 3.3 的示例是 schedule_max_items: 3，而 PACKED 节奏允许每日 6 条。
     * 照抄示例的表现是「选了紧凑节奏的用户，海报上只剩一半行程」，
     * 且页面上没有任何提示。
     */
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const packed: TravelPlan = {
      ...plan,
      days: [{ ...day, schedule: [...day.schedule, ...day.schedule].slice(0, 6) }],
    };

    const built = buildDailyPoster({ plan: packed, dayNumber: 1 });
    expect(built.viewModel.schedule).toHaveLength(6);
    expect(built.omitted.schedule).toBe(0);
    // 路线节点与行程一致 —— 图上不该出现行程里没有的地方
    expect(built.viewModel.route_map.nodes).toHaveLength(6);
  });

  it('被裁掉的条目数上报而不是静默丢弃', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const many: TravelPlan = {
      ...plan,
      days: [
        {
          ...day,
          food_recommendations: MEAL_VALUES.map((meal, index) => ({
            meal,
            name: `美食 ${index + 1}`,
            description: '说明。',
            entity_type: 'DISH' as const,
          })),
          photo_spots: [...day.photo_spots, ...day.photo_spots, ...day.photo_spots].slice(0, 6),
        },
      ],
    };

    const built = buildDailyPoster({ plan: many, dayNumber: 1 });
    expect(built.omitted.food).toBe(1);
    expect(built.omitted.photoSpot).toBe(3);
    expect(built.viewModel.food_cards).toHaveLength(3);
    expect(built.viewModel.photo_spots).toHaveLength(3);
  });

  it('完整页不裁剪内容（3.3.1）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const many: TravelPlan = {
      ...plan,
      days: [
        {
          ...day,
          food_recommendations: MEAL_VALUES.map((meal, index) => ({
            meal,
            name: `美食 ${index + 1}`,
            description: '说明。',
            entity_type: 'DISH' as const,
          })),
        },
      ],
    };

    const full = buildFullPlan({ plan: many });
    expect(full.viewModel.days[0]!.food_cards).toHaveLength(4);

    // 而每日海报仍是 3 张 —— 两者用的是不同的 content_limits
    expect(buildDailyPoster({ plan: many, dayNumber: 1 }).viewModel.food_cards).toHaveLength(3);
  });

  it('12.1 的预算断言：items 之和与 total 不一致时上报 REPAIRABLE 而不是静默展示', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    const day = plan.days[0]!;
    const broken: TravelPlan = {
      ...plan,
      days: [{ ...day, daily_budget: { ...day.daily_budget, total: day.daily_budget.total + 50 } }],
    };

    const built = buildDailyPoster({ plan: broken, dayNumber: 1 });
    expect(built.budgetMismatch).toBe(true);
    // 展示以 breakdown 之和为准：页面上「各项相加 ≠ 合计」是用户一眼能看出的错误
    const sum = day.daily_budget.breakdown.reduce((acc, b) => acc + b.amount, 0);
    expect(built.viewModel.budget.total_text).toContain(String(Math.round(sum)));
  });

  it('一致时不报违规', () => {
    const built = buildDailyPoster({ plan: makeTravelPlanFixture({ totalDays: 1 }), dayNumber: 1 });
    expect(built.budgetMismatch).toBe(false);
  });
});
