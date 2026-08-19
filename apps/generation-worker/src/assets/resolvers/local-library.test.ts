import type { AssetCandidateRow, AssetsRepository, FindCandidatesQuery } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import { ResolvedAssetSchema, type AssetRequirementItem } from '@tps/schemas';
import { createSilentLogger } from '@tps/shared';
import { describe, expect, it } from 'vitest';
import { resolveFromLocalLibrary, scoreCandidates } from './local-library.js';

/**
 * local-library resolver（TP-3-09）。
 *
 * 用假仓储与假向量器，覆盖三条路径：命中、未达阈值、超时。
 */

function requirement(overrides: Partial<AssetRequirementItem> = {}): AssetRequirementItem {
  return {
    slot_id: 'day_1.photo_spot.1',
    day_number: 1,
    role: 'DESTINATION_PHOTO',
    asset_type: 'REAL_PHOTO_PREFERRED',
    required: false,
    subject: {
      destination: '杭州',
      destination_place_id: 'cn-hangzhou',
      entity_name: '拱宸桥',
      entity_place_id: 'hz-gongchen-bridge',
    },
    visual_constraints: { aspect_ratio: '16:9', min_width: 800 },
    ...overrides,
  };
}

function row(overrides: Partial<AssetCandidateRow> = {}): AssetCandidateRow {
  return {
    assetId: 'asset-1',
    entityName: '拱宸桥',
    destinationName: '杭州',
    destinationPlaceId: 'cn-hangzhou',
    assetType: 'IMAGE',
    sourceType: 'PLATFORM_LIBRARY',
    representationType: 'PHOTOGRAPHIC',
    mimeType: 'image/webp',
    storageUrl: 'https://cdn.example.com/a.webp',
    thumbnailUrl: 'https://cdn.example.com/a-thumb.webp',
    width: 1600,
    height: 900,
    aspectRatio: 16 / 9,
    qualityScore: 0.9,
    licenseType: 'PLATFORM_OWNED',
    attributionText: null,
    styleTags: ['bridge'],
    cosine: 0.9,
    ...overrides,
  };
}

function repository(rows: readonly AssetCandidateRow[]): {
  repo: AssetsRepository;
  queries: FindCandidatesQuery[];
} {
  const queries: FindCandidatesQuery[] = [];
  const repo: AssetsRepository = {
    findCandidates: (query) => {
      queries.push(query);
      return Promise.resolve(rows);
    },
    findByCacheKey: () => Promise.resolve(null),
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: () => Promise.resolve({ assetId: 'x', created: true }),
    insertVariant: () => Promise.resolve(),
  };
  return { repo, queries };
}

const embedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
};

const failingEmbedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: () => Promise.reject(new Error('向量服务不可用')),
};

const logger = createSilentLogger();

describe('命中', () => {
  it('高分候选产出 RESOLVED + LOCAL_LIBRARY_MATCH + fallback_level 0', async () => {
    const { repo } = repository([row()]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding, logger },
      requirement(),
    );

    expect(outcome.kind).toBe('hit');
    if (outcome.kind !== 'hit') return;

    const parsed = ResolvedAssetSchema.safeParse(outcome.resolved);
    expect(parsed.success).toBe(true);
    expect(outcome.resolved.resolution).toMatchObject({
      strategy: 'LOCAL_LIBRARY_MATCH',
      fallback_level: 0,
    });
    expect(outcome.resolved.asset?.urls.original).toBe('https://cdn.example.com/a.webp');
    expect(outcome.resolved.slot_id).toBe('day_1.photo_spot.1');
  });

  it('检索带上实体与目的地两个预过滤维度（10.2 第 1 步）', async () => {
    const { repo, queries } = repository([row()]);
    await resolveFromLocalLibrary({ assets: repo, embedding, logger }, requirement());

    expect(queries[0]).toMatchObject({
      assetType: 'IMAGE',
      entityName: '拱宸桥',
      destinationPlaceId: 'cn-hangzhou',
      destinationName: '杭州',
      limit: 30,
    });
    expect(queries[0]!.embedding).toEqual([1, 0, 0, 0]);
  });

  it('需署名的素材带上署名文案（否则 schema 会拒）', async () => {
    const { repo } = repository([
      row({ licenseType: 'LICENSED', attributionText: '© 某摄影师 / CC BY 4.0' }),
    ]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding, logger },
      requirement(),
    );

    expect(outcome.kind).toBe('hit');
    if (outcome.kind !== 'hit') return;
    expect(outcome.resolved.asset?.license).toMatchObject({
      type: 'LICENSED',
      attribution_required: true,
      attribution_text: '© 某摄影师 / CC BY 4.0',
    });
    expect(ResolvedAssetSchema.safeParse(outcome.resolved).success).toBe(true);
  });

  it('向量化失败仍然检索（退化为按质量排序）', async () => {
    const { repo, queries } = repository([row({ cosine: null })]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding: failingEmbedding, logger },
      requirement(),
    );

    expect(queries[0]!.embedding).toBeNull();
    // 语义项按中性 0.5 计入，其余项满分 → 仍然达标
    expect(outcome.kind).toBe('hit');
  });
});

describe('未命中', () => {
  it('没有候选 → empty', async () => {
    const { repo } = repository([]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding, logger },
      requirement(),
    );

    expect(outcome).toEqual({ kind: 'miss', bestScore: null, reason: 'empty' });
  });

  it('最高分低于 0.65 → below_threshold，并带回最高分', async () => {
    const { repo } = repository([
      row({ entityName: '灵隐寺', cosine: -0.5, qualityScore: 0.1, width: 800, height: 450 }),
    ]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding, logger },
      requirement(),
    );

    expect(outcome.kind).toBe('miss');
    if (outcome.kind !== 'miss') return;
    expect(outcome.reason).toBe('below_threshold');
    expect(outcome.bestScore).not.toBeNull();
    expect(outcome.bestScore!).toBeLessThan(0.65);
  });

  it('进入函数时已超预算 → timeout，且不查库', async () => {
    const { repo, queries } = repository([row()]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding, logger, now: () => 5_000 },
      requirement(),
      { deadline: 1_000 },
    );

    expect(outcome).toEqual({ kind: 'miss', bestScore: null, reason: 'timeout' });
    // 超时后不该再发查询 —— 它只会让这个槽位更晚返回
    expect(queries).toHaveLength(0);
  });

  it('缺尺寸或 MIME 的行在打分前被剔除', async () => {
    /*
     * 这类行不是「分低」而是不可用：ResolvedAsset 要求正整数宽高。
     * 分辨率项只占 0.05 权重，缺宽高的行仍可能拿到 0.7 分被采用，
     * 然后在模板里渲染成一条缝。
     */
    const { repo } = repository([row({ width: null, height: null })]);
    const outcome = await resolveFromLocalLibrary(
      { assets: repo, embedding, logger },
      requirement(),
    );

    expect(outcome).toEqual({ kind: 'miss', bestScore: null, reason: 'empty' });
  });
});

describe('分数分布（TP-3-09 的报告口径）', () => {
  it('按分数降序返回，便于统计分布', () => {
    const scored = scoreCandidates(requirement(), [
      row({ assetId: 'low', entityName: '灵隐寺', cosine: 0, qualityScore: 0.2 }),
      row({ assetId: 'high' }),
      row({ assetId: 'mid', entityName: '拱宸桥历史街区', cosine: 0.2 }),
    ]);

    expect(scored.map((s) => s.assetId)).toEqual(['high', 'mid', 'low']);
    expect(scored[0]!.score).toBeGreaterThan(scored[2]!.score);
  });
});
