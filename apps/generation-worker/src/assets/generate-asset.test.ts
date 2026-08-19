import type { AssetCandidateRow, AssetsRepository, InsertAssetInput } from '@tps/db';
import { FakeImageClient, type EmbeddingClient } from '@tps/llm';
import { AiAssetGenerateResponseSchema, type AiAssetGenerateRequest } from '@tps/schemas';
import { InMemoryObjectStorage } from '@tps/storage';
import { createSilentLogger } from '@tps/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { UnsupportedAiAssetTypeError, generateAiAsset } from './generate-asset.js';
import { preheatTargets } from './preheat.js';

/**
 * 14.3 的契约实现（TP-4-01）。
 *
 * ## 端点在哪里
 *
 * 见 generate-asset.ts 的 R-32：14.3 不作为 `apps/api` 的路由 ——
 * 它需要 sharp（原生模块）、图片模型的付费凭据与对象存储写凭据，
 * 而把这三样交给面向公网的进程只换来「看起来像微服务」。
 * 契约由 schema 冻结（受控类型的白名单在 ai-asset.test.ts 里断言），
 * 这里断言的是**实现**：白名单外的类型不入库、同键不重复生成。
 */

async function gradient(width: number, height: number): Promise<Uint8Array> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#345" /></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg, 'utf8')).png().toBuffer());
}

const embedding: EmbeddingClient = {
  model: 'fake',
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
};

function harness(): {
  deps: Parameters<typeof generateAiAsset>[0];
  inserted: InsertAssetInput[];
  generatedSizes: string[];
} {
  const inserted: InsertAssetInput[] = [];
  const generatedSizes: string[] = [];
  const store = new Map<string, AssetCandidateRow>();

  const assets: AssetsRepository = {
    findCandidates: () => Promise.resolve([]),
    findByCacheKey: (key) => Promise.resolve(store.get(key) ?? null),
    findByContentHash: () => Promise.resolve(null),
    mergeTags: () => Promise.resolve(),
    insertAsset: (input) => {
      inserted.push(input);
      store.set(input.cacheKey ?? input.assetId, {
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

  return {
    inserted,
    generatedSizes,
    deps: {
      assets,
      storage: new InMemoryObjectStorage(),
      embedding,
      logger: createSilentLogger(),
      image: new FakeImageClient((request) => {
        generatedSizes.push(`${request.width}x${request.height}`);
        return gradient(request.width, request.height);
      }),
      imageTimeoutMs: 20_000,
    },
  };
}

/** 取一个预热目标当输入：与 19.5 真实用法一致 */
function heroRequest(): AiAssetGenerateRequest {
  return preheatTargets([{ place_id: 'cn_hangzhou', name: '杭州' }], ['canal_culture'])[0]!.request;
}

describe('生成并入库', () => {
  it('产出符合契约的响应，素材标 AI_GENERATED + ILLUSTRATIVE', async () => {
    const h = harness();
    const response = await generateAiAsset(h.deps, heroRequest());

    expect(AiAssetGenerateResponseSchema.parse(response)).toEqual(response);
    expect(response.created).toBe(true);
    expect(h.inserted[0]?.sourceType).toBe('AI_GENERATED');
    // 11.3 第五条
    expect(h.inserted[0]?.representationType).toBe('ILLUSTRATIVE');
    expect(h.inserted[0]?.cacheKey).toBe(heroRequest().cache_key);
  });

  it('按 min_width 与 Brief 的比例请求尺寸', async () => {
    const h = harness();
    await generateAiAsset(h.deps, heroRequest());
    expect(h.generatedSizes).toEqual(['1600x600']);
  });

  it('同缓存键已存在时直接复用，不再调用模型（19.5 的重跑几乎零成本）', async () => {
    const h = harness();
    const first = await generateAiAsset(h.deps, heroRequest());
    const second = await generateAiAsset(h.deps, heroRequest());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.asset_id).toBe(first.asset_id);
    // 只调用过一次模型
    expect(h.generatedSizes).toHaveLength(1);
    expect(h.inserted).toHaveLength(1);
  });

  it('复用时的 cost_units 为 0（成本核算不能把复用算成一次生成）', async () => {
    const h = harness();
    await generateAiAsset(h.deps, heroRequest());
    const second = await generateAiAsset(h.deps, heroRequest());
    expect(second.generation_metadata.cost_units).toBe(0);
  });
});

describe('14.3 受控类型', () => {
  it('非受控类型被 schema 拒（白名单）', async () => {
    const h = harness();
    const bad = { ...heroRequest(), asset_type: 'ROUTE_MAP_ILLUSTRATION' };
    await expect(
      generateAiAsset(h.deps, bad as unknown as AiAssetGenerateRequest),
    ).rejects.toThrow();
    expect(h.inserted).toHaveLength(0);
  });

  it('DECORATIVE_ILLUSTRATION 契约合法但 V1 无处安放 —— 抛错而不是猜一个角色', async () => {
    const h = harness();
    const request: AiAssetGenerateRequest = {
      ...heroRequest(),
      asset_type: 'DECORATIVE_ILLUSTRATION',
    };

    await expect(generateAiAsset(h.deps, request)).rejects.toThrow(UnsupportedAiAssetTypeError);
    /*
     * 猜一个角色（比如按 HERO_BACKGROUND 入库）会让它进入那个角色的检索
     * 候选集 —— 表现是「装饰插画出现在景点图的位置」，而没有任何报错。
     */
    expect(h.inserted).toHaveLength(0);
  });
});
