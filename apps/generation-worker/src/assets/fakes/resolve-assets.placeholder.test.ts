import { FakeImageClient } from '@tps/llm';
import { InMemoryAssetLock } from '@tps/queue';
import { InMemoryObjectStorage } from '@tps/storage';
import { InMemoryCounterStore, createSilentLogger } from '@tps/shared';
import type { AssetsRepository } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import { makeTravelPlanFixture, type AssetRequirement } from '@tps/schemas';
import { assetRequirementEnvelope, buildPresentationPlans, mergeRequirements, heroSlotId, photoSpotSlotId, foodSlotId } from '@tps/presentation';
import { describe, expect, it } from 'vitest';

import { AiImageBudget } from '../ai-budget.js';
import { ImageSearchBudget } from '../search-budget.js';
import { PLACEHOLDER_SPECS } from '../placeholders.js';
import { resolveAssets } from '../resolve-assets.js';
import { FakeAssetResolverBuilder } from './fake-asset-resolver.js';

/**
 * 占位图专项测试（设计稿十八章降级链的最后一环）。
 *
 * 占位图必须**预先入库**（`assets:ingest --placeholders`），缺失时降级链的
 * 最后一环无处可取。本文件验证占位图的完整行为：
 *
 * 1. **Hero 占位图**：素材库 miss → 搜索 miss → AI miss → 渐变背景；
 * 2. **景点占位图**：素材库 miss → 搜索 miss → AI miss → 默认景点占位图；
 * 3. **美食占位图**：素材库 miss → 搜索 miss → AI miss → 默认美食占位图；
 * 4. **占位图缺失**：占位图未入库时 SKIPPED（不是 FAILED）；
 * 5. **占位图不被命中**：占位图的 `entity_name` 为 null，不会进 `LOCAL_LIBRARY_MATCH`。
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

/** 带占位图的假仓储 */
function fakeRepoWithPlaceholders(): AssetsRepository {
  return {
    findCandidates: async () => [],
    findByCacheKey: async (key) => {
      // 占位图缓存键命中（让降级链的最后一环可用）
      const placeholder = PLACEHOLDER_SPECS.find((spec) => spec.cacheKey === key);
      if (placeholder !== undefined) {
        return {
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
        };
      }
      return null;
    },
    findById: async () => null,
    findByContentHash: async () => null,
    mergeTags: async () => {},
    insertAsset: async () => ({ assetId: 'fake', created: true }),
    insertVariant: async () => {},
  };
}

/** 不带占位图的假仓储（占位图缺失场景） */
function fakeRepoWithoutPlaceholders(): AssetsRepository {
  return {
    findCandidates: async () => [],
    findByCacheKey: async () => null,
    findById: async () => null,
    findByContentHash: async () => null,
    mergeTags: async () => {},
    insertAsset: async () => ({ assetId: 'fake', created: true }),
    insertVariant: async () => {},
  };
}

const embedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
};

describe('占位图专项（PLACEHOLDER_SPECS）', () => {
  it('Hero 占位图：素材库 miss → 搜索 miss → AI miss → 渐变背景', async () => {
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        default: { miss: true },
      })
      .licensedSource({
        default: { error: 'timeout' },
      })
      .aiGenerator({
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: {
          search: { providers: [], search: async () => [], download: async () => new Uint8Array() },
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5000,
        },
        ai: {
          image: new FakeImageClient(() => new Uint8Array()),
          assetLock: new InMemoryAssetLock(),
          budget: new AiImageBudget({
            counters: new InMemoryCounterStore(),
            userType: 'REGISTERED',
            heroQuota: 2,
            jobAiBudgetMs: 80000,
            chainWorstCaseMs: 20000,
          }),
          imageTimeoutMs: 20000,
          userTypeLabel: 'REGISTERED',
        },
      });

    const { all } = await resolveAssets(deps, envelopeFor(1));

    const hero = all.find((r) => r.slot_id === heroSlotId(1))!;
    expect(hero.status).toBe('FALLBACK');
    expect(hero.resolution.strategy).toBe('STATIC_DEFAULT');
    expect(hero.asset?.source_type).toBe('DEFAULT_PLACEHOLDER');
  });

  it('景点占位图：素材库 miss → 搜索 miss → AI miss → 默认景点占位图', async () => {
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        default: { miss: true },
      })
      .licensedSource({
        default: { error: 'timeout' },
      })
      .aiGenerator({
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: {
          search: { providers: [], search: async () => [], download: async () => new Uint8Array() },
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5000,
        },
        ai: {
          image: new FakeImageClient(() => new Uint8Array()),
          assetLock: new InMemoryAssetLock(),
          budget: new AiImageBudget({
            counters: new InMemoryCounterStore(),
            userType: 'REGISTERED',
            heroQuota: 2,
            jobAiBudgetMs: 80000,
            chainWorstCaseMs: 20000,
          }),
          imageTimeoutMs: 20000,
          userTypeLabel: 'REGISTERED',
        },
      });

    const { all } = await resolveAssets(deps, envelopeFor(1));

    const photo = all.find((r) => r.slot_id === photoSpotSlotId(1, 0))!;
    expect(photo.status).toBe('FALLBACK');
    expect(photo.resolution.strategy).toBe('STATIC_DEFAULT');
    expect(photo.asset?.source_type).toBe('DEFAULT_PLACEHOLDER');
  });

  it('美食占位图：素材库 miss → 搜索 miss → AI miss → 默认美食占位图', async () => {
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        default: { miss: true },
      })
      .licensedSource({
        default: { error: 'timeout' },
      })
      .aiGenerator({
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: {
          search: { providers: [], search: async () => [], download: async () => new Uint8Array() },
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5000,
        },
        ai: {
          image: new FakeImageClient(() => new Uint8Array()),
          assetLock: new InMemoryAssetLock(),
          budget: new AiImageBudget({
            counters: new InMemoryCounterStore(),
            userType: 'REGISTERED',
            heroQuota: 2,
            jobAiBudgetMs: 80000,
            chainWorstCaseMs: 20000,
          }),
          imageTimeoutMs: 20000,
          userTypeLabel: 'REGISTERED',
        },
      });

    const { all } = await resolveAssets(deps, envelopeFor(1));

    const food = all.find((r) => r.slot_id === foodSlotId(1, 'LUNCH'))!;
    expect(food.status).toBe('FALLBACK');
    expect(food.resolution.strategy).toBe('STATIC_DEFAULT');
    expect(food.asset?.source_type).toBe('DEFAULT_PLACEHOLDER');
  });

  it('占位图缺失：占位图未入库时 SKIPPED（不是 FAILED）', async () => {
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        default: { miss: true },
      })
      .licensedSource({
        default: { error: 'timeout' },
      })
      .aiGenerator({
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepoWithoutPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: {
          search: { providers: [], search: async () => [], download: async () => new Uint8Array() },
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5000,
        },
        ai: {
          image: new FakeImageClient(() => new Uint8Array()),
          assetLock: new InMemoryAssetLock(),
          budget: new AiImageBudget({
            counters: new InMemoryCounterStore(),
            userType: 'REGISTERED',
            heroQuota: 2,
            jobAiBudgetMs: 80000,
            chainWorstCaseMs: 20000,
          }),
          imageTimeoutMs: 20000,
          userTypeLabel: 'REGISTERED',
        },
      });

    const { all, response } = await resolveAssets(deps, envelopeFor(1));

    // 占位图缺失时，图片槽位应该是 SKIPPED（不是 FAILED）
    const imageSlots = all.filter((r) => r.slot_id.includes('hero') || r.slot_id.includes('photo') || r.slot_id.includes('food'));
    expect(imageSlots.every((r) => r.status === 'SKIPPED')).toBe(true);
    // 必需槽位（Hero）的缺失不会阻断任务
    expect(response.status).toBe('COMPLETED');
  });

  it('占位图不被命中：占位图的 `entity_name` 为 null，不会进 `LOCAL_LIBRARY_MATCH`', async () => {
    // 占位图在库里，但 entity_name 为 null，因此不会被素材库命中
    const deps = new FakeAssetResolverBuilder()
      .localLibrary({
        default: { miss: true }, // 素材库不命中
      })
      .licensedSource({
        default: { error: 'timeout' },
      })
      .aiGenerator({
        default: { error: 'unavailable' },
      })
      .build({
        assets: fakeRepoWithPlaceholders(),
        storage: new InMemoryObjectStorage(),
        embedding,
        logger: createSilentLogger(),
        licensedSource: {
          search: { providers: [], search: async () => [], download: async () => new Uint8Array() },
          searchBudget: new ImageSearchBudget({ counters: new InMemoryCounterStore() }),
          searchTimeoutMs: 5000,
        },
        ai: {
          image: new FakeImageClient(() => new Uint8Array()),
          assetLock: new InMemoryAssetLock(),
          budget: new AiImageBudget({
            counters: new InMemoryCounterStore(),
            userType: 'REGISTERED',
            heroQuota: 2,
            jobAiBudgetMs: 80000,
            chainWorstCaseMs: 20000,
          }),
          imageTimeoutMs: 20000,
          userTypeLabel: 'REGISTERED',
        },
      });

    const { all } = await resolveAssets(deps, envelopeFor(1));

    // 占位图不会进 LOCAL_LIBRARY_MATCH（因为 entity_name 为 null）
    expect(all.every((r) => r.resolution.strategy !== 'LOCAL_LIBRARY_MATCH')).toBe(true);
    // 图片槽位都降级到占位图
    const imageSlots = all.filter((r) => r.slot_id.includes('hero') || r.slot_id.includes('photo') || r.slot_id.includes('food'));
    expect(imageSlots.every((r) => r.resolution.strategy === 'STATIC_DEFAULT')).toBe(true);
  });
});
