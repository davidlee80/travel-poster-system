import { describe, expect, it } from 'vitest';
import {
  ASSET_ROLE_VALUES,
  AssetRequirementSchema,
  AssetResolveResponseSchema,
  ROLE_ASSET_TYPE,
  REQUIRED_ROLES,
  ResolvedAssetSchema,
  SCHEMA_VERSIONS,
  aspectRatioValue,
  type AssetRequirement,
  type AssetRequirementItem,
  type ResolvedAsset,
} from './index.js';

/**
 * 七章 / 八章契约（TP-3-02）。
 *
 * 这些断言的对象不是「schema 能不能通过合法数据」，而是**每一条 refine 是否
 * 真的拦得住它要拦的东西**。少写一条的表现都不是崩溃，而是页面上某个位置
 * 静默变成空白 —— 而任务状态是成功的。
 */

function heroRequirement(overrides: Partial<AssetRequirementItem> = {}): AssetRequirementItem {
  return {
    slot_id: 'day_1.hero_background',
    day_number: 1,
    role: 'HERO_BACKGROUND',
    asset_type: 'AI_ILLUSTRATION',
    required: true,
    subject: {
      destination: '杭州',
      destination_place_id: 'cn-hangzhou',
      theme: '运河人文·古今交融',
      entities: ['拱宸桥', '大运河'],
    },
    visual_constraints: {
      aspect_ratio: '16:6',
      min_width: 1600,
      style: 'CHINESE_TRAVEL_EDITORIAL',
      avoid_text: true,
      avoid_logo: true,
    },
    ...overrides,
  };
}

function envelope(items: readonly AssetRequirementItem[]): AssetRequirement {
  return {
    schema_version: SCHEMA_VERSIONS.assetRequirement,
    plan_id: 'plan_123',
    plan_version_id: 'version_3',
    template_id: 'ink_paper_v1',
    requirements: [...items],
  };
}

describe('AssetRequirement（七章）', () => {
  it('七章示例的四个槽位全部通过校验', () => {
    const result = AssetRequirementSchema.safeParse(
      envelope([
        heroRequirement(),
        {
          slot_id: 'day_3.food.breakfast',
          day_number: 3,
          role: 'FOOD_IMAGE',
          asset_type: 'PHOTO_OR_AI',
          required: false,
          subject: { entity_name: '葱包桧', destination: '杭州' },
          visual_constraints: {
            aspect_ratio: '4:3',
            min_width: 600,
            style: 'REALISTIC_FOOD_PHOTOGRAPHY',
          },
        },
        {
          slot_id: 'day_3.photo_spot.1',
          day_number: 3,
          role: 'DESTINATION_PHOTO',
          asset_type: 'REAL_PHOTO_PREFERRED',
          required: false,
          subject: { entity_name: '拱宸桥', destination: '杭州' },
          visual_constraints: { aspect_ratio: '16:9', min_width: 800 },
        },
        {
          slot_id: 'day_3.route_map',
          day_number: 3,
          role: 'ROUTE_MAP',
          asset_type: 'GENERATED_SVG',
          required: true,
          route_data: {
            nodes: [{ name: '拱宸桥', latitude: 30.3201, longitude: 120.1421 }],
            style: 'CANAL_GREEN',
          },
          visual_constraints: { aspect_ratio: '3:2', min_width: 1200 },
        },
      ] as AssetRequirementItem[]),
    );

    expect(result.success).toBe(true);
  });

  it('角色与素材类型的搭配必须符合九章（AI 实拍景点图被拒）', () => {
    const bad = AssetRequirementSchema.safeParse(
      envelope([
        {
          ...heroRequirement(),
          slot_id: 'day_1.photo_spot.1',
          role: 'DESTINATION_PHOTO',
          // 9.4 规定景点图是 REAL_PHOTO_PREFERRED；写成 AI_ILLUSTRATION
          // 等于绕过「AI 景点图必须标示意图」那一整条规则
          asset_type: 'AI_ILLUSTRATION',
          required: false,
        },
      ]),
    );

    expect(bad.success).toBe(false);
  });

  it('四个角色的允许类型表是穷尽的', () => {
    // 新增角色时忘了补 ROLE_ASSET_TYPE 的表现是那类槽位永远校验失败
    for (const role of ASSET_ROLE_VALUES) {
      expect(ROLE_ASSET_TYPE[role]).toBeTruthy();
    }
  });

  it('ROUTE_MAP 缺 route_data 被拒；其余角色缺 subject 被拒', () => {
    const noRoute = AssetRequirementSchema.safeParse(
      envelope([
        {
          slot_id: 'day_1.route_map',
          day_number: 1,
          role: 'ROUTE_MAP',
          asset_type: 'GENERATED_SVG',
          required: true,
          subject: { destination: '杭州' },
          visual_constraints: { aspect_ratio: '3:2', min_width: 1200 },
        },
      ]),
    );
    expect(noRoute.success).toBe(false);

    const noSubject = AssetRequirementSchema.safeParse(
      envelope([{ ...heroRequirement(), subject: null }]),
    );
    expect(noSubject.success).toBe(false);
  });

  it('必需素材只有 HERO_BACKGROUND 与 ROUTE_MAP（16.3）', () => {
    expect([...REQUIRED_ROLES]).toEqual(['HERO_BACKGROUND', 'ROUTE_MAP']);

    const wrong = AssetRequirementSchema.safeParse(
      envelope([
        {
          slot_id: 'day_1.food.lunch',
          day_number: 1,
          role: 'FOOD_IMAGE',
          asset_type: 'PHOTO_OR_AI',
          // 美食图标成必需会让「没找到合适的美食图」变成任务失败，
          // 而 16.3 给它的降级是「默认占位图」
          required: true,
          subject: { entity_name: '片儿川', destination: '杭州' },
          visual_constraints: { aspect_ratio: '4:3', min_width: 600 },
        },
      ]),
    );
    expect(wrong.success).toBe(false);

    const heroNotRequired = AssetRequirementSchema.safeParse(
      envelope([heroRequirement({ required: false })]),
    );
    expect(heroNotRequired.success).toBe(false);
  });

  it('slot_id 重复被拒（3.3.1 跨页合并必须去重）', () => {
    const duplicated = AssetRequirementSchema.safeParse(
      envelope([heroRequirement(), heroRequirement()]),
    );
    expect(duplicated.success).toBe(false);
  });

  it.each([
    ['16:6', 16 / 6],
    ['4:3', 4 / 3],
    ['1:1', 1],
    ['9:16', 9 / 16],
  ])('比例 %s 解析为数值 %f', (ratio, expected) => {
    expect(aspectRatioValue(ratio)).toBeCloseTo(expected, 6);
  });

  it.each(['16x6', '16:0', '0:9', '16/9', '', '16:'])('非法比例 %s 被拒', (ratio) => {
    const result = AssetRequirementSchema.safeParse(
      envelope([
        heroRequirement({
          visual_constraints: { aspect_ratio: ratio, min_width: 1600 },
        }),
      ]),
    );
    expect(result.success).toBe(false);
  });
});

// ── 八章 ────────────────────────────────────────────────────

function photoAsset(): ResolvedAsset {
  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: 'day_3.photo_spot.1',
    status: 'RESOLVED',
    asset: {
      asset_id: 'asset_789',
      asset_type: 'IMAGE',
      source_type: 'PLATFORM_LIBRARY',
      representation_type: 'PHOTOGRAPHIC',
      mime_type: 'image/webp',
      urls: {
        original: 'https://cdn.example.com/assets/asset_789.webp',
        thumbnail: 'https://cdn.example.com/assets/asset_789-thumb.webp',
      },
      width: 1200,
      height: 675,
      aspect_ratio: 1.7778,
      metadata: { entity_name: '拱宸桥', destination: '杭州', style_tags: ['bridge', 'canal'] },
      license: { type: 'PLATFORM_OWNED', attribution_required: false },
    },
    resolution: { strategy: 'LOCAL_LIBRARY_MATCH', score: 0.92, fallback_level: 0 },
  };
}

describe('ResolvedAsset（八章）', () => {
  it('八章示例（平台素材命中）通过校验', () => {
    expect(ResolvedAssetSchema.safeParse(photoAsset()).success).toBe(true);
  });

  it('8.2 的 SVG 路线图通过校验，且 thumbnail 为 null', () => {
    const svg = ResolvedAssetSchema.safeParse({
      schema_version: SCHEMA_VERSIONS.resolvedAsset,
      slot_id: 'day_3.route_map',
      status: 'RESOLVED',
      asset: {
        asset_id: 'asset_map_1',
        asset_type: 'SVG',
        source_type: 'GENERATED_SVG',
        representation_type: 'ILLUSTRATIVE',
        mime_type: 'image/svg+xml',
        urls: { original: 'https://cdn.example.com/assets/asset_map_1.svg', thumbnail: null },
        width: 1200,
        height: 800,
        aspect_ratio: 1.5,
        metadata: { route_node_hash: 'a3f9c1d2', map_style: 'CANAL_GREEN', node_count: 4 },
        license: { type: 'PLATFORM_OWNED', attribution_required: false },
      },
      resolution: { strategy: 'SVG_RENDER', score: 1.0, fallback_level: 0 },
    });

    expect(svg.success).toBe(true);
  });

  it('FALLBACK + asset 为 null 时 text_fallback 必填（8.2）', () => {
    const base = {
      schema_version: SCHEMA_VERSIONS.resolvedAsset,
      slot_id: 'day_3.route_map',
      status: 'FALLBACK' as const,
      asset: null,
      resolution: { strategy: 'TEXT_FALLBACK' as const, score: 0, fallback_level: 2 },
    };

    expect(ResolvedAssetSchema.safeParse(base).success).toBe(false);

    const withFallback = ResolvedAssetSchema.safeParse({
      ...base,
      text_fallback: {
        kind: 'ROUTE_NODE_LIST',
        nodes: ['拱宸桥', '中国大运河博物馆', '中国丝绸博物馆', '大兜路'],
      },
    });
    expect(withFallback.success).toBe(true);
  });

  it('空的 text_fallback 节点列表被拒（模板会渲染出一个空列表）', () => {
    const result = ResolvedAssetSchema.safeParse({
      schema_version: SCHEMA_VERSIONS.resolvedAsset,
      slot_id: 'day_3.route_map',
      status: 'FALLBACK',
      asset: null,
      text_fallback: { kind: 'ROUTE_NODE_LIST', nodes: [] },
      resolution: { strategy: 'TEXT_FALLBACK', score: 0, fallback_level: 2 },
    });
    expect(result.success).toBe(false);
  });

  it('AI 生成物标成 PHOTOGRAPHIC 被拒（9.4、二十章）', () => {
    const asset = photoAsset();
    const result = ResolvedAssetSchema.safeParse({
      ...asset,
      asset: { ...asset.asset!, source_type: 'AI_GENERATED', representation_type: 'PHOTOGRAPHIC' },
    });
    expect(result.success).toBe(false);
  });

  it('需要署名却没有署名文案被拒', () => {
    const asset = photoAsset();
    const result = ResolvedAssetSchema.safeParse({
      ...asset,
      asset: {
        ...asset.asset!,
        license: { type: 'LICENSED', attribution_required: true, attribution_text: '  ' },
      },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['RESOLVED 无素材', { status: 'RESOLVED', asset: null }],
    ['SKIPPED 带素材', { status: 'SKIPPED' }],
    ['FAILED 带素材', { status: 'FAILED' }],
  ])('%s 被拒（8.1 语义表）', (_label, patch) => {
    const result = ResolvedAssetSchema.safeParse({ ...photoAsset(), ...patch });
    expect(result.success).toBe(false);
  });

  it('CACHE_HIT 的 score 必须为 1.0（19.4）', () => {
    const asset = photoAsset();
    const wrong = ResolvedAssetSchema.safeParse({
      ...asset,
      resolution: { strategy: 'CACHE_HIT', score: 0.92, fallback_level: 0 },
    });
    expect(wrong.success).toBe(false);

    const right = ResolvedAssetSchema.safeParse({
      ...asset,
      resolution: { strategy: 'CACHE_HIT', score: 1, fallback_level: 0 },
    });
    expect(right.success).toBe(true);
  });

  it('14.1 响应体按 status 分三组', () => {
    const result = AssetResolveResponseSchema.safeParse({
      status: 'COMPLETED',
      resolved: [photoAsset()],
      fallbacks: [],
      failed_optional: [],
    });
    expect(result.success).toBe(true);
  });
});
