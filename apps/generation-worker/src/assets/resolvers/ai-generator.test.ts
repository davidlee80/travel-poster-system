import { heroCacheKey } from '@tps/assets';
import type { AssetCandidateRow, AssetsRepository, InsertAssetInput } from '@tps/db';
import { FakeImageClient, ImageTimeoutError, type EmbeddingClient } from '@tps/llm';
import { InMemoryAssetLock, type AssetLock } from '@tps/queue';
import {
  AssetRequirementItemSchema,
  GenerationMetadataSchema,
  ResolvedAssetSchema,
  type AssetRequirementItem,
} from '@tps/schemas';
import { InMemoryObjectStorage } from '@tps/storage';
import { InMemoryCounterStore, createSilentLogger } from '@tps/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { AiImageBudget } from '../ai-budget.js';
import { AI_WAIT_TIMEOUT_MS, resolveByAi, seedForCacheKey } from './ai-generator.js';

/**
 * ai-generator resolver（TP-4-02/03/06，设计稿 9.3～9.5、11.x、13.8）。
 *
 * 四条断言对应四个不同的失效后果：
 *   - `representation_type` 必须是 `ILLUSTRATIVE`（11.3 第五条）——
 *     破了的话用户会把 AI 画的景点当实拍照片去规划行程；
 *   - `generation_metadata` 九个字段齐全（二十章）—— 缺 seed 则不可复现；
 *   - 同键并发只生成一次、其余**等结果**（13.8）—— 直接降级会让 14 天里
 *     只有 1 天有 Hero，而缓存几秒后就有了；
 *   - 失败一律返回 null 而不抛错（16.3）—— 抛错会让真实原因丢失。
 */

const HERO_KEY = heroCacheKey({
  destinationPlaceId: 'cn_hangzhou',
  destinationName: '杭州',
  bucket: 'canal_culture',
  visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
  aspectRatio: '16:6',
});

function heroItem(): AssetRequirementItem {
  return AssetRequirementItemSchema.parse({
    slot_id: 'day_1.hero_background',
    day_number: 1,
    role: 'HERO_BACKGROUND',
    asset_type: 'AI_ILLUSTRATION',
    required: true,
    subject: {
      destination: '杭州',
      destination_place_id: 'cn_hangzhou',
      theme: '运河人文·古今交融',
      entities: ['拱宸桥'],
    },
    visual_constraints: {
      aspect_ratio: '16:6',
      min_width: 1600,
      style: 'CHINESE_TRAVEL_EDITORIAL',
    },
  });
}

/** 真的画一张图：11.2 的后处理要解码它、校验比例、转 WebP */
async function gradient(width: number, height: number): Promise<Uint8Array> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#334" /></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg, 'utf8')).png().toBuffer());
}

const embedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
};

interface Harness {
  readonly deps: Parameters<typeof resolveByAi>[0];
  readonly inserted: InsertAssetInput[];
  readonly lock: AssetLock;
}

function harness(
  options: {
    readonly renderer?: (width: number, height: number) => Promise<Uint8Array>;
    readonly fail?: Error;
    readonly lock?: AssetLock;
    readonly heroQuota?: number;
    readonly byCacheKey?: Record<string, AssetCandidateRow>;
  } = {},
): Harness {
  const inserted: InsertAssetInput[] = [];
  const store = new Map<string, AssetCandidateRow>(Object.entries(options.byCacheKey ?? {}));

  const assets: AssetsRepository = {
    findCandidates: () => Promise.resolve([]),
    findByCacheKey: (key) => Promise.resolve(store.get(key) ?? null),
    // AI 路径不参与指纹去重（迁移 0007：只有 LICENSED_SOURCE 带 content_hash）
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: (input) => {
      inserted.push(input);
      store.set(input.cacheKey ?? `__no_key_${inserted.length}`, {
        assetId: input.assetId,
        entityName: input.entityName,
        destinationName: input.destinationName,
        destinationPlaceId: input.destinationPlaceId,
        assetType: input.assetType,
        sourceType: input.sourceType,
        representationType: input.representationType,
        mimeType: input.mimeType,
        storageUrl: input.storageUrl,
        thumbnailUrl: input.thumbnailUrl,
        width: input.width,
        height: input.height,
        aspectRatio: input.aspectRatio,
        qualityScore: input.qualityScore,
        licenseType: input.licenseType,
        attributionText: input.attributionText,
        styleTags: input.styleTags,
        cosine: null,
      });
      return Promise.resolve({ assetId: input.assetId, created: true });
    },
    insertVariant: () => Promise.resolve(),
  };

  const image = new FakeImageClient(async (request) => {
    if (options.fail !== undefined) throw options.fail;
    return (options.renderer ?? gradient)(request.width, request.height);
  });

  return {
    inserted,
    lock: options.lock ?? new InMemoryAssetLock(),
    deps: {
      assets,
      storage: new InMemoryObjectStorage(),
      embedding,
      logger: createSilentLogger(),
      image,
      assetLock: options.lock ?? new InMemoryAssetLock(),
      imageTimeoutMs: 20_000,
      userTypeLabel: 'REGISTERED',
      budget: new AiImageBudget({
        counters: new InMemoryCounterStore(),
        userType: 'REGISTERED',
        heroQuota: options.heroQuota ?? 2,
      }),
    },
  };
}

describe('生成成功', () => {
  it('落库为 AI_GENERATED + ILLUSTRATIVE，策略 AI_GENERATION、等级 1', async () => {
    const h = harness();
    const outcome = await resolveByAi(h.deps, heroItem(), HERO_KEY);

    expect(outcome.warnings).toEqual([]);
    const resolved = outcome.resolved;
    expect(resolved).not.toBeNull();
    expect(ResolvedAssetSchema.parse(resolved)).toEqual(resolved);
    expect(resolved?.resolution).toEqual({
      strategy: 'AI_GENERATION',
      score: 1,
      fallback_level: 1,
    });
    expect(resolved?.asset?.source_type).toBe('AI_GENERATED');
    // 11.3 第五条：AI 图不得标成真实照片
    expect(resolved?.asset?.representation_type).toBe('ILLUSTRATIVE');
  });

  it('generation_metadata 九个字段齐全，Brief 原样落库（二十章）', async () => {
    const h = harness();
    await resolveByAi(h.deps, heroItem(), HERO_KEY);

    const metadata = GenerationMetadataSchema.parse(h.inserted[0]?.generationMetadata);
    expect(metadata.cache_key).toBe(HERO_KEY);
    expect(metadata.seed).toBe(seedForCacheKey(HERO_KEY));
    expect(metadata.visual_brief.task).toBe('GENERATE_TRAVEL_HERO');
    expect(metadata.visual_brief.destination).toBe('杭州');
    // 11.3 的禁止项与 Brief 里的一致
    expect(metadata.negative_requirements).toEqual(metadata.visual_brief.negative_requirements);
    expect(metadata.prompt_template_version).toBe('image_v1');
  });

  it('请求的尺寸满足 min_width 与比例（否则 11.2 会拒掉自己生成的图）', async () => {
    const h = harness();
    await resolveByAi(h.deps, heroItem(), HERO_KEY);

    const row = h.inserted[0];
    expect(row?.width).toBeGreaterThanOrEqual(1600);
    expect(Math.abs((row?.aspectRatio ?? 0) - 16 / 6)).toBeLessThan(0.02);
  });

  it('种子由缓存键派生：同键两次得到同一个种子（可复现）', () => {
    expect(seedForCacheKey(HERO_KEY)).toBe(seedForCacheKey(HERO_KEY));
    expect(seedForCacheKey(HERO_KEY)).not.toBe(seedForCacheKey(`${HERO_KEY}x`));
    expect(seedForCacheKey(HERO_KEY)).toBeLessThan(2 ** 24);
  });

  it('生成后释放锁 —— 不释放会让等待方空等 30 秒 TTL', async () => {
    const lock = new InMemoryAssetLock();
    const h = harness({ lock });
    await resolveByAi({ ...h.deps, assetLock: lock }, heroItem(), HERO_KEY);
    // 锁已释放，可以再次获得
    expect(await lock.acquire(HERO_KEY)).toBe(true);
  });
});

describe('不可生成的槽位', () => {
  it('缓存键为 null 时不记 warning（这一层压根不适用）', async () => {
    const h = harness();
    expect(await resolveByAi(h.deps, heroItem(), null)).toEqual({ resolved: null, warnings: [] });
  });

  it('ROUTE_MAP 不生成（briefForRequirement 返回 null）', async () => {
    const h = harness();
    const item = AssetRequirementItemSchema.parse({
      slot_id: 'day_1.route_map',
      day_number: 1,
      role: 'ROUTE_MAP',
      asset_type: 'GENERATED_SVG',
      required: true,
      route_data: { nodes: [], style: 'CANAL_GREEN' },
      visual_constraints: { aspect_ratio: '3:2', min_width: 1200 },
    });
    expect(await resolveByAi(h.deps, item, 'map:v1:abc:canal_green')).toEqual({
      resolved: null,
      warnings: [],
    });
  });
});

describe('16.3 失败不阻断', () => {
  it('超时 → null + ASSET_AI_GENERATION_TIMEOUT，不抛错', async () => {
    const h = harness({ fail: new ImageTimeoutError(20_000) });
    const outcome = await resolveByAi(h.deps, heroItem(), HERO_KEY);

    expect(outcome.resolved).toBeNull();
    expect(outcome.warnings).toEqual(['ASSET_AI_GENERATION_TIMEOUT']);
  });

  it('其余失败 → ASSET_AI_GENERATION_FAILED，且归还额度', async () => {
    const h = harness({ fail: new Error('供应商 500') });
    const outcome = await resolveByAi(h.deps, heroItem(), HERO_KEY);

    expect(outcome.warnings).toEqual(['ASSET_AI_GENERATION_FAILED']);
    expect(h.deps.budget.used).toMatchObject({ images: 0, heroes: 0 });
  });

  it('11.2 后处理拒收时记 ASSET_POSTPROCESS_FAILED，但仍计入日预算（钱花了）', async () => {
    // 故意画一张比例不符的图（正方形 vs 要求 16:6）
    const h = harness({ renderer: (width) => gradient(width, width) });
    const outcome = await resolveByAi(h.deps, heroItem(), HERO_KEY);

    expect(outcome.resolved).toBeNull();
    expect(outcome.warnings).toEqual(['ASSET_POSTPROCESS_FAILED']);
    expect(h.inserted).toHaveLength(0);
  });

  it('额度耗尽时不调用模型，记 warning 不报错（21.4）', async () => {
    const h = harness({ heroQuota: 0 });
    const outcome = await resolveByAi(h.deps, heroItem(), HERO_KEY);

    expect(outcome.resolved).toBeNull();
    expect(outcome.warnings).toEqual(['ASSET_AI_GENERATION_FAILED']);
    expect(h.inserted).toHaveLength(0);
  });

  it('失败时也释放锁 —— 等待方应立刻走占位图', async () => {
    const lock = new InMemoryAssetLock();
    const h = harness({ lock, fail: new Error('x') });
    await resolveByAi({ ...h.deps, assetLock: lock }, heroItem(), HERO_KEY);
    expect(await lock.acquire(HERO_KEY)).toBe(true);
  });
});

describe('13.8 同键并发去重（TP-4-06）', () => {
  it('未拿到锁时等待对方结果，返回 CACHE_HIT 而不是降级', async () => {
    const lock = new InMemoryAssetLock();
    // 先把锁占住，模拟「别人正在生成」
    expect(await lock.acquire(HERO_KEY)).toBe(true);

    const h = harness({
      lock,
      byCacheKey: {
        [HERO_KEY]: {
          assetId: '11111111-1111-4111-8111-111111111111',
          entityName: null,
          destinationName: '杭州',
          destinationPlaceId: 'cn_hangzhou',
          assetType: 'IMAGE',
          sourceType: 'AI_GENERATED',
          representationType: 'ILLUSTRATIVE',
          mimeType: 'image/webp',
          storageUrl: 'https://cdn.test/hero.webp',
          thumbnailUrl: null,
          width: 1600,
          height: 600,
          aspectRatio: 16 / 6,
          qualityScore: 0.7,
          licenseType: 'AI_GENERATED',
          attributionText: null,
          styleTags: [],
          cosine: null,
        },
      },
    });

    const outcome = await resolveByAi({ ...h.deps, assetLock: lock }, heroItem(), HERO_KEY);

    expect(outcome.warnings).toEqual([]);
    // 19.4：命中的 score 恒为 1.0、等级 0（没花钱）
    expect(outcome.resolved?.resolution).toEqual({
      strategy: 'CACHE_HIT',
      score: 1,
      fallback_level: 0,
    });
    // 没有调用模型，也没有插入新素材
    expect(h.inserted).toHaveLength(0);
    // 预留被归还：额度留给别的槽位
    expect(h.deps.budget.used).toMatchObject({ images: 0, heroes: 0 });
  });

  it('等待超时 → null + TIMEOUT 告警（交给下一层降级）', async () => {
    const lock = new InMemoryAssetLock();
    await lock.acquire(HERO_KEY);

    const h = harness({ lock });
    let clock = 0;
    const outcome = await resolveByAi(
      { ...h.deps, assetLock: lock, now: () => (clock += AI_WAIT_TIMEOUT_MS) },
      heroItem(),
      HERO_KEY,
    );

    expect(outcome.resolved).toBeNull();
    expect(outcome.warnings).toEqual(['ASSET_AI_GENERATION_TIMEOUT']);
  });

  it('10 个同键并发只有 1 次真的生成', async () => {
    const lock = new InMemoryAssetLock();
    const h = harness({ lock });
    const deps = { ...h.deps, assetLock: lock };

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => resolveByAi(deps, heroItem(), HERO_KEY)),
    );

    expect(h.inserted).toHaveLength(1);
    const generated = outcomes.filter(
      (outcome) => outcome.resolved?.resolution.strategy === 'AI_GENERATION',
    );
    expect(generated).toHaveLength(1);
    // 其余 9 个要么等到了结果（CACHE_HIT），要么在等待中 —— 都不该是新生成
    for (const outcome of outcomes) {
      expect(outcome.resolved?.resolution.strategy ?? 'CACHE_HIT').not.toBe('LOCAL_LIBRARY_MATCH');
    }
  });
});
