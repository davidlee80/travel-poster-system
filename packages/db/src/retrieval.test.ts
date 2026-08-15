import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  RetrievalTimeoutError,
  createRetrievalRepository,
  type RetrievalQuery,
} from './retrieval.js';

/**
 * 检索仓储的**语句层**单测（TP-2-22、TP-2-23）。
 *
 * ## 为什么这些断言不能只靠集成测试
 *
 * 集成测试能证明「`travel_retrieval_ro` 读不到 `plan_json`」，但证明不了
 * 「检索**用了**这个角色」—— 应用角色本来就能读 `plan_json`，而检索语句
 * 并不 SELECT 它。也就是说：把 `SET LOCAL ROLE` 那一行删掉，
 * 全部集成测试依然通过，隔离却已经没了。
 *
 * 因此这里直接断言发出的语句序列。这是唯一能守住第 2 道防线**被启用**的测试。
 */

interface Recorded {
  readonly text: string;
  readonly values?: readonly unknown[];
}

interface FakeOptions {
  readonly versionRows?: readonly Record<string, unknown>[];
  readonly knowledgeRows?: readonly Record<string, unknown>[];
  readonly failSelectWith?: { readonly code?: string; readonly message?: string };
}

function fakePool(options: FakeOptions = {}): {
  pool: Pool;
  log: Recorded[];
  released: () => number;
} {
  const log: Recorded[] = [];
  let releases = 0;
  let selectCount = 0;

  const client = {
    query: (text: string, values?: readonly unknown[]) => {
      log.push(values === undefined ? { text } : { text, values });

      if (!text.trimStart().toUpperCase().startsWith('SELECT')) {
        return Promise.resolve({ rows: [] });
      }

      if (options.failSelectWith !== undefined) {
        const error = Object.assign(new Error(options.failSelectWith.message ?? '失败'), {
          code: options.failSelectWith.code,
        });
        return Promise.reject(error);
      }

      selectCount += 1;
      const rows = selectCount === 1 ? options.versionRows : options.knowledgeRows;
      return Promise.resolve({ rows: rows ?? [] });
    },
    release: () => {
      releases += 1;
    },
  } as unknown as PoolClient;

  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, log, released: () => releases };
}

const query: RetrievalQuery = {
  embedding: [0.5, 0.5],
  destinationPlaceId: 'cn-hangzhou',
  totalDays: 5,
  minSimilarity: 0.75,
  limit: 5,
  dayTolerance: 3,
  timeoutMs: 1_500,
};

describe('隔离与超时的语句', () => {
  it('在事务内切到 travel_retrieval_ro 再查询', async () => {
    const { pool, log } = fakePool();
    await createRetrievalRepository(pool).findSimilar(query);

    /*
     * 两条 SET 都必须带 LOCAL：不带的话受限角色与短超时会留在连接上，
     * 池里的下一个调用方（可能是写入路径）会带着 travel_retrieval_ro 去
     * INSERT —— 表现为随机的「permission denied」，且只在高并发下出现。
     */
    const texts = log.map((entry) => entry.text.trim());
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toBe('SET LOCAL ROLE travel_retrieval_ro');
    expect(texts[2]).toBe('SET LOCAL statement_timeout = 1500');
    expect(texts[3]?.startsWith('SELECT')).toBe(true);
    expect(texts.at(-1)).toBe('COMMIT');
  });

  it('查询语句不含 plan_json', async () => {
    const { pool, log } = fakePool();
    await createRetrievalRepository(pool).findSimilar(query);

    for (const entry of log) {
      expect(entry.text).not.toContain('plan_json');
      expect(entry.text).not.toContain('constraint_report');
      expect(entry.text).not.toContain('user_id');
    }
  });

  it('过滤条件写成距离形式，能走 HNSW 索引', async () => {
    /*
     * 写成 `1 - (a <=> b) >= x` 会让 ORDER BY 用不上 HNSW 索引，
     * 退化为全表扫描。1.5 秒上限下的表现是「库一大就永远超时」，
     * 而症状（总是无参考）看起来像数据不足。
     */
    const { pool, log } = fakePool();
    await createRetrievalRepository(pool).findSimilar(query);

    const select = log.find((entry) => entry.text.includes('travel_plan_versions'))!;
    expect(select.text).toMatch(/ORDER BY plan_embedding <=> \$1::vector/);
    expect(select.text).toMatch(/\(plan_embedding <=> \$1::vector\) <= \$6::float8/);
  });

  it('相似度下限换算成距离上限', async () => {
    const { pool, log } = fakePool();
    await createRetrievalRepository(pool).findSimilar({ ...query, minSimilarity: 0.75 });

    const select = log.find((entry) => entry.text.includes('travel_plan_versions'))!;
    expect(select.values?.[5]).toBeCloseTo(0.25, 10);
  });

  it('超时映射为 RetrievalTimeoutError', async () => {
    const { pool } = fakePool({ failSelectWith: { code: '57014' } });
    await expect(createRetrievalRepository(pool).findSimilar(query)).rejects.toBeInstanceOf(
      RetrievalTimeoutError,
    );
  });

  it('其他错误原样抛出，不被当成「无参考」吞掉', async () => {
    /*
     * 3.2.4 只说「超时按无参考继续」。把「列权限被拒」也当成无参考，
     * 会让隔离配置失效表现为「检索效果不好」而不是报错 ——
     * 而那种配置问题必须尽早暴露。
     */
    const { pool } = fakePool({ failSelectWith: { code: '42501', message: '列权限不足' } });
    const promise = createRetrievalRepository(pool).findSimilar(query);
    await expect(promise).rejects.not.toBeInstanceOf(RetrievalTimeoutError);
    await expect(promise).rejects.toThrow(/列权限不足/);
  });

  it('出错时回滚并归还连接', async () => {
    const { pool, log, released } = fakePool({ failSelectWith: { code: '57014' } });
    await createRetrievalRepository(pool)
      .findSimilar(query)
      .catch(() => undefined);

    expect(log.map((e) => e.text)).toContain('ROLLBACK');
    expect(released()).toBe(1);
  });
});

describe('结果合并', () => {
  const versionRow = (id: string, similarity: number | string): Record<string, unknown> => ({
    id,
    plan_id: `plan-${id}`,
    status: 'READY',
    destination_place_id: 'cn-hangzhou',
    total_days: 5,
    retrieval_projection: { days: [] },
    similarity,
  });

  const knowledgeRow = (id: string, similarity: number): Record<string, unknown> => ({
    id,
    source_status: 'REPAIRED',
    destination_place_id: 'cn-hangzhou',
    total_days: 4,
    projection: { days: [] },
    similarity,
  });

  it('两个来源合并后按相似度降序，总数截到 limit', async () => {
    /*
     * 3.2.4 的「Top 5」是**总数**。两个来源各取 5 条不截断的话，
     * 一次检索会往 LLM 上下文里塞 10 份行程 —— token 直接翻倍，
     * 而 6.3 的 max_tokens 分档是按「计划 + 少量参考」估的。
     */
    const { pool } = fakePool({
      versionRows: [versionRow('v1', 0.95), versionRow('v2', 0.8)],
      knowledgeRows: [knowledgeRow('k1', 0.9), knowledgeRow('k2', 0.76)],
    });

    const result = await createRetrievalRepository(pool).findSimilar({ ...query, limit: 3 });
    expect(result.map((c) => c.id)).toEqual(['v1', 'k1', 'v2']);
    expect(result.map((c) => c.source)).toEqual(['versions', 'knowledge', 'versions']);
  });

  it('knowledge 来源没有 planId', async () => {
    // plan_knowledge 是原计划被保留期清理后沉淀的知识，已无对应计划
    const { pool } = fakePool({ knowledgeRows: [knowledgeRow('k1', 0.9)] });
    const result = await createRetrievalRepository(pool).findSimilar(query);
    expect(result[0]!.planId).toBeNull();
  });

  it('相似度以字符串返回时也转成数字', async () => {
    /*
     * pg 把 float8 作为字符串返回是常见的配置差异（取决于 pg-types 的解析器
     * 是否被覆盖）。这里**真的传字符串**：传数字的话这条用例什么都没验证，
     * 而它要防的正是「排序变成字典序，'0.9' 排在 '0.85' 之后」。
     */
    const { pool } = fakePool({
      versionRows: [versionRow('v1', '0.85'), versionRow('v2', '0.9')],
    });
    const rows = await createRetrievalRepository(pool).findSimilar(query);
    expect(typeof rows[0]!.similarity).toBe('number');
    expect(rows.map((r) => r.id)).toEqual(['v2', 'v1']);
  });

  it('候选类型里没有 plan_json 字段（编译期第 1 道防线）', async () => {
    const { pool } = fakePool({ versionRows: [versionRow('v1', 0.95)] });
    const [candidate] = await createRetrievalRepository(pool).findSimilar(query);

    // @ts-expect-error RetrievalCandidate 刻意不含 plan_json —— 误用是编译错误
    const leaked: unknown = candidate?.plan_json;
    expect(leaked).toBeUndefined();
  });
});
