import type {
  JobContext,
  RetrievalCandidate,
  RetrievalQuery,
  SavePlanVersionInput,
  SavedPlanVersion,
  TravelPlansRepository,
  UpdateJobStateInput,
} from '@tps/db';
import { FakeLlmClient, LocalHashingEmbeddingClient, LlmUnavailableError } from '@tps/llm';
import { makeValidContext, makeValidPlan } from '@tps/planning';
import {
  findForbiddenProjectionKeys,
  makeTravelPlanFixture,
  type JobStatus,
  type TravelPlan,
} from '@tps/schemas';
import { createSilentLogger } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import { PLAN_PROMPT_VERSION, generatePlan, type GeneratePlanDeps } from './generate-plan.js';

/**
 * 生成编排（TP-2-14，设计稿 3.2、16.1）。
 *
 * 仓储与模型都用假实现：SQL 由 `@tps/db` 的集成测试覆盖，模型调用由
 * `@tps/llm` 的单测覆盖。这里测的是**编排决策** ——
 * 状态推进顺序、失败时落哪个码、REJECTED 的落库顺序、投影与向量由谁算。
 */

/** 把完整计划转成模型会输出的形状（无 ID、无 schema_version、无 status） */
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

class FakePlans implements TravelPlansRepository {
  readonly transitions: UpdateJobStateInput[] = [];
  readonly saved: SavePlanVersionInput[] = [];
  context: JobContext | null;
  savePlanVersionError: Error | null = null;

  constructor(context: JobContext | null) {
    this.context = context;
  }

  createGeneration(): never {
    throw new Error('本测试不使用 createGeneration');
  }
  findByIdempotencyKey(): Promise<null> {
    return Promise.resolve(null);
  }
  findPlanForUser(): Promise<null> {
    return Promise.resolve(null);
  }
  findJobForUser(): Promise<null> {
    return Promise.resolve(null);
  }
  listPlansForUser(): Promise<{ items: []; nextCursor: null; hasMore: false }> {
    return Promise.resolve({ items: [], nextCursor: null, hasMore: false });
  }

  findJobContext(): Promise<JobContext | null> {
    return Promise.resolve(this.context);
  }

  updateJobState(input: UpdateJobStateInput): Promise<boolean> {
    this.transitions.push(input);
    if (this.context !== null) {
      this.context = { ...this.context, status: input.to, progress: input.progress };
    }
    return Promise.resolve(true);
  }

  savePlanVersion(input: SavePlanVersionInput): Promise<SavedPlanVersion> {
    if (this.savePlanVersionError !== null) return Promise.reject(this.savePlanVersionError);
    this.saved.push(input);
    return Promise.resolve({
      versionId: `version-${this.saved.length}`,
      versionNumber: this.saved.length,
      promoted: input.status !== 'REJECTED',
    });
  }

  /** 状态推进顺序，便于与 16.1 对照 */
  get path(): JobStatus[] {
    return this.transitions.map((entry) => entry.to as JobStatus);
  }
}

function jobContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'job-1',
    requestId: 'request-1',
    planId: 'plan-1',
    userId: 'user-1',
    status: 'QUEUED',
    progress: 0,
    normalizedRequest: makeValidContext().normalized,
    ...overrides,
  };
}

interface Harness {
  readonly deps: GeneratePlanDeps;
  readonly plans: FakePlans;
  readonly llm: FakeLlmClient;
  readonly retrievalQueries: RetrievalQuery[];
}

function harness(
  options: {
    readonly responses?: readonly unknown[];
    readonly context?: JobContext | null;
    readonly candidates?: readonly RetrievalCandidate[];
  } = {},
): Harness {
  const plans = new FakePlans(options.context === undefined ? jobContext() : options.context);
  const llm = new FakeLlmClient(options.responses ?? [llmOutputOf(makeValidPlan())]);
  const retrievalQueries: RetrievalQuery[] = [];

  return {
    plans,
    llm,
    retrievalQueries,
    deps: {
      plans,
      retrieval: {
        repository: {
          findSimilar: (query) => {
            retrievalQueries.push(query);
            return Promise.resolve(options.candidates ?? []);
          },
        },
        embedding: new LocalHashingEmbeddingClient(),
      },
      llm,
      embedding: new LocalHashingEmbeddingClient(),
      logger: createSilentLogger(),
      llmTimeoutMs: 30_000,
    },
  };
}

const payload = { jobId: 'job-1', requestId: 'request-1', planId: 'plan-1', userId: 'user-1' };

describe('16.1 状态推进', () => {
  it('顺序为 NORMALIZING → … → SAVING_PLAN', async () => {
    const { deps, plans } = harness();
    const result = await generatePlan(deps, payload);

    expect(result).toMatchObject({ outcome: 'saved', status: 'READY' });
    expect(plans.path).toEqual([
      'NORMALIZING',
      'VALIDATING_REQUEST',
      'RETRIEVING_REFERENCES',
      'GENERATING_PLAN',
      'VALIDATING_PLAN',
      'SAVING_PLAN',
      'SAVING_PLAN',
    ]);
  });

  it('P2 不推进到 COMPLETED', async () => {
    /*
     * 16.1 的 COMPLETED 必须经过 BUILDING_PRESENTATION → RESOLVING_ASSETS
     * → RENDERING_HTML，而那三段在 P3。直接跳过去会在状态机上开一条非法边，
     * 而那条边一旦存在，P3 接上真实渲染后「跳过渲染直接完成」仍然可走。
     */
    const { deps, plans } = harness();
    await generatePlan(deps, payload);
    expect(plans.path).not.toContain('COMPLETED');
  });

  it('进度按 16.2 查表且单调不减', async () => {
    const { deps, plans } = harness();
    await generatePlan(deps, payload);

    const progresses = plans.transitions.map((entry) => entry.progress);
    expect(progresses).toEqual([4, 8, 14, 20, 48, 60, 60]);
    for (let i = 1; i < progresses.length; i += 1) {
      expect(progresses[i]!).toBeGreaterThanOrEqual(progresses[i - 1]!);
    }
  });

  it('需要修复时插入 REPAIRING_PLAN', async () => {
    // 少一天 → V-01 BLOCKING → 走第二级重生成
    const broken = makeValidPlan();
    broken.days.pop();

    const { deps, plans } = harness({
      responses: [llmOutputOf(broken), llmOutputOf(makeValidPlan())],
    });
    const result = await generatePlan(deps, payload);

    expect(result.outcome).toBe('saved');
    expect(plans.path).toContain('REPAIRING_PLAN');
    // 回边不让进度回退：REPAIRING_PLAN(54) 之后仍是 54 或更大
    const repairIndex = plans.path.indexOf('REPAIRING_PLAN');
    expect(plans.transitions[repairIndex]!.progress).toBe(54);
  });

  it('任务已是终态时直接跳过（重复投递保护）', async () => {
    const { deps, plans } = harness({ context: jobContext({ status: 'COMPLETED' }) });
    const result = await generatePlan(deps, payload);

    expect(result).toEqual({ outcome: 'skipped', reason: 'already_terminal' });
    expect(plans.transitions).toEqual([]);
  });

  it('任务上下文不存在时跳过，不抛错', async () => {
    // 抛错会让 BullMQ 重试一个永远不会存在的任务
    const { deps } = harness({ context: null });
    expect(await generatePlan(deps, payload)).toEqual({ outcome: 'skipped', reason: 'not_found' });
  });
});

describe('6.3 生成与分段', () => {
  it('≤7 天只调一次模型', async () => {
    const { deps, llm } = harness();
    await generatePlan(deps, payload);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.maxTokens).toBe(16_384);
  });

  it('14 天分两段，token 用最高档', async () => {
    const context = jobContext({
      normalizedRequest: makeValidContext({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-04-10', end_date: '2026-04-23', flexibility_days: 0 },
        },
      }).normalized,
    });

    const sevenDays = makeTravelPlanFixture({ totalDays: 7, startDate: '2026-04-10' });
    const { deps, llm } = harness({
      context,
      responses: [llmOutputOf(sevenDays), llmOutputOf(sevenDays)],
    });

    await generatePlan(deps, payload);

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.maxTokens).toBe(49_152);
    expect(llm.calls[0]!.user).toContain('第 1 天到第 7 天');
    expect(llm.calls[1]!.user).toContain('第 8 天到第 14 天');
  });

  it('程序注入 ID，不采用模型输出里的任何标识符', async () => {
    /*
     * 6.3：plan_id / plan_version_id / request_id 由程序注入。
     * 模型编造的 ID 一旦被误信就会污染归属关系 —— 而它长得像个正常 UUID。
     */
    const polluted = llmOutputOf(makeValidPlan());
    polluted['plan_id'] = 'plan-from-model';
    polluted['request_id'] = 'request-from-model';

    const { deps, plans } = harness({ responses: [polluted] });
    await generatePlan(deps, payload);

    const saved = plans.saved[0]!.planJson as Record<string, unknown>;
    expect(saved['plan_id']).toBe('plan-1');
    expect(saved['request_id']).toBe('request-1');
  });
});

describe('3.2.4 历史参考', () => {
  it('检索时排除本次计划自身', async () => {
    const { deps, retrievalQueries } = harness();
    await generatePlan(deps, payload);
    expect(retrievalQueries[0]!.excludePlanId).toBe('plan-1');
  });

  it('无参考时把「无历史参考」写进 assumptions（TP-2-24）', async () => {
    const { deps, plans } = harness();
    await generatePlan(deps, payload);

    const saved = plans.saved[0]!.planJson as {
      constraint_report: { assumptions: { code: string }[] };
    };
    expect(saved.constraint_report.assumptions.map((a) => a.code)).toContain(
      'NO_HISTORICAL_REFERENCE',
    );
  });

  it('有参考时不写该假设，且参考进了提示', async () => {
    const other = makeTravelPlanFixture({ totalDays: 5, startDate: '2025-11-03' });
    const projection = {
      schema_version: 'retrieval_projection_v1',
      destination: { name: '杭州', place_id: 'cn-hangzhou' },
      total_days: 5,
      days: other.days.map((day) => ({
        theme: day.theme,
        subtitle: day.subtitle,
        schedule: day.schedule.map((item) => ({
          title: item.title,
          period: item.period,
          duration_minutes: item.duration_minutes,
          description: item.description,
          location: { name: item.location.name, place_id: item.location.place_id },
        })),
        food_recommendations: day.food_recommendations.map((food) => ({
          name: food.name,
          entity_type: food.entity_type,
        })),
        route_recommendations: day.route_recommendations.map((route) => ({ nodes: route.nodes })),
      })),
    };

    const { deps, plans, llm } = harness({
      candidates: [
        {
          id: 'v1',
          planId: 'other-plan',
          status: 'READY',
          destinationPlaceId: 'cn-hangzhou',
          totalDays: 5,
          projection,
          similarity: 0.9,
          source: 'versions',
        },
      ],
    });

    await generatePlan(deps, payload);

    expect(llm.calls[0]!.user).toContain('历史参考（');
    const saved = plans.saved[0]!.planJson as {
      constraint_report: { assumptions: { code: string }[] };
    };
    expect(saved.constraint_report.assumptions.map((a) => a.code)).not.toContain(
      'NO_HISTORICAL_REFERENCE',
    );
  });
});

describe('TP-2-14 持久化', () => {
  it('投影与向量都由最终落库的计划算出', async () => {
    /*
     * 用修复前的版本算，会让检索召回一份与库里内容不一致的行程结构 ——
     * 别人按那份参考生成，而它其实从未存在过。
     */
    const broken = makeValidPlan();
    broken.days[0]!.city = '苏州';

    const { deps, plans } = harness({ responses: [llmOutputOf(broken)] });
    await generatePlan(deps, payload);

    const input = plans.saved[0]!;
    const projection = input.retrievalProjection as { days: { theme: string }[] };
    const savedPlan = input.planJson as { days: { city: string }[] };

    expect(savedPlan.days[0]!.city).toBe('杭州');
    expect(projection.days).toHaveLength(5);
    expect(input.planEmbedding).not.toBeNull();
    expect(input.planEmbedding).toHaveLength(1_536);
  });

  it('落库的投影不含任何禁止字段', async () => {
    const { deps, plans } = harness();
    await generatePlan(deps, payload);
    expect(findForbiddenProjectionKeys(plans.saved[0]!.retrievalProjection)).toEqual([]);
  });

  it('记录模型、提示版本与迭代次数', async () => {
    // 21.3 的成本核算与「规则集是否过严」都依赖这几个字段
    const { deps, plans } = harness();
    await generatePlan(deps, payload);

    expect(plans.saved[0]).toMatchObject({
      llmModel: 'fake-recorded',
      llmPromptVersion: PLAN_PROMPT_VERSION,
      repairIterations: 0,
      regenerationCount: 0,
      destinationPlaceId: 'cn-hangzhou',
      totalDays: 5,
    });
  });

  it('修复过的计划落库为 REPAIRED', async () => {
    const broken = makeValidPlan();
    broken.days[0]!.city = '苏州';

    const { deps, plans } = harness({ responses: [llmOutputOf(broken)] });
    const result = await generatePlan(deps, payload);

    expect(result).toMatchObject({ outcome: 'saved', status: 'REPAIRED' });
    expect(plans.saved[0]!.status).toBe('REPAIRED');
    expect(plans.saved[0]!.repairIterations).toBeGreaterThan(0);
  });

  it('向量化失败不阻断保存', async () => {
    /*
     * 计划本身完全可用，只是暂时不参与他人的历史检索。
     * 让它阻断会因为一个「提高别人生成质量」的功能丢掉用户已生成的计划。
     */
    const { deps, plans } = harness();
    const failing: GeneratePlanDeps = {
      ...deps,
      embedding: {
        model: 'broken',
        dimensions: 1_536,
        embed: () => Promise.reject(new Error('向量服务不可用')),
      },
    };

    const result = await generatePlan(failing, payload);
    expect(result.outcome).toBe('saved');
    expect(plans.saved[0]!.planEmbedding).toBeNull();
  });

  it('持久化失败 → PLAN_PERSIST_FAILED', async () => {
    const { deps, plans } = harness();
    plans.savePlanVersionError = new Error('数据库写入失败');

    const result = await generatePlan(deps, payload);
    expect(result).toEqual({ outcome: 'failed', errorCode: 'PLAN_PERSIST_FAILED' });
    expect(plans.path.at(-1)).toBe('FAILED');
  });
});

describe('失败路径与错误码（16.3）', () => {
  it('模型不可用 → PLAN_LLM_UNAVAILABLE', async () => {
    const { deps, plans } = harness({ responses: [new LlmUnavailableError('上游 503')] });
    const result = await generatePlan(deps, payload);

    expect(result).toEqual({ outcome: 'failed', errorCode: 'PLAN_LLM_UNAVAILABLE' });
    expect(plans.transitions.at(-1)).toMatchObject({
      to: 'FAILED',
      errorCode: 'PLAN_LLM_UNAVAILABLE',
    });
  });

  it('输出不满足契约 → PLAN_SCHEMA_INVALID', async () => {
    const { deps } = harness({ responses: [{ title: '只有标题' }] });
    expect(await generatePlan(deps, payload)).toEqual({
      outcome: 'failed',
      errorCode: 'PLAN_SCHEMA_INVALID',
    });
  });

  it('库里的标准化结果形状不符 → PLAN_SCHEMA_INVALID，不调模型', async () => {
    const { deps, llm } = harness({
      context: jobContext({
        normalizedRequest: { schema_version: 'normalized_travel_request_v0' },
      }),
    });

    expect(await generatePlan(deps, payload)).toEqual({
      outcome: 'failed',
      errorCode: 'PLAN_SCHEMA_INVALID',
    });
    expect(llm.calls).toEqual([]);
  });

  it('硬约束修不好 → 先落库 REJECTED，再置 FAILED', async () => {
    /*
     * 3.2.2：修复失败的计划只落库供排查，不成为可展示版本。
     * 顺序不能反 —— 反了的话排查时拿不到那份草稿，
     * 而它是唯一能说明「模型到底写了什么」的证据。
     */
    const unsatisfiable = makeValidPlan();
    unsatisfiable.constraint_report.satisfied = [];

    const { deps, plans } = harness({
      responses: [
        llmOutputOf(unsatisfiable),
        llmOutputOf(unsatisfiable),
        llmOutputOf(unsatisfiable),
      ],
    });
    const result = await generatePlan(deps, payload);

    expect(result).toMatchObject({
      outcome: 'rejected',
      errorCode: 'PLAN_HARD_CONSTRAINT_UNSATISFIABLE',
    });
    expect(plans.saved).toHaveLength(1);
    expect(plans.saved[0]!.status).toBe('REJECTED');
    expect(plans.path.at(-1)).toBe('FAILED');
    // FAILED 的转移带上版本号，排查时能直接定位那份草稿
    expect(plans.transitions.at(-1)!.planVersionId).toBe('version-1');
  });

  it('REJECTED 版本不会被提升为当前版本', async () => {
    const unsatisfiable = makeValidPlan();
    unsatisfiable.constraint_report.satisfied = [];

    const { deps, plans } = harness({
      responses: [
        llmOutputOf(unsatisfiable),
        llmOutputOf(unsatisfiable),
        llmOutputOf(unsatisfiable),
      ],
    });
    await generatePlan(deps, payload);

    // 仓储按 status 决定是否提升；这里断言传下去的就是 REJECTED
    expect(plans.saved[0]!.status).toBe('REJECTED');
  });
});

describe('日志', () => {
  it('不把计划全文或标准化请求写进日志字段', async () => {
    /*
     * 二十章禁止 raw_request / plan_json 全文落日志。这里用静默 logger，
     * 因此真正的脱敏由 @tps/shared 的 logger.test.ts 保证；
     * 本条确认编排层没有绕过 logger 直接拼字符串。
     */
    const { deps } = harness();
    const lines: string[] = [];
    const capturing: GeneratePlanDeps = {
      ...deps,
      logger: {
        ...deps.logger,
        info: ((obj: unknown, msg?: string) => {
          lines.push(JSON.stringify(obj) + (msg ?? ''));
        }) as never,
        child: () => capturing.logger,
      } as never,
    };

    await generatePlan(capturing, payload);

    for (const line of lines) {
      expect(line).not.toContain('拱宸桥');
      expect(line).not.toContain('希望安排运河');
    }
  });
});
