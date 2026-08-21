import {
  createAssetsRepository,
  createPresentationsRepository,
  createRetrievalRepository,
  createTravelPlansRepository,
} from '@tps/db';
import {
  AI_IMAGE_TIMEOUT_MS,
  DEFAULT_IMAGE_JOB_AI_BUDGET_MS,
  FakeImageClient,
  FakeLlmClient,
  LocalHashingEmbeddingClient,
} from '@tps/llm';
import { InMemoryAssetLock } from '@tps/queue';
import { InMemoryCounterStore, createSilentLogger, type UserType } from '@tps/shared';
import { InMemoryObjectStorage } from '@tps/storage';
import type { Pool } from 'pg';

import { AiImageBudget } from './assets/ai-budget.js';
import { renderFakeGeneratedImage } from './assets/fake-image.js';
import { fixturePlanFor } from './fixture-plan.js';
import type { GeneratePlanDeps } from './generate-plan.js';

/**
 * 端到端测试的 Worker 依赖装配（TP-5-05）。
 *
 * 由 `pipeline.integration.test.ts`（链路正确性）与
 * `acceptance.integration.test.ts`（24.1 #1 的 20 个用例）共用。
 *
 * 抽出来的理由不是「避免重复」本身，而是**两处装配一旦分歧，两套测试
 * 验证的就是两个不同的系统**。比如一处给注册用户 2 次 AI Hero 额度、
 * 另一处给 0，那么门禁 #19（单任务成本上限）在两边会得出相反结论。
 *
 * ## 哪些用假实现，为什么
 *
 * ```text
 * LLM      fake（录制夹具）  真调用需要凭据，且模型改版会让测试随机变红
 * 图片模型 fake（渐变图）     同上。11.2 后处理、缓存键、并发去重全走真实路径
 * 对象存储 进程内            真实 MinIO 的写入由 @tps/storage 的集成测试覆盖
 * 数据库   真实 PostgreSQL   约束、触发器、jsonb 合并都只有真库能验证
 * Redis    真实              锁与配额计数的语义就在 Redis 里
 * ```
 */
export interface E2eWorkerDeps extends GeneratePlanDeps {
  readonly storage: InMemoryObjectStorage;
}

export function createE2eWorkerDeps(pool: Pool): E2eWorkerDeps {
  const embedding = new LocalHashingEmbeddingClient();
  const storage = new InMemoryObjectStorage();

  return {
    plans: createTravelPlansRepository(pool),
    retrieval: { repository: createRetrievalRepository(pool), embedding },
    // 与 LLM_MODE=fake 的默认行为一致：按请求构造录制输出
    llm: (normalized) => new FakeLlmClient([fixturePlanFor(normalized)]),
    embedding,
    logger: createSilentLogger(),
    llmTimeoutMs: 30_000,
    presentation: {
      assets: createAssetsRepository(pool),
      presentations: createPresentationsRepository(pool),
      storage,
      embedding,
    },
    /*
     * 每任务一个预算实例。`heroQuota` 按身份取，与生产一致（21.4：
     * 匿名 0 次、注册 2 次）—— 门禁 #19 与 21.4 的「匿名 AI Hero 为 0」
     * 都靠这个差异成立，测试里给同一个值会让那两条永远通过。
     */
    aiAssets: ({ userType }: { readonly userType: UserType }) => ({
      image: new FakeImageClient(renderFakeGeneratedImage),
      assetLock: new InMemoryAssetLock(),
      imageTimeoutMs: AI_IMAGE_TIMEOUT_MS,
      userTypeLabel: userType,
      budget: new AiImageBudget({
        counters: new InMemoryCounterStore(),
        userType,
        heroQuota: userType === 'ANONYMOUS' ? 0 : 2,
        jobAiBudgetMs: DEFAULT_IMAGE_JOB_AI_BUDGET_MS,
      }),
    }),
    storage,
  };
}
