import type { ModelPoolKind, ModelPoolSelection, ModelPoolsRepository } from '@tps/db';
import { FakeImageClient, type ImageClient, type LlmClient } from '@tps/llm';
import { createSilentLogger } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import { selectImageClient, selectLlmClient } from './model-selection.js';

/**
 * 按用户等级挑选候选模型（多模型 failover 计划的任务 4）。
 *
 * 三条断言对应三种不同的失效后果：
 *   - **两张表为空 → 回落 env 单模型**：这条保证「迁移完不配置任何池，
 *     系统行为与现在完全一致」，也就是整个特性可以渐进启用、回滚不需要动代码；
 *   - **不同 tier 拿到不同池**：运营配置的唯一可见效果，破了的话付费用户
 *     与免费用户用同一批模型而没人看得出来；
 *   - **图像候选数被时延预算截断**：运营把 `max_candidates` 配成 10 时不能
 *     真的去试 10 个（10 × 40 秒突破 300 秒任务上限）。
 */

const logger = createSilentLogger();

function pools(rows: readonly (ModelPoolSelection & { readonly kind: ModelPoolKind })[]): {
  readonly repository: ModelPoolsRepository;
  readonly queries: { kind: ModelPoolKind; tierLevel: number }[];
} {
  const queries: { kind: ModelPoolKind; tierLevel: number }[] = [];
  return {
    queries,
    repository: {
      select: (kind, tierLevel) => {
        queries.push({ kind, tierLevel });
        // 区间匹配由仓储的 SQL 负责（见 model-pools.integration.test.ts）；
        // 这里按 min_tier_level 取最大命中项，与那条 SQL 同语义
        const hit = rows
          .filter((row) => row.kind === kind && row.minTierLevel <= tierLevel)
          .sort((a, b) => b.minTierLevel - a.minTierLevel)[0];
        return Promise.resolve(hit === undefined ? null : hit);
      },
      invalidate: () => undefined,
    },
  };
}

const fallbackImage: ImageClient = new FakeImageClient(() => new Uint8Array([1]), 'env-image');
const buildImage = (model: string): ImageClient =>
  new FakeImageClient(() => new Uint8Array([1]), model);

function buildLlm(model: string): LlmClient {
  // 本测试只看「选了哪些模型」，从不真的调用 —— 因此 complete 不必可用
  return {
    model,
    complete: () => Promise.reject(new Error('未使用')),
  };
}

const fallbackLlm: LlmClient = buildLlm('env-llm');

describe('无配置时回落 env 单模型', () => {
  it('没有装配池仓储 → 原样返回 env 客户端', async () => {
    const selected = await selectImageClient({
      pools: null,
      tierLevel: 0,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.client).toBe(fallbackImage);
    expect(selected).toMatchObject({ candidates: [], poolName: null, clamped: false });
  });

  it('两张表为空（select 返回 null）→ 回落，行为与迁移前一致', async () => {
    const { repository } = pools([]);
    const selected = await selectImageClient({
      pools: repository,
      tierLevel: 10,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.client).toBe(fallbackImage);
    expect(selected.poolName).toBeNull();
  });

  it('读库抛错 → 回落而不是让任务失败（池不该成为新的单点）', async () => {
    const broken: ModelPoolsRepository = {
      select: () => Promise.reject(new Error('connection terminated')),
      invalidate: () => undefined,
    };

    const selected = await selectLlmClient({
      pools: broken,
      tierLevel: 0,
      logger,
      fallback: fallbackLlm,
      build: buildLlm,
      perAttemptMs: 30_000,
    });

    expect(selected.client).toBe(fallbackLlm);
  });
});

describe('不同 tier_level 取到不同池与候选数', () => {
  const rows = [
    {
      kind: 'IMAGE' as const,
      poolName: 'mixed',
      models: ['sd-3.5', 'flux-schnell', 'dalle-3'],
      maxCandidates: 1,
      minTierLevel: 0,
    },
    {
      kind: 'IMAGE' as const,
      poolName: 'paid',
      models: ['flux-pro', 'dalle-3'],
      maxCandidates: 2,
      minTierLevel: 10,
    },
  ];

  it('普通用户（tier 0）落混合池，只允许 1 个候选（本轮决策 5）', async () => {
    const { repository } = pools(rows);
    const selected = await selectImageClient({
      pools: repository,
      tierLevel: 0,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.poolName).toBe('mixed');
    expect(selected.candidates).toEqual(['sd-3.5']);
    // 单候选：装饰器不包装，客户端就是那一个（零开销）
    expect(selected.client.model).toBe('sd-3.5');
  });

  it('付费用户（tier 10）落付费池，放开到 2 个候选', async () => {
    const { repository } = pools(rows);
    const selected = await selectImageClient({
      pools: repository,
      tierLevel: 10,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.poolName).toBe('paid');
    expect(selected.candidates).toEqual(['flux-pro', 'dalle-3']);
  });

  it('tier 15 没有自己的映射，自动落到 10 那一档（区间匹配的收益）', async () => {
    const { repository } = pools(rows);
    const selected = await selectImageClient({
      pools: repository,
      tierLevel: 15,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.poolName).toBe('paid');
  });
});

describe('图像候选数受时延预算约束', () => {
  const wide = [
    {
      kind: 'IMAGE' as const,
      poolName: 'paid',
      models: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      maxCandidates: 10,
      minTierLevel: 0,
    },
  ];

  it('配置 10 个但预算只够 2 个 → 截断到 2 并标记 clamped', async () => {
    const { repository } = pools(wide);
    const selected = await selectImageClient({
      pools: repository,
      tierLevel: 0,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.candidates).toEqual(['a', 'b']);
    expect(selected.clamped).toBe(true);
  });

  it('预算够用时不标记 clamped（不该有假告警）', async () => {
    const { repository } = pools([{ ...wide[0]!, maxCandidates: 2 }]);
    const selected = await selectImageClient({
      pools: repository,
      tierLevel: 0,
      logger,
      fallback: fallbackImage,
      build: buildImage,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(selected.candidates).toHaveLength(2);
    expect(selected.clamped).toBe(false);
  });
});

describe('文本候选数只受 max_candidates 约束', () => {
  const rows = [
    {
      kind: 'LLM' as const,
      poolName: 'free',
      models: ['m1', 'm2', 'm3', 'm4', 'm5'],
      maxCandidates: 3,
      minTierLevel: 0,
    },
    {
      kind: 'LLM' as const,
      poolName: 'paid',
      models: ['p1', 'p2', 'p3', 'p4'],
      maxCandidates: null,
      minTierLevel: 10,
    },
  ];

  it('默认上限 3 个（本轮决策 5）', async () => {
    const { repository } = pools(rows);
    const selected = await selectLlmClient({
      pools: repository,
      tierLevel: 0,
      logger,
      fallback: fallbackLlm,
      build: buildLlm,
      perAttemptMs: 30_000,
    });

    expect(selected.candidates).toEqual(['m1', 'm2', 'm3']);
  });

  it('max_candidates 为 NULL → 遍历整个池，不被时延削掉', async () => {
    /*
     * 与图像侧刻意不同：4 × 30 秒 = 120 秒超过了 T1 的 75 秒目标，但 T1 是
     * P95 目标而不是硬上限，而 300 秒的任务预算兜住了最坏情况。
     * 这里若照图像那样截断，「特殊用户遍历整个池」就永远不会真的发生。
     */
    const { repository } = pools(rows);
    const selected = await selectLlmClient({
      pools: repository,
      tierLevel: 10,
      logger,
      fallback: fallbackLlm,
      build: buildLlm,
      perAttemptMs: 30_000,
    });

    expect(selected.candidates).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(selected.clamped).toBe(false);
  });
});
