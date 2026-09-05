import {
  FakeImageClient,
  FakeLicensedSourceClient,
  type EmbeddingClient,
  type ImageClient,
  type LicensedSourceCandidate,
  type LicensedSourceClient,
} from '@tps/llm';
import { InMemoryAssetLock } from '@tps/queue';
import { InMemoryObjectStorage } from '@tps/storage';
import { InMemoryCounterStore, createSilentLogger } from '@tps/shared';
import type { AssetCandidateRow, AssetsRepository } from '@tps/db';
import {
  makeTravelPlanFixture,
  type AssetRequirement,
  type AssetRole,
} from '@tps/schemas';
import {
  assetRequirementEnvelope,
  buildPresentationPlans,
  mergeRequirements,
  heroSlotId,
  photoSpotSlotId,
  foodSlotId,
} from '@tps/presentation';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { AiImageBudget } from '../ai-budget.js';
import { ImageSearchBudget } from '../search-budget.js';
import { PLACEHOLDER_SPECS } from '../placeholders.js';
import { resolveAssets } from '../resolve-assets.js';
import { FakeAssetResolverBuilder } from './fake-asset-resolver.js';

/**
 * 素材解析全链路测试（TP-3-14、TP-3-15、TP-4-02、TP-6-03）。
 *
 * Hero / 景点 / 美食三类槽位走**同一条**统一降级链（设计稿 9.3～9.6）：
 *
 * ```text
 * 素材库匹配 → 授权图源搜索 → AI 生成 → 占位图兜底
 * ```
 *
 * 每个用例通过 `FakeAssetResolverBuilder` 编排让槽位停在链的不同环节，
 * 或验证相邻环节之间的降级行为 —— 不存在「某类槽位固定走某个来源」的
 * 特例。角色的路由不猜文本：生产调用在 query / request 里带着 `role`，
 * fake 直接读它（见 `LicensedSourceQuery.role` / `ImageRequest.role`）。
 */

function envelopeFor(totalDays: number): AssetRequirement {
  const plan = makeTravelPlanFixture({ totalDays });
  const merged = mergeRequirements(buildPresentationPlans({ plan }));
  return assetRequirementEnvelope({
    planId: plan.plan_id,
    planVersionId: plan.plan_version_id,
    templateId: 'ink_paper_v1',
    requirements: merged.requirements,
  });
}

/** 只保留指定角色的槽位：并发隔离用例不需要美食槽位来稀释搜索预算 */
function envelopeForRoles(totalDays: number, roles: readonly AssetRole[]): AssetRequirement {
  const envelope = envelopeFor(totalDays);
  return {
    ...envelope,
    requirements: envelope.requirements.filter((item) => roles.includes(item.role)),
  };
}

function fakeRepo(): AssetsRepository {
  const inserted = new Map<string, AssetCandidateRow>();
  const insertedById = new Map<string, AssetCandidateRow>();

  return {
    findCandidates: () => Promise.resolve([]),
    findByCacheKey: (key) => {
      const insertedRow = inserted.get(key);
      if (insertedRow !== undefined) return Promise.resolve(insertedRow);
      return Promise.resolve(null);
    },
    findById: (assetId) => Promise.resolve(insertedById.get(assetId) ?? null),
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: (input) => {
      const row: AssetCandidateRow = {
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
        qualityScore: input.qualityScore ?? 0.5,
        licenseType: input.licenseType,
        attributionText: input.attributionText,
        styleTags: input.styleTags,
        cosine: null,
      };
      inserted.set(input.cacheKey ?? '', row);
      insertedById.set(input.assetId, row);
      return Promise.resolve({ assetId: input.assetId, created: true });
    },
    insertVariant: () => Promise.resolve(),
  };
}

/**
 * 带占位图的假仓储。
 *
 * 占位图是降级链的最后一环（`STATIC_DEFAULT`），必须预先入库。
 * 这个假仓储在 `findByCacheKey` 里识别占位图缓存键并返回对应素材，
 * 让「素材库 miss → 搜索 miss → AI 超时 → 占位图」的完整链路可测。
 *
 * 同时记录搜索入库的素材（`insertAsset`），让 `findById` 能读回来
 * （`licensed-source.ts` 在入库后会按 ID 读回）。
 */
function fakeRepoWithPlaceholders(): AssetsRepository {
  const inserted = new Map<string, AssetCandidateRow>();
  const insertedById = new Map<string, AssetCandidateRow>();

  return {
    findCandidates: () => Promise.resolve([]),
    findByCacheKey: (key) => {
      // 先检查插入的素材（搜索入库或 AI 生成的）
      const insertedRow = inserted.get(key);
      if (insertedRow !== undefined) return Promise.resolve(insertedRow);

      // 占位图缓存键命中（让降级链的最后一环可用）
      const placeholder = PLACEHOLDER_SPECS.find((spec) => spec.cacheKey === key);
      if (placeholder !== undefined) {
        return Promise.resolve({
          assetId: `placeholder-${placeholder.role.toLowerCase()}`,
          entityName: null,
          destinationName: null,
          destinationPlaceId: null,
          assetType: 'IMAGE',
          sourceType: 'DEFAULT_PLACEHOLDER',
          representationType: 'ILLUSTRATIVE',
          mimeType: 'image/webp',
          storageUrl: `https://cdn.test/placeholder-${placeholder.role.toLowerCase()}.webp`,
          thumbnailUrl: `https://cdn.test/placeholder-${placeholder.role.toLowerCase()}-thumb.webp`,
          width: placeholder.width,
          height: placeholder.height,
          aspectRatio: placeholder.width / placeholder.height,
          qualityScore: 0.5,
          licenseType: 'PLATFORM_OWNED',
          attributionText: null,
          styleTags: [],
          cosine: null,
        });
      }
      return Promise.resolve(null);
    },
    findById: (assetId) =>
      // 按 ID 查找插入的素材
      Promise.resolve(insertedById.get(assetId) ?? null),
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: (input) => {
      // 记录插入的素材，让 findByCacheKey / findById 能读回来
      const row: AssetCandidateRow = {
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
        qualityScore: input.qualityScore ?? 0.5,
        licenseType: input.licenseType,
        attributionText: input.attributionText,
        styleTags: input.styleTags,
        cosine: null,
      };
      inserted.set(input.cacheKey ?? '', row);
      insertedById.set(input.assetId, row);
      return Promise.resolve({ assetId: input.assetId, created: true });
    },
    insertVariant: () => Promise.resolve(),
  };
}

const embedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
};

/**
 * 生成一张能通过 11.2 入库门禁的测试图。
 *
 * 尺寸必须按槽位约束给（Hero 16:6、景点 16:9、美食 4:3）：比例偏差超过
 * 半个八度会被 `processImage` 拒收 —— 这正是本文件早先版本里「搜索命中
 * 却落成占位图」的真正原因（拿 16:9 的图喂 16:6 的 Hero 槽位），而不是
 * 当时的注释所猜的质量门禁。均匀随机噪点的拉普拉斯方差高、亮度居中，
 * 质量分稳过 9.6 的 0.3 下限（`SEARCH_QUALITY_FLOOR`）。
 */
async function noisyImage(width: number, height: number): Promise<Uint8Array> {
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

/** 授权图源候选：授权与 MIME 是入库的前两道门禁（下载之前），必须可映射 */
function licensedCandidate(url: string): LicensedSourceCandidate {
  return {
    provider: 'fake-openverse',
    originalUrl: url,
    downloadUrl: url,
    licenseType: 'CC0',
    attributionText: null,
    licenseExpiresAt: null,
    mimeType: 'image/jpeg',
  };
}

/** 能通过十章评分阈值（≥ 0.65）的库内 Hero 素材 */
function libraryHeroRow(): AssetCandidateRow {
  return {
    assetId: 'hero-1',
    entityName: null,
    destinationName: '杭州',
    destinationPlaceId: 'cn-hangzhou',
    assetType: 'IMAGE',
    sourceType: 'PLATFORM_LIBRARY',
    representationType: 'PHOTOGRAPHIC',
    mimeType: 'image/webp',
    storageUrl: 'https://cdn.test/hero.webp',
    thumbnailUrl: 'https://cdn.test/hero-thumb.webp',
    width: 1600,
    height: 600,
    aspectRatio: 16 / 6,
    qualityScore: 0.9,
    licenseType: 'PLATFORM_OWNED',
    attributionText: null,
    styleTags: [],
    cosine: 0.9,
  };
}

function searchLayer(search: LicensedSourceClient) {
  return {
    search,
    searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
    searchTimeoutMs: 5000,
  };
}

function aiLayer(image: ImageClient) {
  return {
    image,
    assetLock: new InMemoryAssetLock(),
    budget: new AiImageBudget({
      counters: new InMemoryCounterStore(),
      userType: 'REGISTERED' as const,
      heroQuota: 2,
      jobAiBudgetMs: 80_000,
      chainWorstCaseMs: 20_000,
    }),
    imageTimeoutMs: 20_000,
    userTypeLabel: 'REGISTERED' as const,
  };
}

const IMAGE_SLOT = /hero|photo|food/;

describe('素材解析全链路（FakeAssetResolverBuilder）', () => {
  it('逐级命中：Hero 素材库命中即返回；Photo 素材库 miss → 搜索命中；Food 素材库 miss → 搜索 miss → AI 命中', async () => {
    const photoBytes = await noisyImage(1600, 900);
    const foodBytes = await noisyImage(1200, 900);

    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        byRole: { HERO_BACKGROUND: { hit: [libraryHeroRow()] } },
        default: { miss: true },
      })
      .licensedSource({
        byRole: {
          DESTINATION_PHOTO: { candidates: [licensedCandidate('https://example.test/photo')] },
          // 美食的「搜索 miss」：搜了但没有可用候选。不编排成 error ——
          // 失败会记连续失败计数，两次就熔断，会把同任务里景点槽位的搜索也关掉
          FOOD_IMAGE: { candidates: [] },
        },
        default: { error: 'timeout' },
      })
      .aiGenerator({
        byRole: { FOOD_IMAGE: { bytes: foodBytes } },
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepo(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: searchLayer(new FakeLicensedSourceClient({ bytes: photoBytes })),
        ai: aiLayer(new FakeImageClient(() => foodBytes)),
      });

    const { all, response } = await resolveAssets(deps, envelopeFor(1));

    expect(response.status).toBe('COMPLETED');

    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.status).toBe('RESOLVED');
    expect(hero.resolution.strategy).toBe('LOCAL_LIBRARY_MATCH');

    const photo = all.find((r) => r.slot_id === photoSpotSlotId(1, 0))!;
    expect(photo.status).toBe('RESOLVED');
    expect(photo.resolution.strategy).toBe('LICENSED_SOURCE_MATCH');

    const foods = all.filter((r) => r.slot_id.includes('food'));
    expect(foods.length).toBeGreaterThan(0);
    for (const food of foods) {
      expect(food.status).toBe('RESOLVED');
      expect(food.resolution.strategy).toBe('AI_GENERATION');
    }
  });

  it('素材库超时降级：Hero 素材库延迟 1000ms（> 800ms 检索预算）按 miss 处理，继续走搜索层并命中', async () => {
    // 16:9 的图进不了 16:6 的 Hero 槽位（比例门禁），Hero 的搜索命中图必须按 16:6 给
    const heroBytes = await noisyImage(1600, 600);

    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        byRole: { HERO_BACKGROUND: { delayMs: 1000 } },
        default: { miss: true },
      })
      .licensedSource({
        byRole: { HERO_BACKGROUND: { candidates: [licensedCandidate('https://example.test/hero')] } },
        // 其余槽位搜索 miss（空候选），不记失败计数 —— 英雄槽位延迟 1 秒，
        // 若其他槽位的搜索失败先于它完成，熔断会抢在它的搜索之前触发
        default: { candidates: [] },
      })
      .aiGenerator({ default: { error: 'unavailable' } })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: searchLayer(new FakeLicensedSourceClient({ bytes: heroBytes })),
        ai: aiLayer(new FakeImageClient(() => new Uint8Array())),
      });

    const { all } = await resolveAssets(deps, envelopeFor(1));

    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.status).toBe('RESOLVED');
    expect(hero.resolution.strategy).toBe('LICENSED_SOURCE_MATCH');
  });

  it('搜索连续失败熔断：连续失败 2 次后，后续槽位不再发起搜索，直接降入 AI → 占位图', async () => {
    /*
     * 素材解析在天级与槽位级都是并发的，「第 3 个槽位」的顺序在单次解析里
     * 不可控；而熔断状态在 `ImageSearchBudget` 实例上（每任务一个）。
     * 因此用同一个 budget 连跑两次解析来模拟「同一任务内的后续槽位」：
     * 第一次把连续失败计数打满，第二次验证搜索一次都不再发起。
     *
     * 搜索层在单槽位内不重试（9.6：超时即降入 AI 层）—— 因此不存在
     * 「前两次超时、第三次命中」的单槽位路径，那个旧用名描述的行为
     * 在真实链路里不可能发生。
     */
    const searchClient = new FakeLicensedSourceClient(); // 无候选源：search 记录 searchCalls 后抛「不可用」
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({ default: { miss: true } })
      .aiGenerator({ default: { error: 'unavailable' } })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: searchLayer(searchClient),
        ai: aiLayer(new FakeImageClient(() => new Uint8Array())),
      });
    const envelope = envelopeFor(1);

    const first = await resolveAssets(deps, envelope);
    const callsAfterFirst = searchClient.searchCalls.length;
    // 搜索真的发生过且失败（否则熔断无从谈起）
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);
    expect(first.warnings).toContain('ASSET_LICENSED_SOURCE_UNAVAILABLE');

    const second = await resolveAssets(deps, envelope);
    // 熔断后：一次搜索都不再发起，所有图片槽位直接经 AI（不可用）落到占位图
    expect(searchClient.searchCalls.length).toBe(callsAfterFirst);
    expect(second.warnings).toContain('ASSET_LICENSED_SOURCE_UNAVAILABLE');
    const imageSlots = second.all.filter((r) => IMAGE_SLOT.test(r.slot_id));
    expect(imageSlots.length).toBeGreaterThan(0);
    for (const slot of imageSlots) {
      expect(slot.status).toBe('FALLBACK');
      expect(slot.resolution.strategy).toBe('STATIC_DEFAULT');
    }
  });

  it('AI 超时降级：Food 素材库 miss → 搜索 miss → AI 生成超时 → 占位图', async () => {
    // Hero 与景点停在搜索层，只有美食槽位会走到 AI；
    // 两者下载的字节必须各自满足本角色的比例约束（16:6 / 16:9），按候选 URL 区分
    const heroBytes = await noisyImage(1600, 600);
    const photoBytes = await noisyImage(1600, 900);
    const searchClient: LicensedSourceClient = {
      providers: ['fake-openverse'],
      // 搜索行为全部由编排层给出或拦截，真实客户端不应被触达
      search: () => Promise.reject(new Error('不应到达：搜索行为由编排层直接给出')),
      download: (candidate) =>
        Promise.resolve(candidate.originalUrl.includes('hero') ? heroBytes : photoBytes),
    };

    const deps = new FakeAssetResolverBuilder()
      .localLibrary({ default: { miss: true } })
      .licensedSource({
        byRole: {
          HERO_BACKGROUND: { candidates: [licensedCandidate('https://example.test/hero')] },
          DESTINATION_PHOTO: { candidates: [licensedCandidate('https://example.test/photo')] },
          // 美食的「搜索 miss」：空候选，不记失败计数
          FOOD_IMAGE: { candidates: [] },
        },
        default: { error: 'timeout' },
      })
      .aiGenerator({
        byRole: { FOOD_IMAGE: { error: 'timeout' } },
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: searchLayer(searchClient),
        ai: aiLayer(new FakeImageClient(() => new Uint8Array())),
      });

    const { all, warnings } = await resolveAssets(deps, envelopeFor(1));

    // Hero 与景点停在搜索层，不消耗任何 AI 调用
    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.resolution.strategy).toBe('LICENSED_SOURCE_MATCH');
    const photo = all.find((r) => r.slot_id === photoSpotSlotId(1, 0))!;
    expect(photo.resolution.strategy).toBe('LICENSED_SOURCE_MATCH');

    // 美食：AI 失败后落到已入库的占位图。
    // 三个美食槽位里前两个真的尝试了 AI 并失败，第三个被
    // MAX_AI_FAILURES_PER_JOB（=2）熔断直接跳过 —— 两者殊途同归到占位图
    const food = all.find((r) => r.slot_id === foodSlotId(1, 'LUNCH'))!;
    expect(food.status).toBe('FALLBACK');
    expect(food.resolution.strategy).toBe('STATIC_DEFAULT');
    expect(food.asset?.asset_id).toBe('placeholder-food_image');
    expect(warnings).toContain('ASSET_AI_GENERATION_FAILED');
  });

  it('全链路降级：Hero 素材库 miss → 搜索 miss → AI 超时 → 占位图', async () => {
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({ default: { miss: true } })
      // 「搜索 miss」用空候选编排：它是正常结果，不触发连续失败熔断
      .licensedSource({ default: { candidates: [] } })
      .aiGenerator({ default: { error: 'timeout' } })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: searchLayer(new FakeLicensedSourceClient()),
        ai: aiLayer(new FakeImageClient(() => new Uint8Array())),
      });

    const { all, response } = await resolveAssets(deps, envelopeFor(1));

    expect(response.status).toBe('COMPLETED');
    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.status).toBe('FALLBACK');
    expect(hero.asset?.asset_id).toBe('placeholder-hero_background');

    // ROUTE_MAP 走程序生成的 SVG 路径，不在本条降级链上
    const imageSlots = all.filter((r) => IMAGE_SLOT.test(r.slot_id));
    expect(imageSlots.length).toBeGreaterThan(0);
    for (const slot of imageSlots) {
      expect(slot.status).toBe('FALLBACK');
      expect(slot.resolution.strategy).toBe('STATIC_DEFAULT');
      expect(slot.asset?.asset_id).toMatch(/^placeholder-/);
    }
  });

  it('并发隔离：两个槽位并发各自走统一降级链、停在不同环节，互不干扰', async () => {
    // 只留 Hero 与景点槽位：美食槽位也会消耗单任务搜索预算（9.6 的 8 次），
    // 两天连跑会把预算耗尽，让断言的对象从「并发隔离」变成「预算截断」
    const photoBytes = await noisyImage(1600, 900);

    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        byRole: { HERO_BACKGROUND: { hit: [libraryHeroRow()] } },
        default: { miss: true },
      })
      .licensedSource({
        byRole: { DESTINATION_PHOTO: { candidates: [licensedCandidate('https://example.test/photo')] } },
        default: { error: 'timeout' },
      })
      .build({
        assets: fakeRepo(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: searchLayer(new FakeLicensedSourceClient({ bytes: photoBytes })),
      });

    const { all } = await resolveAssets(
      deps,
      envelopeForRoles(2, ['HERO_BACKGROUND', 'DESTINATION_PHOTO']),
    );

    for (const day of [1, 2]) {
      const hero = all.find((r) => r.slot_id === heroSlotId(day))!;
      expect(hero.resolution.strategy).toBe('LOCAL_LIBRARY_MATCH');
      const photo = all.find((r) => r.slot_id === photoSpotSlotId(day, 0))!;
      expect(photo.status).toBe('RESOLVED');
      expect(photo.resolution.strategy).toBe('LICENSED_SOURCE_MATCH');
    }
  });
});
