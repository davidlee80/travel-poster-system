import { FakeLicensedSourceClient, LocalHashingEmbeddingClient } from '@tps/llm';
import type { LicensedSourceCandidate } from '@tps/llm';
import type { AssetCandidateRow, AssetsRepository, InsertAssetInput } from '@tps/db';
import { SCHEMA_VERSIONS, type AssetRequirementItem } from '@tps/schemas';
import { InMemoryObjectStorage } from '@tps/storage';
import { InMemoryCounterStore, createSilentLogger } from '@tps/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { ImageSearchBudget, MAX_IMAGE_SEARCHES_PER_JOB } from '../search-budget.js';
import { resolveByLicensedSource } from './licensed-source.js';

/**
 * licensed-source resolver（TP-6-03，设计稿 9.3～9.6）。
 *
 * 这里验证的是**这一层与预算、告警、指标的交互**：什么时候记
 * `recordFailure`（图源故障）、什么时候记 `recordSuccess`（图源正常但没图）、
 * 哪些情况不该记 warning。入库流水线本身由 `search-ingest.test.ts` 覆盖。
 */

async function photo(width: number, height: number): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = 7;
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

let goodPhoto: Uint8Array;

beforeAll(async () => {
  goodPhoto = await photo(1600, 900);
});

function row(input: InsertAssetInput): AssetCandidateRow {
  return {
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
  };
}

interface Harness {
  readonly repo: AssetsRepository;
  readonly inserted: InsertAssetInput[];
}

function repository(): Harness {
  const inserted: InsertAssetInput[] = [];
  const byKey = new Map<string, AssetCandidateRow>();
  const byId = new Map<string, AssetCandidateRow>();

  const repo: AssetsRepository = {
    findCandidates: () => Promise.resolve([]),
    findByCacheKey: (key) => Promise.resolve(byKey.get(key) ?? null),
    findById: (assetId) => Promise.resolve(byId.get(assetId) ?? null),
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: (input) => {
      inserted.push(input);
      const stored = row(input);
      byId.set(input.assetId, stored);
      if (input.cacheKey !== null) byKey.set(input.cacheKey, stored);
      return Promise.resolve({ assetId: input.assetId, created: true });
    },
    insertVariant: () => Promise.resolve(),
  };

  return { repo, inserted };
}

function deps(
  repo: AssetsRepository,
  client: FakeLicensedSourceClient,
  budget?: ImageSearchBudget,
) {
  return {
    assets: repo,
    storage: new InMemoryObjectStorage(),
    embedding: new LocalHashingEmbeddingClient(),
    logger: createSilentLogger(),
    search: client,
    searchBudget: budget ?? new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
    searchTimeoutMs: 5_000,
  };
}

function requirement(overrides: Partial<AssetRequirementItem> = {}): AssetRequirementItem {
  return {
    schema_version: SCHEMA_VERSIONS.assetRequirement,
    slot_id: 'day_3.place.gongchen',
    day_number: 3,
    role: 'DESTINATION_PHOTO',
    asset_type: 'REAL_PHOTO_PREFERRED',
    required: false,
    subject: {
      destination: '杭州',
      destination_place_id: 'cn-hangzhou',
      entity_name: '拱宸桥',
      entity_place_id: 'hz-gongchen-bridge',
    },
    visual_constraints: { aspect_ratio: '16:9', min_width: 1200 },
    ...overrides,
  } as AssetRequirementItem;
}

function candidate(overrides: Partial<LicensedSourceCandidate> = {}): LicensedSourceCandidate {
  return {
    provider: 'fake-openverse',
    originalUrl: 'https://example.test/photos/1',
    downloadUrl: 'https://example.test/photos/1/full.jpg',
    licenseType: 'CC0',
    attributionText: null,
    licenseExpiresAt: null,
    mimeType: 'image/jpeg',
    ...overrides,
  };
}

const CACHE_KEY = 'place:v1:hz-gongchen-bridge:destination_photo:16x9';

describe('命中', () => {
  it('返回 LICENSED_SOURCE_MATCH 且 fallback_level 为 1', async () => {
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client),
      requirement(),
      CACHE_KEY,
    );

    expect(outcome.resolved?.resolution).toEqual({
      strategy: 'LICENSED_SOURCE_MATCH',
      score: 1,
      fallback_level: 1,
    });
    expect(outcome.warnings).toEqual([]);
  });

  it('source_type 为 LICENSED_SOURCE 且 representation 为 PHOTOGRAPHIC', async () => {
    /*
     * 9.4：搜索到的是真实照片，因此不显示「示意图」（二十章的披露只对
     * AI 生成的景点图适用）。这一条与 ai-generator 硬编码 ILLUSTRATIVE
     * 是同一处理的两面。
     */
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client),
      requirement(),
      CACHE_KEY,
    );

    expect(outcome.resolved?.asset).toMatchObject({
      source_type: 'LICENSED_SOURCE',
      representation_type: 'PHOTOGRAPHIC',
    });
  });

  it('无缓存键时也能返回（按 ID 读回）', async () => {
    // 美食槽位缺菜名时 19.2 算不出键，这条路径必须能走通
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(deps(harness.repo, client), requirement(), null);

    expect(outcome.resolved).not.toBeNull();
    expect(harness.inserted[0]?.cacheKey).toBeNull();
  });

  it('命中后日预算 +1（熔断的数据来源）', async () => {
    const counters = new InMemoryCounterStore();
    const budget = new ImageSearchBudget({ counters, now: () => new Date('2026-08-19T00:00:00Z') });
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await resolveByLicensedSource(deps(harness.repo, client, budget), requirement(), CACHE_KEY);

    expect(await counters.peek('search:image:daily:2026-08-19')).toBe(1);
  });
});

describe('配额与熔断（9.6）', () => {
  it('ROUTE_MAP 不记 warning（这一层压根不适用）', async () => {
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client),
      requirement({ role: 'ROUTE_MAP', asset_type: 'GENERATED_SVG', required: true }),
      null,
    );

    expect(outcome).toEqual({ resolved: null, warnings: [] });
    expect(client.searchCalls).toHaveLength(0);
  });

  it('单任务上限耗尽后记 warning 但不报错', async () => {
    const budget = new ImageSearchBudget({ counters: new InMemoryCounterStore() });
    for (let i = 0; i < MAX_IMAGE_SEARCHES_PER_JOB; i += 1) {
      await budget.reserve('DESTINATION_PHOTO');
    }
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client, budget),
      requirement(),
      CACHE_KEY,
    );

    expect(outcome.resolved).toBeNull();
    expect(outcome.warnings).toEqual(['ASSET_LICENSED_SOURCE_UNAVAILABLE']);
    expect(client.searchCalls).toHaveLength(0);
  });

  it('全局熔断打开后跳过搜索层', async () => {
    const counters = new InMemoryCounterStore();
    await counters.increment('search:image:daily:2026-08-19', 90_000);
    const budget = new ImageSearchBudget({
      counters,
      dailyBudget: 1,
      now: () => new Date('2026-08-19T00:00:00Z'),
    });
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client, budget),
      requirement(),
      CACHE_KEY,
    );

    expect(outcome.warnings).toEqual(['ASSET_LICENSED_SOURCE_UNAVAILABLE']);
    expect(client.searchCalls).toHaveLength(0);
  });
});

describe('失败语义（9.6：超时即降入 AI 层，不重试）', () => {
  it('超时返回 null 并记 warning，不抛错', async () => {
    const harness = repository();
    const client = new FakeLicensedSourceClient({ behaviors: ['timeout'] });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client),
      requirement(),
      CACHE_KEY,
    );

    expect(outcome.resolved).toBeNull();
    expect(outcome.warnings).toEqual(['ASSET_LICENSED_SOURCE_UNAVAILABLE']);
  });

  it('超时不重试（只调用图源一次）', async () => {
    const harness = repository();
    const client = new FakeLicensedSourceClient({ behaviors: ['timeout'] });

    await resolveByLicensedSource(deps(harness.repo, client), requirement(), CACHE_KEY);

    expect(client.searchCalls).toHaveLength(1);
  });

  it('连续两次失败后第三次被 PROVIDER_FAILING 挡掉', async () => {
    const budget = new ImageSearchBudget({ counters: new InMemoryCounterStore() });
    const harness = repository();
    const client = new FakeLicensedSourceClient({
      behaviors: ['timeout', 'unavailable', 'timeout'],
    });
    const d = deps(harness.repo, client, budget);

    await resolveByLicensedSource(d, requirement(), CACHE_KEY);
    await resolveByLicensedSource(d, requirement(), CACHE_KEY);
    await resolveByLicensedSource(d, requirement(), CACHE_KEY);

    // 第三次没有真的调用图源
    expect(client.searchCalls).toHaveLength(2);
    expect(budget.used.failures).toBe(2);
  });

  it('候选全被丢弃**不算**图源故障（记 recordSuccess）', async () => {
    /*
     * 图源工作正常，只是这个冷组合没有合规且够清晰的图。
     * 记成失败的话，连续两个冷组合无果就会把本任务的搜索层关掉 ——
     * 而后面的槽位可能搜得到。
     */
    const budget = new ImageSearchBudget({ counters: new InMemoryCounterStore() });
    const harness = repository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseType: null })],
      bytes: goodPhoto,
    });
    const d = deps(harness.repo, client, budget);

    await resolveByLicensedSource(d, requirement(), CACHE_KEY);
    await resolveByLicensedSource(d, requirement(), CACHE_KEY);
    const third = await resolveByLicensedSource(d, requirement(), CACHE_KEY);

    expect(budget.used.failures).toBe(0);
    // 第三次仍然真的搜了
    expect(client.searchCalls).toHaveLength(3);
    expect(third.warnings).toEqual(['ASSET_LICENSED_SOURCE_UNAVAILABLE']);
  });

  it('算不出检索词时归还额度且不记 warning', async () => {
    const budget = new ImageSearchBudget({ counters: new InMemoryCounterStore() });
    const harness = repository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await resolveByLicensedSource(
      deps(harness.repo, client, budget),
      requirement({ subject: null }),
      null,
    );

    expect(outcome).toEqual({ resolved: null, warnings: [] });
    expect(budget.used.searches).toBe(0);
  });
});
