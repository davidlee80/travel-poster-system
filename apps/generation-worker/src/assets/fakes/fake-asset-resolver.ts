import type { AssetsRepository } from '@tps/db';
import type { ImageClient, LicensedSourceClient } from '@tps/llm';
import type { ObjectStorage } from '@tps/storage';
import type { EmbeddingClient } from '@tps/llm';
import type { Logger, UserType } from '@tps/shared';
import type { AssetLock } from '@tps/queue';
import type { AiImageBudget } from '../ai-budget.js';
import type { ImageSearchBudget } from '../search-budget.js';

import type { ResolveAssetsDeps } from '../resolve-assets.js';
import { wrapLocalLibrary, type FakeLocalLibraryOptions } from './fake-local-library.js';
import { wrapLicensedSource, type FakeLicensedSourceOptions } from './fake-licensed-source.js';
import { wrapAiGenerator, type FakeAiGeneratorOptions } from './fake-ai-generator.js';

/**
 * Fake 素材解析器编排入口。
 *
 * 用于测试：一行配置表达「这个槽位走素材库、那个槽位走搜索、另一个槽位走 AI」，
 * 而不需要手写整个 `fakeRepo` + `FakeLicensedSourceClient` + `FakeImageClient` 的组合。
 *
 * ## 设计要点
 *
 * - **声明式编排**：测试用一行配置表达每个槽位的行为；
 * - **零业务代码改动**：全部通过装饰器实现，不修改 `resolve-assets.ts` 或任何 resolver；
 * - **与现有 fake 客户端共存**：`FakeLlmClient` / `FakeImageClient` / `FakeLicensedSourceClient` 的既有测试不受影响；
 * - **覆盖全链路**：能测「素材库超时 → 搜索命中 → AI 降级」的完整降级链。
 *
 * ## 用法示例
 *
 * ```typescript
 * const deps = new FakeAssetResolverBuilder()
 *   .localLibrary({
 *     byRole: {
 *       HERO_BACKGROUND: { hit: [heroAsset], delayMs: 100 },
 *       DESTINATION_PHOTO: { miss: true },
 *     },
 *   })
 *   .licensedSource({
 *     byRole: {
 *       DESTINATION_PHOTO: { candidates: [photoCandidate], delayMs: 3000 },
 *     },
 *   })
 *   .aiGenerator({
 *     byRole: {
 *       FOOD_IMAGE: { bytes: foodImageBytes, delayMs: 15000 },
 *     },
 *   })
 *   .build();
 *
 * const result = await resolveAssets(deps, envelope);
 * ```
 */
export class FakeAssetResolverBuilder {
  private localLibraryOptions: FakeLocalLibraryOptions = {};
  private licensedSourceOptions: FakeLicensedSourceOptions = {};
  private aiGeneratorOptions: FakeAiGeneratorOptions = {};

  /** 素材库行为 */
  localLibrary(options: FakeLocalLibraryOptions): this {
    this.localLibraryOptions = options;
    return this;
  }

  /** 授权图源行为 */
  licensedSource(options: FakeLicensedSourceOptions): this {
    this.licensedSourceOptions = options;
    return this;
  }

  /** AI 生成行为 */
  aiGenerator(options: FakeAiGeneratorOptions): this {
    this.aiGeneratorOptions = options;
    return this;
  }

  /** 构造 ResolveAssetsDeps */
  build(base: {
    assets: AssetsRepository;
    storage: ObjectStorage;
    embedding: EmbeddingClient;
    logger: Logger;
    licensedSource?: {
      search: LicensedSourceClient;
      searchBudget: ImageSearchBudget;
      searchTimeoutMs: number;
    };
    ai?: {
      image: ImageClient;
      assetLock: AssetLock;
      budget: AiImageBudget;
      imageTimeoutMs: number;
      userTypeLabel: UserType;
    };
  }): ResolveAssetsDeps {
    const assets = wrapLocalLibrary(base.assets, this.localLibraryOptions);
    const licensedSource = base.licensedSource
      ? {
          search: wrapLicensedSource(base.licensedSource.search, this.licensedSourceOptions),
          searchBudget: base.licensedSource.searchBudget,
          searchTimeoutMs: base.licensedSource.searchTimeoutMs,
        }
      : undefined;
    const ai = base.ai
      ? {
          ...base.ai,
          image: wrapAiGenerator(base.ai.image, this.aiGeneratorOptions),
        }
      : undefined;

    return {
      assets,
      storage: base.storage,
      embedding: base.embedding,
      logger: base.logger,
      ...(licensedSource === undefined ? {} : { licensedSource }),
      ...(ai === undefined ? {} : { ai }),
    };
  }
}
