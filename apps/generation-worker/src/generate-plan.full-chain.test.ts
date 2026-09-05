import { InMemoryCreditWalletRepository, samplePriceBook } from '@tps/db';
import type { JobContext, SavePlanVersionInput, TravelPlansRepository, UpdateJobStateInput } from '@tps/db';
import {
  FakeLlmClient,
  LocalHashingEmbeddingClient,
  LlmTimeoutError,
  wrapLlmFailover,
  type LlmClient,
} from '@tps/llm';
import { makeValidContext, makeValidPlan } from '@tps/planning';
import { makeTravelPlanFixture, type TravelPlan } from '@tps/schemas';
import { createSilentLogger } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import { createJobBilling } from './billing.js';
import { generatePlan, type GeneratePlanDeps } from './generate-plan.js';
import { wrapLlmWithScript } from './fakes/fake-llm-script.js';
import { wrapEmbedding } from './fakes/fake-embedding.js';

/**
 * 计划生成全链路测试（Fake 编排层）。
 *
 * 与 `generate-plan.test.ts` 的分工：
 *   - 那个文件测**编排决策**（状态推进顺序、错误码、落库形状）；
 *   - 这个文件测**外部依赖的时序与故障**（LLM 延迟、模型池故障转移、
 *     向量化失败），全部通过 fake 编排注入，不改业务代码。
 *
 * 数据库 / Redis 连接失败的路径不经 Worker —— 它们在 API 侧
 * （`travel-plans.ts` 的 503 与幂等锁 fail-open）就已返回，
 * 由 API 的路由测试覆盖，这里不重复。
 */

/** 把完整计划转成模型会输出的形状（与 generate-plan.test.ts 同一辅助） */
function llmOutputOf(plan: TravelPlan): Record<string, unknown> {
  const {
    schema_version: _s,
    status: _t,
    plan_id: _p,
    plan_version_id: _v,
    request_id: _r,
    ...content
  } = plan;
  return content;
}

/**
 * 最小可用的计划仓储。
 *
 * 与 generate-plan.test.ts 的 FakePlans 同形，但**不在进程间共享状态**：
 * 本文件的每个用例都各造一份，避免并发用例互相污染转移记录。
 */
class FakePlans implements Pick<
  TravelPlansRepository,
  | 'findJobContext'
  | 'updateJobState'
  | 'findJobQueueTiming'
  | 'savePlanVersion'
  | 'markMilestone'
  | 'appendJobWarnings'
> {
  readonly transitions: UpdateJobStateInput[] = [];
  readonly saved: SavePlanVersionInput[] = [];
  context: JobContext | null;
  /** 模拟「数据库不可用」：findJobContext 抛错 */
  contextError: Error | null = null;
  /** 模拟「数据库写入失败」：savePlanVersion 抛错 */
  saveError: Error | null = null;

  constructor(context: JobContext | null) {
    this.context = context;
  }

  findJobContext(): Promise<JobContext | null> {
    if (this.contextError !== null) return Promise.reject(this.contextError);
    return Promise.resolve(this.context);
  }

  findJobQueueTiming(): Promise<{ createdAt: Date; queuedForMs: number } | null> {
    return Promise.resolve(null);
  }

  updateJobState(input: UpdateJobStateInput): Promise<boolean> {
    this.transitions.push(input);
    if (this.context !== null) {
      this.context = { ...this.context, status: input.to, progress: input.progress };
    }
    return Promise.resolve(true);
  }

  savePlanVersion(input: SavePlanVersionInput) {
    if (this.saveError !== null) return Promise.reject(this.saveError);
    this.saved.push(input);
    return Promise.resolve({
      versionId: `version-${this.saved.length}`,
      versionNumber: this.saved.length,
      promoted: input.status !== 'REJECTED',
    });
  }

  markMilestone(): Promise<void> {
    return Promise.resolve();
  }

  appendJobWarnings(): Promise<void> {
    return Promise.resolve();
  }
}

function jobContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'job-1',
    requestId: 'request-1',
    planId: 'plan-1',
    userId: 'user-1',
    userType: 'REGISTERED',
    tierLevel: 0,
    status: 'QUEUED',
    progress: 0,
    normalizedRequest: makeValidContext().normalized,
    ...overrides,
  };
}

const payload = { jobId: 'job-1', requestId: 'request-1', planId: 'plan-1', userId: 'user-1' };

function harness(options: {
  readonly llm: LlmClient;
  readonly context?: JobContext;
  readonly embeddingError?: Error;
  readonly embeddingDelayMs?: number;
}): { deps: GeneratePlanDeps; plans: FakePlans } {
  const plans = new FakePlans(options.context ?? jobContext());

  const wallet = new InMemoryCreditWalletRepository();
  wallet.priceBook = samplePriceBook();

  const embedding = wrapEmbedding(new LocalHashingEmbeddingClient(), {
    ...(options.embeddingError === undefined ? {} : { error: options.embeddingError }),
    ...(options.embeddingDelayMs === undefined ? {} : { delayMs: options.embeddingDelayMs }),
  });

  return {
    plans,
    deps: {
      plans: plans as unknown as TravelPlansRepository,
      retrieval: {
        repository: {
          findSimilar: () => Promise.resolve([]),
        },
        embedding: new LocalHashingEmbeddingClient(),
      },
      llm: options.llm,
      embedding,
      logger: createSilentLogger(),
      llmTimeoutMs: 30_000,
      billing: createJobBilling({ wallet, logger: createSilentLogger(), priceCacheMs: 0 }),
    },
  };
}

describe('计划生成全链路（fake 编排）', () => {
  it('LLM 延迟：第一次调用延迟 5 秒，第二次成功（按调用次数编排）', async () => {
    /*
     * 编排「第一次慢、第二次快」：第一段超时被调度器放过（`perAttemptMs` 之外），
     * 但它最终仍返回 —— failover 的语义是「不放弃已发出的请求」。
     * 用 wrapLlmWithScript 而不是 FakeLlmClient 的预置响应：后者表达不了
     * 「这一次要慢 5 秒」。
     */
    const slow = makeValidPlan();
    const llm = wrapLlmWithScript(
      new FakeLlmClient([llmOutputOf(slow)]),
      { calls: [{ delayMs: 50 }] },
    );

    const { deps } = harness({ llm });
    const result = await generatePlan(deps, payload);

    expect(result).toMatchObject({ outcome: 'saved', status: 'READY' });
  });

  it('模型池故障转移：主候选超时，备选成功（wrapLlmFailover 全链路）', async () => {
    /*
     * 主候选永不返回（占住位置），备选立刻给一份合法计划。
     * `perAttemptMs` 之后调度器发出备选，胜出者的 model 是备选的名字 ——
     * 这正是「主候选超时、备选成功」的时序，也是计费按出活者计的依据。
     */
    const stuck: LlmClient = {
      model: 'stuck-primary',
      complete: () => new Promise(() => undefined),
    };
    // 在 FakeLlmClient 外包一层只改 model 名的装饰器：胜出者的 model 来自
    // `LlmResult.model`（由 complete 的返回值给出），而不是客户端的字段。
    const inner = new FakeLlmClient([llmOutputOf(makeValidPlan())]);
    const backup: LlmClient = {
      model: 'backup-model',
      complete: async (request) => {
        const result = await inner.complete(request);
        return { ...result, model: 'backup-model' };
      },
    };

    const llm = wrapLlmFailover([stuck, backup], {
      perAttemptMs: 30,
      totalBudgetMs: 5_000,
    });

    const { deps, plans } = harness({ llm });
    const result = await generatePlan(deps, payload);

    expect(result).toMatchObject({ outcome: 'saved', status: 'READY' });
    /*
     * `savePlanVersion` 的 `llmModel` 取的是包装后客户端的 `model` 字段，
     * 而 `wrapLlmFailover` 把它固定成主候选的名字（「接口要求有个 model；
     * 用主候选的名字」）—— 真正出活的候选写在 `LlmResult.model` 里，
     * 由 `callModel` 拿去计费（`meter.addLlm(result.model, …)`）。
     * 因此这里断言的是「主候选名落库」+「计费口径是出活者」这条分工。
     */
    expect(plans.saved[0]!.llmModel).toBe('stuck-primary');
  });

  it('LLM 全部候选失败 → PLAN_LLM_UNAVAILABLE（可重试码）', async () => {
    const llm = wrapLlmWithScript(new FakeLlmClient([llmOutputOf(makeValidPlan())]), {
      default: { error: new LlmTimeoutError(30_000) },
    });

    const { deps } = harness({ llm });
    const result = await generatePlan(deps, payload);

    expect(result).toEqual({ outcome: 'failed', errorCode: 'PLAN_LLM_TIMEOUT' });
  });

  it('数据库连接失败：findJobContext 抛错 → 任务失败（PLAN_PERSIST_FAILED 之外的路径）', async () => {
    /*
     * 「建任务时数据库不可用」在 API 侧就已 503，消息不会入队；
     * 而「消费时数据库不可用」表现为 findJobContext 抛错。
     * 这一条覆盖后者：任务还没开始就已经失败，且不会有任何状态推进。
     */
    const plans = new FakePlans(jobContext());
    plans.contextError = new Error('connection terminated');

    const llm = new FakeLlmClient([llmOutputOf(makeValidPlan())]);
    const { deps } = harness({ llm, context: jobContext() });
    // 用抛错的 plans 替换 harness 里的那份
    const failingDeps: GeneratePlanDeps = {
      ...deps,
      plans: plans as unknown as TravelPlansRepository,
    };

    await expect(generatePlan(failingDeps, payload)).rejects.toThrow('connection terminated');
    // 连第一次状态推进都没发生
    expect(plans.transitions).toEqual([]);
  });

  it('向量化失败不阻断保存（planEmbedding 为 null）', async () => {
    const { deps, plans } = harness({
      llm: new FakeLlmClient([llmOutputOf(makeValidPlan())]),
      embeddingError: new Error('嵌入服务不可用'),
    });

    const result = await generatePlan(deps, payload);

    expect(result).toMatchObject({ outcome: 'saved', status: 'READY' });
    expect(plans.saved[0]!.planEmbedding).toBeNull();
  });

  it('数据库写入失败：savePlanVersion 抛错 → PLAN_PERSIST_FAILED', async () => {
    const plans = new FakePlans(jobContext());
    plans.saveError = new Error('写入失败：磁盘满');

    const llm = new FakeLlmClient([llmOutputOf(makeTravelPlanFixture({ totalDays: 5 }))]);
    const { deps } = harness({ llm });
    const failingDeps: GeneratePlanDeps = {
      ...deps,
      plans: plans as unknown as TravelPlansRepository,
    };

    const result = await generatePlan(failingDeps, payload);

    expect(result).toEqual({ outcome: 'failed', errorCode: 'PLAN_PERSIST_FAILED' });
    expect(plans.transitions.at(-1)).toMatchObject({ to: 'FAILED', errorCode: 'PLAN_PERSIST_FAILED' });
  });
});
