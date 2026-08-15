import { RetrievalTimeoutError, type RetrievalCandidate, type RetrievalQuery } from '@tps/db';
import { LocalHashingEmbeddingClient } from '@tps/llm';
import {
  buildRetrievalProjection,
  makeValidContext,
  makeValidPlan,
  normalizedRequestToEmbeddingText,
} from '@tps/planning';
import { metricsText } from '@tps/observability';
import { describe, expect, it } from 'vitest';

import {
  NO_REFERENCE_ASSUMPTION,
  RETRIEVAL_DAY_TOLERANCE,
  RETRIEVAL_LIMIT,
  RETRIEVAL_MIN_SIMILARITY,
  RETRIEVAL_TIMEOUT_MS,
  retrieveReferences,
} from './retrieval.js';

/**
 * 检索编排（TP-2-23、TP-2-24、TP-2-25）。
 *
 * 仓储层的 SQL 行为由 `@tps/db` 的集成测试覆盖（门禁 #26、#28）。
 * 这里测的是编排决策：3.2.4 的四个约束值传下去了没有、三种「无参考」情形
 * 是否都继续生成、指标打没打点。
 */

const normalized = makeValidContext().normalized;
const projection = buildRetrievalProjection(makeValidPlan());
const embedding = new LocalHashingEmbeddingClient();

function candidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    id: 'version-1',
    planId: 'plan-1',
    status: 'READY',
    destinationPlaceId: 'cn-hangzhou',
    totalDays: 5,
    projection,
    similarity: 0.9,
    source: 'versions',
    ...overrides,
  };
}

function repositoryReturning(candidates: readonly RetrievalCandidate[]): {
  repository: { findSimilar: (q: RetrievalQuery) => Promise<readonly RetrievalCandidate[]> };
  queries: RetrievalQuery[];
} {
  const queries: RetrievalQuery[] = [];
  return {
    queries,
    repository: {
      findSimilar: (q) => {
        queries.push(q);
        return Promise.resolve(candidates);
      },
    },
  };
}

describe('3.2.4 的检索约束', () => {
  it('四个约束值原样传给仓储', async () => {
    const { repository, queries } = repositoryReturning([candidate()]);
    await retrieveReferences({ repository, embedding }, { normalized, excludePlanId: 'plan-self' });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      destinationPlaceId: 'cn-hangzhou',
      totalDays: 5,
      minSimilarity: RETRIEVAL_MIN_SIMILARITY,
      limit: RETRIEVAL_LIMIT,
      dayTolerance: RETRIEVAL_DAY_TOLERANCE,
      timeoutMs: RETRIEVAL_TIMEOUT_MS,
      excludePlanId: 'plan-self',
    });
  });

  it('约束值与设计稿一致', () => {
    // 表驱动比对，避免某次调参把 0.75 改成 0.5 而没人注意到 ——
    // 那会让不相关的行程被当作参考塞进上下文
    expect({
      limit: RETRIEVAL_LIMIT,
      minSimilarity: RETRIEVAL_MIN_SIMILARITY,
      dayTolerance: RETRIEVAL_DAY_TOLERANCE,
      timeoutMs: RETRIEVAL_TIMEOUT_MS,
    }).toEqual({ limit: 5, minSimilarity: 0.75, dayTolerance: 3, timeoutMs: 1_500 });
  });

  it('查询向量由请求文本计算，且与投影侧同一个空间', async () => {
    const { repository, queries } = repositoryReturning([]);
    await retrieveReferences({ repository, embedding }, { normalized });

    const [expected] = await embedding.embed([normalizedRequestToEmbeddingText(normalized)]);
    expect(queries[0]!.embedding).toEqual(expected);
  });

  it('缺 place_id 时不检索', async () => {
    /*
     * 3.2.4 的第一个过滤条件就是「同 place_id」。退化成按名称匹配会把
     * 「杭州」与「杭州市」判为不同城市，把不同省的同名地点（朝阳）判为同一个
     * —— 后者意味着把辽宁朝阳的行程当作北京朝阳的参考。宁可无参考。
     */
    const noPlaceId = makeValidContext({
      trip: {
        origin: { text: '上海' },
        destination: { mode: 'FIXED', text: '某小镇', allow_multiple_destinations: false },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      },
    }).normalized;

    const { repository, queries } = repositoryReturning([candidate()]);
    const result = await retrieveReferences({ repository, embedding }, { normalized: noPlaceId });

    expect(queries).toEqual([]);
    expect(result.outcome).toBe('miss');
  });
});

describe('TP-2-24：无参考时继续生成', () => {
  it('空库返回 miss 且带「无历史参考」假设', async () => {
    // 空库首次生成必须成功，否则系统上线第一天就不可用
    const { repository } = repositoryReturning([]);
    const result = await retrieveReferences({ repository, embedding }, { normalized });

    expect(result.outcome).toBe('miss');
    expect(result.references).toEqual([]);
    expect(result.assumptions).toEqual([NO_REFERENCE_ASSUMPTION]);
  });

  it('超时按无参考继续，不抛错', async () => {
    const repository = {
      findSimilar: () => Promise.reject(new RetrievalTimeoutError(1_500)),
    };
    const result = await retrieveReferences({ repository, embedding }, { normalized });

    expect(result.outcome).toBe('timeout');
    expect(result.assumptions).toEqual([NO_REFERENCE_ASSUMPTION]);
  });

  it('非超时错误往上抛，不被当成无参考吞掉', async () => {
    /*
     * 列权限被拒（隔离配置有问题）若被当成「无参考」静默处理，
     * 一个配置事故就会表现为「检索效果不好」，可能几个月都没人发现。
     */
    const repository = {
      findSimilar: () => Promise.reject(new Error('permission denied for column plan_json')),
    };
    await expect(retrieveReferences({ repository, embedding }, { normalized })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('命中时不带假设', async () => {
    const { repository } = repositoryReturning([candidate()]);
    const result = await retrieveReferences({ repository, embedding }, { normalized });

    expect(result.outcome).toBe('hit');
    expect(result.assumptions).toEqual([]);
    expect(result.references).toHaveLength(1);
  });
});

describe('投影形状校验', () => {
  it('形状不符的候选被跳过', async () => {
    /*
     * 库里可能有投影规则修订之前写入的行。把形状未知的 JSON 塞进 LLM
     * 上下文，意味着它里面可能带着旧规则漏掉的敏感字段。
     */
    const { repository } = repositoryReturning([
      candidate({ id: 'ok' }),
      candidate({ id: 'legacy', projection: { schema_version: 'retrieval_projection_v0' } }),
    ]);

    const result = await retrieveReferences({ repository, embedding }, { normalized });
    expect(result.references).toHaveLength(1);
  });

  it('全部候选都形状不符时退化为 miss', async () => {
    const { repository } = repositoryReturning([candidate({ projection: { bad: true } })]);
    const result = await retrieveReferences({ repository, embedding }, { normalized });

    expect(result.outcome).toBe('miss');
    expect(result.assumptions).toEqual([NO_REFERENCE_ASSUMPTION]);
  });

  it('参考内容里不含金额与日期', async () => {
    const { repository } = repositoryReturning([candidate()]);
    const result = await retrieveReferences({ repository, embedding }, { normalized });

    const serialized = JSON.stringify(result.references);
    const plan = makeValidPlan();
    expect(serialized).not.toContain(plan.start_date);
    expect(serialized).not.toContain(String(plan.total_budget.total));
  });
});

describe('TP-2-25：指标', () => {
  it('命中、未命中、超时三态都有打点', async () => {
    const hit = repositoryReturning([candidate({ source: 'versions' })]);
    await retrieveReferences({ repository: hit.repository, embedding }, { normalized });

    const empty = repositoryReturning([]);
    await retrieveReferences({ repository: empty.repository, embedding }, { normalized });

    await retrieveReferences(
      {
        repository: { findSimilar: () => Promise.reject(new RetrievalTimeoutError(1_500)) },
        embedding,
      },
      { normalized },
    );

    const text = await metricsText();
    expect(text).toContain('travel_retrieval_reference_total{outcome="hit",source="versions"}');
    expect(text).toContain('travel_retrieval_reference_total{outcome="miss",source="knowledge"}');
    expect(text).toContain('travel_retrieval_reference_total{outcome="timeout",source="versions"}');
  });

  it('按来源分别记，知识库是否被用到可见', async () => {
    // 合成一个整体 outcome 的话，plan_knowledge 完全没被检索到也看不出来
    const { repository } = repositoryReturning([candidate({ source: 'knowledge', planId: null })]);
    await retrieveReferences({ repository, embedding }, { normalized });

    const text = await metricsText();
    expect(text).toContain('travel_retrieval_reference_total{outcome="hit",source="knowledge"}');
  });
});
