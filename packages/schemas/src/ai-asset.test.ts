import { describe, expect, it } from 'vitest';

import {
  AiAssetGenerateRequestSchema,
  GenerationMetadataSchema,
  VisualBriefSchema,
  type GenerationMetadata,
  type VisualBrief,
} from './ai-asset.js';

/**
 * AI 生成契约（TP-4-01/04，设计稿 11.1、14.3、二十章）。
 *
 * 两条断言对应两个验收点：
 *   - **非受控类型被拒**（TP-4-01 的验证条目）。14.3 的「只允许受控类型」
 *     必须是白名单，否则新增角色会默默获得生成权限。
 *   - **`generation_metadata` 九个字段齐全**（验收标准 12 的判定依据）。
 *     迁移 0005 的 CHECK 只能验「非空」，验不了「有没有 seed」。
 */

const brief: VisualBrief = {
  task: 'GENERATE_TRAVEL_HERO',
  destination: '杭州',
  theme: '运河人文·古今交融',
  elements: ['江南石桥', '运河游船'],
  style: 'Chinese travel editorial illustration',
  palette: ['fresh green', 'warm gold'],
  layout: {
    reserved_text_area: 'LEFT_TOP',
    subject_area: 'RIGHT_AND_BOTTOM',
    aspect_ratio: '16:6',
  },
  negative_requirements: ['no text', 'no logo'],
};

const metadata: GenerationMetadata = {
  generated_model: 'image-model-name',
  model_version: '2026-05-01',
  generated_at: '2026-08-17T10:23:11+08:00',
  prompt_template_version: 'hero_v3',
  visual_brief: brief,
  negative_requirements: ['no text', 'no logo'],
  seed: 918273,
  cost_units: 1,
  cache_key: 'hero:v1:cn_hangzhou:canal_culture:chinese_travel_editorial:16x6',
};

describe('11.1 VisualBrief', () => {
  it('接受 11.1 示例的形状', () => {
    expect(VisualBriefSchema.parse(brief)).toEqual(brief);
  });

  it('负向要求不得为空数组（11.3 至少四条禁止项）', () => {
    expect(VisualBriefSchema.safeParse({ ...brief, negative_requirements: [] }).success).toBe(
      false,
    );
  });

  it('比例必须是 `宽:高`（与缓存键同一格式约束）', () => {
    expect(
      VisualBriefSchema.safeParse({ ...brief, layout: { ...brief.layout, aspect_ratio: '2.67' } })
        .success,
    ).toBe(false);
  });

  it('多传的用户私有字段被剥掉，不会落进 generation_metadata（二十章）', () => {
    const parsed = VisualBriefSchema.parse({ ...brief, user_id: 'u_1', start_date: '2026-09-01' });
    expect(Object.keys(parsed)).not.toContain('user_id');
    expect(Object.keys(parsed)).not.toContain('start_date');
  });
});

describe('二十章 generation_metadata', () => {
  it('接受完整结构', () => {
    expect(GenerationMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it.each([
    'generated_model',
    'model_version',
    'generated_at',
    'prompt_template_version',
    'visual_brief',
    'seed',
    'cost_units',
    'cache_key',
  ])('缺 %s 被拒', (field) => {
    const partial: Record<string, unknown> = { ...metadata };
    delete partial[field];
    expect(GenerationMetadataSchema.safeParse(partial).success).toBe(false);
  });
});

describe('14.3 请求体', () => {
  const request = {
    asset_type: 'HERO_ILLUSTRATION',
    brief,
    cache_key: 'hero:v1:cn_hangzhou:canal_culture:chinese_travel_editorial:16x6',
    min_width: 1600,
  };

  it('四种受控类型被接受', () => {
    for (const type of [
      'HERO_ILLUSTRATION',
      'DECORATIVE_ILLUSTRATION',
      'FOOD_FALLBACK',
      'DESTINATION_ILLUSTRATION_FALLBACK',
    ]) {
      expect(AiAssetGenerateRequestSchema.safeParse({ ...request, asset_type: type }).success).toBe(
        true,
      );
    }
  });

  it.each(['ROUTE_MAP', 'ROUTE_MAP_ILLUSTRATION', 'HERO_BACKGROUND', ''])(
    '非受控类型 %s 被拒（14.3 白名单）',
    (type) => {
      expect(AiAssetGenerateRequestSchema.safeParse({ ...request, asset_type: type }).success).toBe(
        false,
      );
    },
  );

  it('缓存键必填 —— 不带键的 AI 图永远不会被复用（19.5）', () => {
    expect(AiAssetGenerateRequestSchema.safeParse({ ...request, cache_key: '' }).success).toBe(
      false,
    );
  });
});
