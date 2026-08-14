import { describe, expect, it } from 'vitest';
import {
  MODULE_ICON_KEYS,
  TRAVEL_PLAN_FIXTURES,
  TravelPosterViewModelSchema,
  makeTravelPlanFixture,
  type TravelPlan,
} from '@tps/schemas';
import { buildDailyPoster, PresentationError, type AssetLookup } from './build-view-model.js';
import { foodSlotId, heroSlotId, photoSpotSlotId, routeMapSlotId } from './slots.js';

function build(plan: TravelPlan, dayNumber: number, assets?: AssetLookup) {
  return buildDailyPoster(assets ? { plan, dayNumber, assets } : { plan, dayNumber });
}

describe('buildDailyPoster', () => {
  it('产出通过 ViewModel schema 校验的对象', () => {
    const plan = TRAVEL_PLAN_FIXTURES.sevenDays();
    const { viewModel } = build(plan, 3);

    const result = TravelPosterViewModelSchema.safeParse(viewModel);
    if (!result.success) {
      throw new Error(`ViewModel 校验失败: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  it.each([1, 7, 14])('%i 天计划的每一天都能产出合法 ViewModel', (totalDays) => {
    const plan = makeTravelPlanFixture({ totalDays });

    for (let day = 1; day <= totalDays; day += 1) {
      const { viewModel } = build(plan, day);
      expect(TravelPosterViewModelSchema.safeParse(viewModel).success).toBe(true);
      expect(viewModel.day_number).toBe(day);
      expect(viewModel.header.day_label).toBe(`DAY ${day}`);
    }
  });

  it('不存在的天号抛出可诊断的错误', () => {
    const plan = TRAVEL_PLAN_FIXTURES.oneDay();

    expect(() => build(plan, 5)).toThrow(PresentationError);
    expect(() => build(plan, 5)).toThrow(/不存在第 5 天/);
  });

  it('DAILY_POSTER 的 page_type 与 day_number 绑定关系正确（3.3.1）', () => {
    const { viewModel } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);

    expect(viewModel.page_type).toBe('DAILY_POSTER');
    expect(viewModel.day_number).toBe(1);
  });

  it('icons 含全部 8 个模块键（9.1 / 12.2 对齐后的清单）', () => {
    const { viewModel } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);

    expect(Object.keys(viewModel.icons).sort()).toEqual([...MODULE_ICON_KEYS].sort());
    for (const key of MODULE_ICON_KEYS) {
      expect(viewModel.icons[key]).toMatch(/^\/icons\/travel\/.+\.svg$/);
    }
  });

  it('全部展示文案已是中文，模板无需再做映射', () => {
    const { viewModel } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);

    // 枚举原值不应泄漏到 ViewModel 的展示字段
    for (const item of viewModel.schedule) {
      expect(item.period).not.toMatch(/^[A-Z_]+$/);
    }
    for (const card of viewModel.food_cards) {
      expect(card.meal).not.toMatch(/^[A-Z_]+$/);
    }
    for (const tip of viewModel.booking_tips) {
      expect(tip.category_text).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('12.3 压缩文案成对存在', () => {
  it('每个可压缩字段都有 *_compact', () => {
    const { viewModel } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);

    expect(viewModel.header.title_compact).toBeTypeOf('string');
    expect(viewModel.header.subtitle_compact).toBeTypeOf('string');
    expect(viewModel.daily_summary_compact).toBeTypeOf('string');
    for (const item of viewModel.schedule) {
      expect(item.description_compact).toBeTypeOf('string');
    }
    for (const card of viewModel.food_cards) {
      expect(card.description_compact).toBeTypeOf('string');
    }
  });

  it('原文已达标时 *_compact 等于原文（避免无谓降级）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    plan.days[0]!.theme = '短标题';
    plan.days[0]!.daily_summary = '很短';

    const { viewModel } = build(plan, 1);

    expect(viewModel.header.title_compact).toBe('短标题');
    expect(viewModel.daily_summary_compact).toBe('很短');
  });

  it('超长原文被压缩到限长内', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    plan.days[0]!.theme = '运河人文与古今交融的深度体验之旅，非常适合慢节奏的旅行者细细品味';

    const { viewModel } = build(plan, 1);

    expect(viewModel.header.title).toBe(plan.days[0]!.theme);
    expect(viewModel.header.title_compact.length).toBeLessThanOrEqual(18);
    expect(viewModel.header.title_compact.length).toBeGreaterThan(0);
  });
});

describe('预算模块（12.1、V-20）', () => {
  it('items 逐条映射 breakdown，总额取 breakdown 之和', () => {
    const { viewModel, budgetMismatch } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);
    const breakdown = TRAVEL_PLAN_FIXTURES.oneDay().days[0]!.daily_budget.breakdown;

    expect(budgetMismatch).toBe(false);
    expect(viewModel.budget.items).toHaveLength(breakdown.length);
    expect(viewModel.budget.items.map((i) => i.label)).toEqual(breakdown.map((b) => b.label));

    const sum = breakdown.reduce((acc, b) => acc + b.amount, 0);
    expect(viewModel.budget.total_text).toBe(`约 ¥${sum} / 人`);
  });

  it('设计稿示例：breakdown 之和 105 → 「约 ¥105 / 人」', () => {
    const { viewModel } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);
    expect(viewModel.budget.total_text).toBe('约 ¥105 / 人');
  });

  it('total 与 breakdown 之和不一致时上报 budgetMismatch 而不是抛错（V-20 是 REPAIRABLE）', () => {
    const plan = makeTravelPlanFixture({ totalDays: 1 });
    plan.days[0]!.daily_budget.total = 99999;

    const { viewModel, budgetMismatch } = build(plan, 1);

    expect(budgetMismatch).toBe(true);
    // 以 breakdown 之和为准，避免页面上「各项相加 ≠ 总计」
    expect(viewModel.budget.total_text).toBe('约 ¥105 / 人');
  });
});

describe('素材注入与降级', () => {
  it('无素材时全部图片为 null，Hero 为 null（模板改用渐变背景）', () => {
    const { viewModel } = build(TRAVEL_PLAN_FIXTURES.oneDay(), 1);

    expect(viewModel.header.hero_asset).toBeNull();
    expect(viewModel.route_map.svg_url).toBeNull();
    expect(viewModel.food_cards.every((c) => c.image === null)).toBe(true);
    expect(viewModel.photo_spots.every((s) => s.image === null)).toBe(true);
  });

  it('route_map.nodes 始终提供，即使没有 SVG（8.2 文字路线降级）', () => {
    const plan = TRAVEL_PLAN_FIXTURES.oneDay();
    const { viewModel } = build(plan, 1);

    expect(viewModel.route_map.svg_url).toBeNull();
    expect(viewModel.route_map.nodes).toEqual(plan.days[0]!.schedule.map((s) => s.location.name));
    expect(viewModel.route_map.nodes.length).toBeGreaterThan(0);
  });

  it('按槽位 ID 注入的素材出现在正确位置', () => {
    const plan = TRAVEL_PLAN_FIXTURES.oneDay();
    const day = plan.days[0]!;

    const lookup: AssetLookup = (slotId) => {
      if (slotId === heroSlotId(1)) {
        return {
          image: null,
          hero: { asset_id: 'a_hero', url: 'https://cdn/hero.webp', source_type: 'AI_GENERATED' },
        };
      }
      if (slotId === routeMapSlotId(1)) {
        return { image: null, svgUrl: 'https://cdn/map.svg' };
      }
      if (slotId === foodSlotId(1, 'BREAKFAST')) {
        return { image: { asset_id: 'a_food', url: 'https://cdn/food.webp', source_note: null } };
      }
      if (slotId === photoSpotSlotId(1, 0)) {
        return {
          image: { asset_id: 'a_photo', url: 'https://cdn/photo.webp', source_note: '示意图' },
        };
      }
      return undefined;
    };

    const { viewModel } = build(plan, 1, lookup);

    expect(viewModel.header.hero_asset?.asset_id).toBe('a_hero');
    expect(viewModel.route_map.svg_url).toBe('https://cdn/map.svg');

    const breakfastIndex = day.food_recommendations.findIndex((f) => f.meal === 'BREAKFAST');
    expect(viewModel.food_cards[breakfastIndex]?.image?.asset_id).toBe('a_food');
    // 未注入的餐次仍为 null
    const lunchIndex = day.food_recommendations.findIndex((f) => f.meal === 'LUNCH');
    expect(viewModel.food_cards[lunchIndex]?.image).toBeNull();

    expect(viewModel.photo_spots[0]?.image?.source_note).toBe('示意图');
    expect(viewModel.photo_spots[1]?.image).toBeNull();
  });
});

describe('槽位 ID 的确定性（plan_asset_bindings 唯一约束依赖它）', () => {
  it('同一位置重复生成结果一致', () => {
    expect(heroSlotId(3)).toBe('day_3.hero_background');
    expect(routeMapSlotId(3)).toBe('day_3.route_map');
    expect(foodSlotId(3, 'BREAKFAST')).toBe('day_3.food.breakfast');
    expect(photoSpotSlotId(3, 0)).toBe('day_3.photo_spot.1');
  });

  it('不同天/不同位置的槽位 ID 互不相同', () => {
    const ids = new Set<string>();
    for (let day = 1; day <= 14; day += 1) {
      ids.add(heroSlotId(day));
      ids.add(routeMapSlotId(day));
      for (const meal of ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as const) {
        ids.add(foodSlotId(day, meal));
      }
      for (let i = 0; i < 3; i += 1) {
        ids.add(photoSpotSlotId(day, i));
      }
    }
    // 14 天 × (1 hero + 1 map + 4 food + 3 photo) = 126
    expect(ids.size).toBe(14 * 9);
  });
});
