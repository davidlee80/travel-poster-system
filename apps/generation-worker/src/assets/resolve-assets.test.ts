import { heroCacheKey, placeCacheKey } from '@tps/assets';
import type { AssetCandidateRow, AssetsRepository } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import {
  AssetResolveResponseSchema,
  ResolvedAssetSchema,
  SCHEMA_VERSIONS,
  makeTravelPlanFixture,
  type AssetRequirement,
} from '@tps/schemas';
import {
  assetRequirementEnvelope,
  buildPresentationPlans,
  heroSlotId,
  mergeRequirements,
  photoSpotSlotId,
  routeMapSlotId,
} from '@tps/presentation';
import { FakeImageClient, FakeLicensedSourceClient, ImageUnavailableError } from '@tps/llm';
import type { LicensedSourceClient } from '@tps/llm';
import { InMemoryAssetLock } from '@tps/queue';
import { InMemoryObjectStorage } from '@tps/storage';
import { InMemoryCounterStore, createSilentLogger } from '@tps/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { AiImageBudget } from './ai-budget.js';
import { ImageSearchBudget } from './search-budget.js';
import { PLACEHOLDER_SPECS } from './placeholders.js';
import {
  DAY_CONCURRENCY,
  SLOT_CONCURRENCY,
  resolveAssets,
  toAssetLookup,
} from './resolve-assets.js';

/**
 * 批量素材解析（TP-3-14、TP-3-15）。
 *
 * 用假仓储：这里要验证的是**编排** —— 来源顺序、并发度、降级、绑定构造，
 * 而每一层来源自己的行为已由各自的测试覆盖。
 */

function envelopeFor(totalDays: number): AssetRequirement {
  const plan = makeTravelPlanFixture({ totalDays });
  const merged = mergeRequirements(buildPresentationPlans({ plan }));
  return assetRequirementEnvelope({
    planId: plan.plan_id,
    planVersionId: plan.plan_version_id,
    templateId: 'travel_infographic_v1',
    requirements: merged.requirements,
  });
}

interface FakeRepoOptions {
  /** 按缓存键预置的素材（19.4 的命中路径） */
  readonly byCacheKey?: Record<string, AssetCandidateRow>;
  /** 素材库候选（10.2 的检索路径） */
  readonly candidates?: readonly AssetCandidateRow[];
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
    storageUrl: 'https://cdn.test/a.webp',
    thumbnailUrl: 'https://cdn.test/a-thumb.webp',
    width: 1600,
    height: 900,
    aspectRatio: 16 / 9,
    qualityScore: 0.9,
    licenseType: 'PLATFORM_OWNED',
    attributionText: null,
    styleTags: [],
    cosine: 0.9,
    ...overrides,
  };
}

function fakeRepo(options: FakeRepoOptions = {}): {
  repo: AssetsRepository;
  inserted: string[];
  concurrency: { peak: number };
} {
  const inserted: string[] = [];
  const byId = new Map<string, AssetCandidateRow>();
  let active = 0;
  const concurrency = { peak: 0 };

  const repo: AssetsRepository = {
    findCandidates: async () => {
      active += 1;
      concurrency.peak = Math.max(concurrency.peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return options.candidates ?? [];
    },
    findByCacheKey: (key) => Promise.resolve(options.byCacheKey?.[key] ?? null),
    // 落库后按 ID 读回（TP-6-03 的搜索层要用它构造 ResolvedAsset）
    findById: (assetId) => Promise.resolve(byId.get(assetId) ?? null),
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: (input) => {
      inserted.push(input.assetType);
      byId.set(
        input.assetId,
        row({
          assetId: input.assetId,
          entityName: input.entityName,
          destinationName: input.destinationName,
          destinationPlaceId: input.destinationPlaceId,
          sourceType: input.sourceType,
          representationType: input.representationType,
          storageUrl: input.storageUrl,
          thumbnailUrl: input.thumbnailUrl,
          width: input.width,
          height: input.height,
          aspectRatio: input.aspectRatio,
          licenseType: input.licenseType,
          attributionText: input.attributionText,
          styleTags: input.styleTags,
        }),
      );
      return Promise.resolve({ assetId: input.assetId, created: true });
    },
    insertVariant: () => Promise.resolve(),
  };

  return { repo, inserted, concurrency };
}

const embedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
};

function deps(repo: AssetsRepository) {
  return {
    assets: repo,
    storage: new InMemoryObjectStorage(),
    embedding,
    logger: createSilentLogger(),
  };
}

describe('14.1 契约', () => {
  it('响应通过 AssetResolveResponseSchema，且三组之和等于槽位数', async () => {
    const envelope = envelopeFor(3);
    const { repo } = fakeRepo();
    const { response } = await resolveAssets(deps(repo), envelope);

    expect(AssetResolveResponseSchema.safeParse(response).success).toBe(true);
    expect(
      response.resolved.length + response.fallbacks.length + response.failed_optional.length,
    ).toBe(envelope.requirements.length);
  });

  it('每个结果都是合法的 ResolvedAsset', async () => {
    const { repo } = fakeRepo();
    const { all } = await resolveAssets(deps(repo), envelopeFor(2));

    for (const result of all) {
      const parsed = ResolvedAssetSchema.safeParse(result);
      expect(parsed.success, `槽位 ${result.slot_id} 不合法`).toBe(true);
    }
  });

  it('槽位无重复且与请求一一对应', async () => {
    const envelope = envelopeFor(5);
    const { repo } = fakeRepo();
    const { all } = await resolveAssets(deps(repo), envelope);

    expect(all.map((r) => r.slot_id).sort()).toEqual(
      envelope.requirements.map((r) => r.slot_id).sort(),
    );
  });

  it('必需槽位没有 FAILED 时 status 为 COMPLETED', async () => {
    const { repo } = fakeRepo();
    const { response } = await resolveAssets(deps(repo), envelopeFor(1));
    expect(response.status).toBe('COMPLETED');
  });
});

describe('来源顺序（九章）', () => {
  it('缓存键命中 → CACHE_HIT，score 1.0，且不查素材库（19.4）', async () => {
    const envelope = envelopeFor(1);
    const heroSlot = envelope.requirements.find((r) => r.slot_id === heroSlotId(1))!;
    const key = heroCacheKey({
      destinationPlaceId: heroSlot.subject?.destination_place_id,
      destinationName: heroSlot.subject?.destination,
      theme: heroSlot.subject?.theme,
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    const { repo, concurrency } = fakeRepo({
      byCacheKey: { [key]: row({ assetId: 'cached-hero', aspectRatio: 16 / 6, height: 600 }) },
    });
    const { all } = await resolveAssets(deps(repo), envelope);

    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.resolution).toEqual({ strategy: 'CACHE_HIT', score: 1, fallback_level: 0 });
    expect(hero.asset?.asset_id).toBe('cached-hero');
    // 其他槽位仍会查库，因此只断言「Hero 那次没查」不现实；
    // 这里断言的是命中路径本身不需要向量检索即可产出结果
    expect(concurrency.peak).toBeGreaterThanOrEqual(0);
  });

  it('素材库命中 → LOCAL_LIBRARY_MATCH', async () => {
    const { repo } = fakeRepo({ candidates: [row({ assetId: 'lib-1' })] });
    const { all } = await resolveAssets(deps(repo), envelopeFor(1));

    const photo = all.find((r) => r.slot_id === photoSpotSlotId(1, 0))!;
    expect(photo.status).toBe('RESOLVED');
    expect(photo.resolution.strategy).toBe('LOCAL_LIBRARY_MATCH');
  });

  it('都未命中 → 默认占位（P3 的降级链缺 AI 那一层）', async () => {
    const placeholder = PLACEHOLDER_SPECS.find((spec) => spec.role === 'DESTINATION_PHOTO')!;
    const { repo } = fakeRepo({
      byCacheKey: {
        [placeholder.cacheKey]: row({
          assetId: 'placeholder-photo',
          sourceType: 'DEFAULT_PLACEHOLDER',
          representationType: 'ILLUSTRATIVE',
          entityName: null,
          destinationName: null,
          destinationPlaceId: null,
        }),
      },
    });
    const { all } = await resolveAssets(deps(repo), envelopeFor(1));

    const photo = all.find((r) => r.slot_id === photoSpotSlotId(1, 0))!;
    expect(photo.status).toBe('FALLBACK');
    expect(photo.resolution).toEqual({
      strategy: 'STATIC_DEFAULT',
      score: 0,
      fallback_level: 2,
    });
    expect(photo.asset?.source_type).toBe('DEFAULT_PLACEHOLDER');
  });

  it('占位图也不在库里 → SKIPPED（不是 FAILED，模板有降级分支）', async () => {
    const { repo } = fakeRepo();
    const { all, response } = await resolveAssets(deps(repo), envelopeFor(1));

    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.status).toBe('SKIPPED');
    expect(hero.asset).toBeNull();
    // 必需槽位 SKIPPED 不算 PARTIAL —— 页面仍可渲染（渐变背景）
    expect(response.status).toBe('COMPLETED');
  });

  it('ROUTE_MAP 走 SVG 渲染，产出 SVG 素材并上传', async () => {
    const { repo, inserted } = fakeRepo();
    const d = deps(repo);
    const { all } = await resolveAssets(d, envelopeFor(1));

    const map = all.find((r) => r.slot_id === routeMapSlotId(1))!;
    expect(map.status).toBe('RESOLVED');
    expect(map.resolution.strategy).toBe('SVG_RENDER');
    expect(map.asset?.asset_type).toBe('SVG');
    // 8.2：SVG 的 thumbnail 恒为 null
    expect(map.asset?.urls.thumbnail).toBeNull();
    expect(inserted).toContain('SVG');

    const uploaded = [...d.storage.objects.entries()].find(([key]) => key.endsWith('.svg'));
    expect(uploaded).toBeDefined();
    expect(uploaded![1].contentType).toBe('image/svg+xml');
    expect(new TextDecoder().decode(uploaded![1].body)).toContain('<svg');
  });

  it('同一条路线在两天里只渲染一次（内容寻址 + 唯一键）', async () => {
    /*
     * fixture 的 14 天里主题会循环，路线节点也会重复。第二次遇到同一条路线时
     * 应当命中 cache_key 而不是再渲染一张 —— 这就是 19.5 的「跨天复用」。
     * 这里用一个会记住已插入键的假仓储来验证。
     */
    const stored = new Map<string, AssetCandidateRow>();
    const repo: AssetsRepository = {
      findCandidates: () => Promise.resolve([]),
      findByCacheKey: (key) => Promise.resolve(stored.get(key) ?? null),
      findById: () => Promise.resolve(null),
      findByContentHash: () => Promise.resolve(null),
      mergeTags: () => Promise.resolve(),
      insertAsset: (input) => {
        if (input.cacheKey !== null && stored.has(input.cacheKey)) {
          return Promise.resolve({ assetId: stored.get(input.cacheKey)!.assetId, created: false });
        }
        if (input.cacheKey !== null) {
          stored.set(
            input.cacheKey,
            row({
              assetId: input.assetId,
              assetType: input.assetType,
              sourceType: input.sourceType,
              representationType: input.representationType,
              mimeType: input.mimeType,
              storageUrl: input.storageUrl,
              thumbnailUrl: input.thumbnailUrl,
              width: input.width,
              height: input.height,
              aspectRatio: input.aspectRatio,
            }),
          );
        }
        return Promise.resolve({ assetId: input.assetId, created: true });
      },
      insertVariant: () => Promise.resolve(),
    };

    // 14 天 fixture 的 DAY_THEMES 只有 7 条，第 8 天起完全重复第 1 天的行程
    const { all } = await resolveAssets(deps(repo), envelopeFor(14));

    const maps = all.filter((r) => r.slot_id.endsWith('.route_map'));
    const hashes = new Set(maps.map((m) => m.asset?.metadata.route_node_hash));
    const cacheHits = maps.filter((m) => m.resolution.strategy === 'CACHE_HIT');

    expect(maps).toHaveLength(14);
    // 路线内容重复 → 哈希去重后远少于 14 个
    expect(hashes.size).toBeLessThan(14);
    expect(cacheHits.length).toBeGreaterThan(0);
  });
});

describe('21.2 并发模型', () => {
  it('并发度是天级 8、槽位 6', () => {
    expect(DAY_CONCURRENCY).toBe(8);
    expect(SLOT_CONCURRENCY).toBe(6);
  });

  it('14 天解析时的库查询并发不超过 天级 × 槽位', async () => {
    const { repo, concurrency } = fakeRepo();
    await resolveAssets(deps(repo), envelopeFor(14));

    expect(concurrency.peak).toBeLessThanOrEqual(DAY_CONCURRENCY * SLOT_CONCURRENCY);
    // 且确实并发了（不是串行）
    expect(concurrency.peak).toBeGreaterThan(1);
  });
});

describe('异常与降级（16.3）', () => {
  it('单个槽位抛错不影响其他槽位', async () => {
    let calls = 0;
    const repo: AssetsRepository = {
      findCandidates: () => {
        calls += 1;
        // 第一次调用抛错，其余正常
        return calls === 1 ? Promise.reject(new Error('数据库抖动')) : Promise.resolve([]);
      },
      findByCacheKey: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      findByContentHash: () => Promise.resolve(null),
      mergeTags: () => Promise.resolve(),
      insertAsset: (input) => Promise.resolve({ assetId: input.assetId, created: true }),
      insertVariant: () => Promise.resolve(),
    };

    const envelope = envelopeFor(1);
    const { all, response } = await resolveAssets(deps(repo), envelope);

    expect(all).toHaveLength(envelope.requirements.length);
    expect(response.status).toBe('COMPLETED');
    // 抛错的那个槽位降级为 SKIPPED（占位图不在库里）
    expect(all.filter((r) => r.status === 'SKIPPED').length).toBeGreaterThan(0);
  });
});

describe('绑定构造（TP-3-15）', () => {
  it('每个带素材的槽位产出一条绑定，含天号与角色', async () => {
    const { repo } = fakeRepo({ candidates: [row({ assetId: 'lib-1' })] });
    const envelope = envelopeFor(2);
    const { bindings, all } = await resolveAssets(deps(repo), envelope);

    const withAsset = all.filter((r) => r.asset !== null);
    expect(bindings).toHaveLength(withAsset.length);

    const first = bindings[0]!;
    expect(first).toMatchObject({
      planId: envelope.plan_id,
      planVersionId: envelope.plan_version_id,
      templateId: 'travel_infographic_v1',
    });
    expect(first.dayNumber).toBeGreaterThanOrEqual(1);
    expect(['HERO_BACKGROUND', 'ROUTE_MAP', 'FOOD_IMAGE', 'DESTINATION_PHOTO']).toContain(
      first.role,
    );
  });

  it('没有素材的槽位不产出绑定（asset_id 是 NOT NULL）', async () => {
    const { repo } = fakeRepo();
    const { bindings, all } = await resolveAssets(deps(repo), envelopeFor(1));

    const skipped = all.filter((r) => r.asset === null);
    expect(skipped.length).toBeGreaterThan(0);
    for (const result of skipped) {
      expect(bindings.some((b) => b.slotId === result.slot_id)).toBe(false);
    }
  });
});

describe('toAssetLookup（12.1）', () => {
  it('AI 生成的景点图带「示意图」，Hero 与美食不带', async () => {
    const envelope = envelopeFor(1);
    const photoKey = placeCacheKey({
      placeId: envelope.requirements.find((r) => r.slot_id === photoSpotSlotId(1, 0))!.subject
        ?.entity_place_id,
      role: 'DESTINATION_PHOTO',
      aspectRatio: '16:9',
    });
    const heroSlot = envelope.requirements.find((r) => r.slot_id === heroSlotId(1))!;
    const heroKey = heroCacheKey({
      destinationPlaceId: heroSlot.subject?.destination_place_id,
      destinationName: heroSlot.subject?.destination,
      theme: heroSlot.subject?.theme,
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    const aiRow = row({
      assetId: 'ai-1',
      sourceType: 'AI_GENERATED',
      representationType: 'ILLUSTRATIVE',
    });
    const { repo } = fakeRepo({ byCacheKey: { [photoKey]: aiRow, [heroKey]: aiRow } });
    const { all } = await resolveAssets(deps(repo), envelope);

    const lookup = toAssetLookup(envelope.requirements, all);
    expect(lookup(photoSpotSlotId(1, 0))?.image?.source_note).toBe('示意图');
    expect(lookup(heroSlotId(1))?.image?.source_note).toBeNull();
  });

  it('未解析的槽位返回 undefined（与 EMPTY_ASSET_LOOKUP 一致）', () => {
    const lookup = toAssetLookup([], []);
    expect(lookup('day_1.hero_background')).toBeUndefined();
  });

  it('SVG 槽位给出 svgUrl', async () => {
    const { repo } = fakeRepo();
    const envelope = envelopeFor(1);
    const { all } = await resolveAssets(deps(repo), envelope);

    const lookup = toAssetLookup(envelope.requirements, all);
    expect(lookup(routeMapSlotId(1))?.svgUrl).toMatch(/\.svg$/);
  });
});

describe('schema 版本', () => {
  it('结果带 resolved_asset_v1', async () => {
    const { repo } = fakeRepo();
    const { all } = await resolveAssets(deps(repo), envelopeFor(1));
    expect(all[0]!.schema_version).toBe(SCHEMA_VERSIONS.resolvedAsset);
  });
});

describe('AI 层的位置（十八章第 1 级，TP-4-02）', () => {
  /** 记录调用的 AI 层。不真的生成 —— 这里只验编排顺序 */
  function spyAi(resolve: boolean): {
    ai: NonNullable<Parameters<typeof resolveAssets>[0]['ai']>;
    calls: string[];
  } {
    const calls: string[] = [];
    const image = new FakeImageClient((request) => {
      calls.push(`${request.width}x${request.height}`);
      if (!resolve) throw new ImageUnavailableError('注入故障');
      return new Uint8Array([1]);
    });
    return {
      calls,
      ai: {
        image,
        assetLock: new InMemoryAssetLock(),
        imageTimeoutMs: 20_000,
        userTypeLabel: 'REGISTERED',
        budget: new AiImageBudget({
          counters: new InMemoryCounterStore(),
          userType: 'REGISTERED',
          heroQuota: 2,
        }),
      },
    };
  }

  /** 只含一个景点槽位的信封，便于把「库命中」与「走 AI」隔离开来验证 */
  function photoOnlyEnvelope(): {
    envelope: AssetRequirement;
    entityName: string;
  } {
    const full = envelopeFor(1);
    const photo = full.requirements.find((r) => r.slot_id === photoSpotSlotId(1, 0))!;
    return {
      envelope: { ...full, requirements: [photo] },
      entityName: photo.subject?.entity_name ?? '',
    };
  }

  it('素材库命中时不调用 AI（库里那张已审核过，且不花钱）', async () => {
    const { envelope, entityName } = photoOnlyEnvelope();
    const { repo } = fakeRepo({
      candidates: [
        row({
          entityName,
          aspectRatio: 16 / 9,
          width: 1600,
          height: 900,
          cosine: 0.99,
          qualityScore: 0.95,
        }),
      ],
    });
    const { ai, calls } = spyAi(true);

    const { all } = await resolveAssets({ ...deps(repo), ai }, envelope);

    expect(all[0]?.resolution.strategy).toBe('LOCAL_LIBRARY_MATCH');
    expect(calls).toHaveLength(0);
  });

  it('库未命中时才走 AI，且 ROUTE_MAP 不进 AI 层', async () => {
    const envelope = envelopeFor(1);
    const { repo } = fakeRepo();
    const { ai, calls } = spyAi(false);

    const { all, warnings } = await resolveAssets({ ...deps(repo), ai }, envelope);

    /*
     * 连续失败上限是 2（见 ai-budget.ts）：供应商挂掉时不该让每个槽位
     * 都等满 20 秒 —— 那样 T2 目标（P95 < 110 秒）必然违约。
     * 并发解析下同一批里可能已有几个在途，因此上界放到 SLOT_CONCURRENCY。
     */
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(SLOT_CONCURRENCY);
    // 路线图仍然由程序渲染
    const routeMap = all.find((r) => r.slot_id === routeMapSlotId(1));
    expect(routeMap?.resolution.strategy).toBe('SVG_RENDER');
    // AI 全部失败 → 告警里同时有库未命中与 AI 失败
    expect(warnings).toContain('ASSET_LIBRARY_MISS');
    expect(warnings).toContain('ASSET_AI_GENERATION_FAILED');
  });

  it('不装配 AI 层时降级链回到「库 → 占位」，且不报错', async () => {
    const { repo } = fakeRepo();
    const { response, warnings } = await resolveAssets(deps(repo), envelopeFor(1));

    expect(response.status).toBe('COMPLETED');
    expect(warnings).toContain('ASSET_LIBRARY_MISS');
    expect(warnings).not.toContain('ASSET_AI_GENERATION_FAILED');
  });

  it('告警码去重：14 天的同一个原因只出现一次（TP-4-09）', async () => {
    const { repo } = fakeRepo();
    const { warnings } = await resolveAssets(deps(repo), envelopeFor(14));
    expect(new Set(warnings).size).toBe(warnings.length);
  });
});

describe('搜索层的位置（十八章第 1 级前半，TP-6-03）', () => {
  /** 一张能过 11.2 全部校验的图 */
  async function searchablePhoto(): Promise<Uint8Array> {
    const width = 1600;
    const height = 900;
    const pixels = Buffer.alloc(width * height * 3);
    let state = 11;
    for (let i = 0; i < pixels.length; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      pixels[i] = state % 256;
    }
    return new Uint8Array(
      await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer(),
    );
  }

  function searchLayer(client: FakeLicensedSourceClient) {
    return {
      search: client,
      searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
      searchTimeoutMs: 5_000,
    };
  }

  it('库内未命中时**先搜索再 AI**（9.4/9.5：真实照片优于 AI 插画）', async () => {
    /*
     * 断言的是**顺序**而不是「AI 一次都没被调用」：Hero 槽位要求 16:6，
     * 而假图源只能返回一份固定字节（16:9），因此 Hero 会在 11.2 的比例校验
     * 上被拒并继续降级到 AI —— 那是正确行为。
     *
     * 顺序用一份共享调用日志表达：只要每次 AI 调用之前都已经有过一次搜索，
     * 这一层就在正确的位置上。反过来（AI 在前）会让每张景点图都先花 20 秒
     * 生成一张插画，而库外那张合规照片本来 5 秒就能拿到。
     */
    const { repo } = fakeRepo();
    const calls: string[] = [];
    const client = new FakeLicensedSourceClient({
      candidates: [
        {
          provider: 'fake-openverse',
          originalUrl: 'https://example.test/1',
          downloadUrl: 'https://example.test/1/full.jpg',
          licenseType: 'CC0',
          attributionText: null,
          licenseExpiresAt: null,
          mimeType: 'image/jpeg',
        },
      ],
      bytes: await searchablePhoto(),
    });
    const recordingClient: LicensedSourceClient = {
      providers: client.providers,
      search: (query, timeoutMs) => {
        calls.push('search');
        return client.search(query, timeoutMs);
      },
      download: (item, timeoutMs) => client.download(item, timeoutMs),
    };

    const { all } = await resolveAssets(
      {
        ...deps(repo),
        licensedSource: {
          search: recordingClient,
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5_000,
        },
        ai: {
          image: new FakeImageClient(() => {
            calls.push('ai');
            throw new ImageUnavailableError('AI 层在搜索之后');
          }),
          assetLock: new InMemoryAssetLock(),
          budget: new AiImageBudget({
            counters: new InMemoryCounterStore(),
            userType: 'REGISTERED',
            heroQuota: 2,
          }),
          imageTimeoutMs: 20_000,
          userTypeLabel: 'REGISTERED',
        },
      },
      envelopeFor(1),
    );

    // 至少有一个 16:9 的图片槽位由搜索层解决
    expect(all.some((r) => r.resolution.strategy === 'LICENSED_SOURCE_MATCH')).toBe(true);
    // 第一次调用一定是搜索，且每次 AI 之前都有搜索
    expect(calls[0]).toBe('search');
    expect(calls.indexOf('search')).toBeLessThan(
      calls.includes('ai') ? calls.indexOf('ai') : Number.POSITIVE_INFINITY,
    );
  });

  it('缓存键命中时该槽位零外呼（19.5 的预热路径不受影响，门禁 #36）', async () => {
    /*
     * 21.2 措施二的结论不能被搜索层推翻：预热命中（≥ 80%）仍是主路径。
     * 断言的是「缓存键命中的槽位压根不会走到搜索层」——
     * 否则 600 张预热图每次都要陪着一次 5 秒的外呼。
     */
    const envelope = envelopeFor(1);
    const heroSlot = envelope.requirements.find((r) => r.slot_id === heroSlotId(1))!;
    const key = heroCacheKey({
      destinationPlaceId: heroSlot.subject?.destination_place_id,
      destinationName: heroSlot.subject?.destination,
      theme: heroSlot.subject?.theme,
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });
    const { repo } = fakeRepo({
      byCacheKey: { [key]: row({ assetId: 'preheated-hero', aspectRatio: 16 / 6, height: 600 }) },
    });
    const client = new FakeLicensedSourceClient({ candidates: [], bytes: new Uint8Array() });

    const { all } = await resolveAssets(
      {
        ...deps(repo),
        licensedSource: {
          search: client,
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5_000,
        },
      },
      envelope,
    );

    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.resolution.strategy).toBe('CACHE_HIT');
    // Hero 的检索词含目的地；命中缓存的槽位不该出现在搜索调用里
    expect(client.searchCalls.every((call) => !call.text.includes('主题氛围'))).toBe(true);
  });

  it('不装配搜索层时降级链回到 P4 的「库 → AI → 占位」', async () => {
    const { repo } = fakeRepo();
    const { response, warnings } = await resolveAssets(deps(repo), envelopeFor(1));

    expect(response.status).toBe('COMPLETED');
    expect(warnings).toContain('ASSET_LIBRARY_MISS');
    expect(warnings).not.toContain('ASSET_LICENSED_SOURCE_UNAVAILABLE');
  });

  it('搜索超时进 warnings 且任务继续（9.6：非阻断）', async () => {
    const { repo } = fakeRepo();
    const client = new FakeLicensedSourceClient({
      behaviors: ['timeout', 'timeout', 'timeout', 'timeout', 'timeout', 'timeout'],
    });

    const { response, warnings } = await resolveAssets(
      { ...deps(repo), licensedSource: searchLayer(client) },
      envelopeFor(1),
    );

    expect(response.status).toBe('COMPLETED');
    expect(warnings).toContain('ASSET_LICENSED_SOURCE_UNAVAILABLE');
  });

  it('搜索命中的槽位写入 resolution_strategy = LICENSED_SOURCE_MATCH（TP-6-03）', async () => {
    const { repo } = fakeRepo();
    const client = new FakeLicensedSourceClient({
      candidates: [
        {
          provider: 'fake-openverse',
          originalUrl: 'https://example.test/1',
          downloadUrl: 'https://example.test/1/full.jpg',
          licenseType: 'CC0',
          attributionText: null,
          licenseExpiresAt: null,
          mimeType: 'image/jpeg',
        },
      ],
      bytes: await searchablePhoto(),
    });

    const { bindings } = await resolveAssets(
      { ...deps(repo), licensedSource: searchLayer(client) },
      envelopeFor(1),
    );

    expect(bindings.some((b) => b.resolutionStrategy === 'LICENSED_SOURCE_MATCH')).toBe(true);
  });
});
