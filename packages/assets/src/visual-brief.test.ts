import {
  AI_ASSET_TYPE_VALUES,
  AssetRequirementItemSchema,
  VisualBriefSchema,
  type AssetRequirementItem,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  AI_ASSET_TYPE_BY_ROLE,
  NEGATIVE_REQUIREMENTS,
  briefForRequirement,
  buildVisualBrief,
  imageSizeFor,
  renderNegativePrompt,
  renderPrompt,
} from './visual-brief.js';

/**
 * 11.1 视觉 Brief 与 11.3 禁止项（TP-4-01/02）。
 *
 * 这一组断言里最重要的是**负向提示词真的进了发给模型的那段文本**。
 * 11.3 的四条「不允许 AI 画的东西」只能靠提示词表达，而漏掉一条不会报错 ——
 * 它的表现是某张图上出现了假文字或价格标签，然后那张图进了用户的 PDF。
 */

function heroItem(overrides: Partial<AssetRequirementItem> = {}): AssetRequirementItem {
  return AssetRequirementItemSchema.parse({
    slot_id: 'day_3.hero_background',
    day_number: 3,
    role: 'HERO_BACKGROUND',
    asset_type: 'AI_ILLUSTRATION',
    required: true,
    subject: {
      destination: '杭州',
      destination_place_id: 'cn_hangzhou',
      theme: '运河人文·古今交融',
      entities: ['拱宸桥', '运河游船', '桥西历史街区', '拱宸桥'],
    },
    visual_constraints: {
      aspect_ratio: '16:6',
      min_width: 1600,
      style: 'CHINESE_TRAVEL_EDITORIAL',
      avoid_text: true,
      avoid_logo: true,
    },
    ...overrides,
  });
}

describe('11.1 Brief 构造', () => {
  it('Hero 的 Brief 与 11.1 的示例同构', () => {
    const brief = buildVisualBrief({
      role: 'HERO_BACKGROUND',
      destination: '杭州',
      theme: '运河人文·古今交融',
      elements: ['江南石桥', '运河游船', '现代博物馆', '临水历史街区'],
      style: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    expect(VisualBriefSchema.parse(brief)).toEqual(brief);
    expect(brief.task).toBe('GENERATE_TRAVEL_HERO');
    expect(brief.style).toBe('Chinese travel editorial illustration');
    expect(brief.layout).toEqual({
      reserved_text_area: 'LEFT_TOP',
      subject_area: 'RIGHT_AND_BOTTOM',
      aspect_ratio: '16:6',
    });
    // 19.1 的桶：运河 → canal_culture，配色随桶而不是随短语
    expect(brief.palette).toEqual(['fresh green', 'warm gold', 'soft blue']);
  });

  it('Brief 里没有任何用户私有字段（二十章）', () => {
    const brief = buildVisualBrief({
      role: 'HERO_BACKGROUND',
      destination: '杭州',
      theme: '运河人文',
      elements: [],
      style: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    const keys = Object.keys(brief);
    for (const forbidden of ['user_id', 'plan_id', 'start_date', 'budget', 'travelers']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('元素去重并剔除空白项', () => {
    const brief = briefForRequirement(heroItem());
    // 输入里 `拱宸桥` 出现两次
    expect(brief?.elements).toEqual(['拱宸桥', '运河游船', '桥西历史街区']);
  });

  it('景点与美食图不留文字区，且只用自己作为元素', () => {
    const food = briefForRequirement(
      AssetRequirementItemSchema.parse({
        slot_id: 'day_1.food.lunch',
        day_number: 1,
        role: 'FOOD_IMAGE',
        asset_type: 'PHOTO_OR_AI',
        required: false,
        subject: { destination: '杭州', entity_name: '葱包桧', entities: ['其他菜'] },
        visual_constraints: { aspect_ratio: '4:3', min_width: 600 },
      }),
    );

    expect(food?.task).toBe('GENERATE_FOOD_ILLUSTRATION');
    expect(food?.theme).toBe('葱包桧');
    expect(food?.elements).toEqual(['葱包桧']);
    expect(food?.layout.reserved_text_area).toBe('NONE');
    // 未指定 style 时美食按 9.5 取写实食物摄影风格
    expect(food?.style).toContain('food photography');
  });

  it('ROUTE_MAP 不可生成（11.3 禁止 AI 绘制地图文字）', () => {
    const item = AssetRequirementItemSchema.parse({
      slot_id: 'day_1.route_map',
      day_number: 1,
      role: 'ROUTE_MAP',
      asset_type: 'GENERATED_SVG',
      required: true,
      route_data: { nodes: [{ name: 'A', latitude: 30, longitude: 120 }], style: 'CANAL_GREEN' },
      visual_constraints: { aspect_ratio: '3:2', min_width: 1200 },
    });

    expect(briefForRequirement(item)).toBeNull();
    expect(Object.keys(AI_ASSET_TYPE_BY_ROLE)).not.toContain('ROUTE_MAP');
  });

  it('景点槽位缺实体名时不生成（泛化风景冒充具体景点更糟）', () => {
    const item = AssetRequirementItemSchema.parse({
      slot_id: 'day_1.photo_spot.1',
      day_number: 1,
      role: 'DESTINATION_PHOTO',
      asset_type: 'REAL_PHOTO_PREFERRED',
      required: false,
      subject: { destination: '杭州', entity_name: '   ' },
      visual_constraints: { aspect_ratio: '16:9', min_width: 800 },
    });

    expect(briefForRequirement(item)).toBeNull();
  });

  it('四种受控类型（14.3）都能映射出 task', () => {
    // 覆盖到 DECORATIVE_ILLUSTRATION：它没有对应角色，但契约里必须存在
    expect(AI_ASSET_TYPE_VALUES).toHaveLength(4);
    expect(Object.values(AI_ASSET_TYPE_BY_ROLE)).toHaveLength(3);
  });
});

describe('11.3 禁止项进入提示词', () => {
  const brief = buildVisualBrief({
    role: 'HERO_BACKGROUND',
    destination: '杭州',
    theme: '运河人文·古今交融',
    elements: ['拱宸桥'],
    style: 'CHINESE_TRAVEL_EDITORIAL',
    aspectRatio: '16:6',
  });

  it.each([
    ['标题', 'no title'],
    ['文字', 'no text'],
    ['门票价格', 'no price tags'],
    ['地图文字', 'no map labels'],
    ['品牌 Logo', 'no logo'],
  ])('11.3 的「不绘制%s」在正向提示词里出现', (_label, phrase) => {
    expect(renderPrompt(brief)).toContain(phrase);
  });

  it('负向提示词与 Brief 的禁止项一字不差', () => {
    expect(renderNegativePrompt(brief)).toBe(NEGATIVE_REQUIREMENTS.join(', '));
  });

  it('留白说成正向要求，不进负向清单', () => {
    const prompt = renderPrompt(brief);
    expect(prompt).toContain('top-left');
    expect(NEGATIVE_REQUIREMENTS.join(' ')).not.toContain('top');
  });

  it('提示词是纯函数：同一 Brief 渲染两次完全相同', () => {
    expect(renderPrompt(brief)).toBe(renderPrompt(brief));
  });
});

describe('请求尺寸', () => {
  it.each([
    ['16:6', 1600, 1600, 600],
    ['4:3', 600, 600, 448],
    ['16:9', 800, 800, 448],
  ])('%s + min_width %d → %dx%d', (ratio, minWidth, width, height) => {
    expect(imageSizeFor(ratio, minWidth)).toEqual({ width, height });
  });

  it('宽度对齐到 8 的倍数（扩散模型的边长约束）', () => {
    expect(imageSizeFor('1:1', 1001).width % 8).toBe(0);
  });

  it('产物比例落在 11.2 第 3 步的容差内（半个八度）', () => {
    for (const [ratio, minWidth] of [
      ['16:6', 1600],
      ['4:3', 600],
      ['16:9', 800],
      ['3:2', 1200],
    ] as const) {
      const size = imageSizeFor(ratio, minWidth);
      const [w, h] = ratio.split(':').map(Number) as [number, number];
      const drift = Math.abs(Math.log2(size.width / size.height / (w / h)));
      expect(drift).toBeLessThan(0.5);
    }
  });
});
