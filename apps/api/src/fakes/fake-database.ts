import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Fake 数据库连接池实现。
 *
 * 用于测试：模拟数据库连接/查询的延迟/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **延迟模拟**：`connectionDelayMs` 模拟建连慢，`queryDelayMs` 模拟查询慢；
 * - **故障模拟**：`connectionError` 模拟连接失败，`queryError` 模拟查询失败；
 * - **查询编排**：`byQuery` 按 SQL 文本匹配编排特定查询的行为。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/db/src/pool.ts`）会：
 * 1. 建立 TCP 连接到 PostgreSQL；
 * 2. 执行 SQL 并返回结果；
 * 3. 管理连接池（max、idleTimeout、statement_timeout）。
 *
 * Fake 实现**不执行**这些操作，只返回预置的结果或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖数据库状态，不依赖网络。
 */
export interface FakeDatabaseBehavior {
  /** 建连延迟毫秒数 */
  readonly connectionDelayMs?: number;
  /** 查询延迟毫秒数 */
  readonly queryDelayMs?: number;
  /** 建连故障 */
  readonly connectionError?: Error;
  /** 查询故障 */
  readonly queryError?: Error;
  /** 按 SQL 文本编排特定查询的行为 */
  readonly byQuery?: Record<string, FakeQueryBehavior>;
}

export interface FakeQueryBehavior {
  /** 查询结果 */
  readonly result?: QueryResult;
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 故障 */
  readonly error?: Error;
}

/**
 * 包装 `Pool`，注入编排行为。
 */
export function wrapDatabase(pool: Pool, behavior: FakeDatabaseBehavior): Pool {
  return {
    ...pool,
    connect: async (): Promise<PoolClient> => {
      if (behavior.connectionError) {
        throw behavior.connectionError;
      }

      if (behavior.connectionDelayMs !== undefined && behavior.connectionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.connectionDelayMs));
      }

      return pool.connect();
    },
    query: async <T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<T>> => {
      if (behavior.queryError) {
        throw behavior.queryError;
      }

      if (behavior.queryDelayMs !== undefined && behavior.queryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.queryDelayMs));
      }

      // 按 SQL 文本编排特定查询
      const queryBehavior = behavior.byQuery?.[text];
      if (queryBehavior !== undefined) {
        if (queryBehavior.error) {
          throw queryBehavior.error;
        }
        if (queryBehavior.delayMs !== undefined && queryBehavior.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, queryBehavior.delayMs));
        }
        if (queryBehavior.result !== undefined) {
          return queryBehavior.result as QueryResult<T>;
        }
      }

      return pool.query<T>(text, values);
    },
  } as Pool;
}
