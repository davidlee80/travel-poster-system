import type { Pool } from 'pg';

/**
 * 全局历史检索仓储（TP-2-22、TP-2-23，设计稿 3.2.4、15.2）。
 *
 * ## 与其他仓储的根本区别：这里**没有 user_id 谓词**
 *
 * 13.0 要求所有业务查询在 SQL 层强制 `WHERE user_id = :current_user_id`。
 * 本模块是**唯一的例外**，而例外是设计要求的：历史计划的价值在于
 * 「杭州运河主题这样安排是可行的」这类可复用的行程知识，锁在单个用户空间里
 * 会让检索几乎永远命中不到东西 —— 对匿名用户尤其如此（首次访问即零历史）。
 *
 * 例外的代价用**三道机制**抵消，缺任何一道这个模块就不该存在：
 *
 *   1. 返回类型里**根本没有 `plan_json` 字段** —— 误用是编译错误；
 *   2. 查询以 `SET LOCAL ROLE travel_retrieval_ro` 执行，该角色只有
 *      七列的列级 `SELECT`，读 `plan_json` 会被**数据库**拒绝（15.2、门禁 #28）；
 *   3. 结果只进 LLM 上下文，绝不出现在任何 API 响应里（二十章 L2、TP-2-30）。
 *
 * 第 2 道是最后防线，因为它不依赖任何人写对代码。
 */

/** 3.2.4：检索来源。plan_knowledge 是匿名数据清理后沉淀的脱敏知识（15.1） */
export type RetrievalSource = 'versions' | 'knowledge';

/**
 * 一条检索候选。
 *
 * **刻意不含 `plan_json` / `constraint_report` / `user_id` / 日期 / 金额。**
 * 想给这个接口加字段前先看 3.2.4 的表格 —— 它约束的是「什么能跨用户流动」，
 * 不是「什么方便实现」。
 */
export interface RetrievalCandidate {
  /** `travel_plan_versions.id` 或 `plan_knowledge.id` */
  readonly id: string;
  /** knowledge 来源没有对应计划（原计划已按保留期清理） */
  readonly planId: string | null;
  readonly status: 'READY' | 'REPAIRED';
  readonly destinationPlaceId: string | null;
  readonly totalDays: number;
  /** 脱敏投影。形状由调用方用 `parseRetrievalProjection` 校验后再使用 */
  readonly projection: unknown;
  /** 余弦相似度，1 为完全一致 */
  readonly similarity: number;
  readonly source: RetrievalSource;
}

export interface RetrievalQuery {
  /** 由 `retrieval_projection` 计算的查询向量（15.2） */
  readonly embedding: readonly number[];
  /** 3.2.4：同 `destination.place_id` */
  readonly destinationPlaceId: string;
  /** 3.2.4：`total_days` 在 ±`dayTolerance` 内 */
  readonly totalDays: number;
  /** 3.2.4：排除本次请求自身产生的版本。按 `plan_id` 排除，历史版本也一并排除 */
  readonly excludePlanId?: string;
  readonly minSimilarity: number;
  readonly limit: number;
  readonly dayTolerance: number;
  /** 3.2.4：耗时上限 1.5 秒，超时按无参考继续 */
  readonly timeoutMs: number;
}

/**
 * 查询被数据库取消（`statement_timeout`）。
 *
 * 单独一个错误类型而不是让调用方匹配错误消息：3.2.4 要求「超时按无参考
 * 继续」，而其他错误（列权限被拒、连接断开）**不能**被当成「无参考」
 * 静默吞掉 —— 那会让隔离配置失效表现为「检索效果不好」，而不是报错。
 */
export class RetrievalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`历史检索超过 ${timeoutMs} 毫秒上限`);
    this.name = 'RetrievalTimeoutError';
  }
}

export interface RetrievalRepository {
  findSimilar(query: RetrievalQuery): Promise<readonly RetrievalCandidate[]>;
}

/** PostgreSQL 的 query_canceled */
const QUERY_CANCELED = '57014';

interface VersionRow {
  readonly id: string;
  readonly plan_id: string;
  readonly status: 'READY' | 'REPAIRED';
  readonly destination_place_id: string | null;
  readonly total_days: number;
  readonly retrieval_projection: unknown;
  readonly similarity: string | number;
}

interface KnowledgeRow {
  readonly id: string;
  readonly source_status: 'READY' | 'REPAIRED';
  readonly destination_place_id: string;
  readonly total_days: number;
  readonly projection: unknown;
  readonly similarity: string | number;
}

/**
 * pgvector 的 `<=>` 是余弦**距离**，`similarity = 1 - distance`。
 *
 * 过滤条件写成距离形式（`<= 1 - minSimilarity`）而不是相似度形式：
 * 只有距离表达式能配合 `ORDER BY ... LIMIT` 走 HNSW 索引，
 * 写成 `1 - (a <=> b) >= x` 会退化成全表扫描 —— 在 1.5 秒上限下
 * 那意味着库一大就永远超时，而症状是「检索总是无参考」。
 */
const VERSIONS_SQL = `
  SELECT id, plan_id, status, destination_place_id, total_days, retrieval_projection,
         1 - (plan_embedding <=> $1::vector) AS similarity
    FROM travel_plan_versions
   WHERE destination_place_id = $2
     AND status IN ('READY', 'REPAIRED')
     AND total_days BETWEEN $3::int - $4::int AND $3::int + $4::int
     AND plan_embedding IS NOT NULL
     AND ($5::uuid IS NULL OR plan_id <> $5::uuid)
     AND (plan_embedding <=> $1::vector) <= $6::float8
   ORDER BY plan_embedding <=> $1::vector
   LIMIT $7::int`;

const KNOWLEDGE_SQL = `
  SELECT id, source_status, destination_place_id, total_days, projection,
         1 - (embedding <=> $1::vector) AS similarity
    FROM plan_knowledge
   WHERE destination_place_id = $2
     AND total_days BETWEEN $3::int - $4::int AND $3::int + $4::int
     AND (embedding <=> $1::vector) <= $5::float8
   ORDER BY embedding <=> $1::vector
   LIMIT $6::int`;

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export function createRetrievalRepository(pool: Pool): RetrievalRepository {
  return {
    async findSimilar(query) {
      const vector = `[${query.embedding.join(',')}]`;
      const maxDistance = 1 - query.minSimilarity;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        /*
         * 两条 SET LOCAL 都必须在事务里：事务结束后自动还原，
         * 池里的连接不会带着受限角色或短超时被下一个调用方拿到。
         *
         * 角色名是代码里的常量，不来自输入，因此可以直接拼进语句
         * （SET ROLE 不接受参数占位符）。
         */
        await client.query('SET LOCAL ROLE travel_retrieval_ro');
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, query.timeoutMs)}`);

        const versions = await client.query<VersionRow>(VERSIONS_SQL, [
          vector,
          query.destinationPlaceId,
          query.totalDays,
          query.dayTolerance,
          query.excludePlanId ?? null,
          maxDistance,
          query.limit,
        ]);

        const knowledge = await client.query<KnowledgeRow>(KNOWLEDGE_SQL, [
          vector,
          query.destinationPlaceId,
          query.totalDays,
          query.dayTolerance,
          maxDistance,
          query.limit,
        ]);

        await client.query('COMMIT');

        const candidates: RetrievalCandidate[] = [
          ...versions.rows.map((row) => ({
            id: row.id,
            planId: row.plan_id,
            status: row.status,
            destinationPlaceId: row.destination_place_id,
            totalDays: row.total_days,
            projection: row.retrieval_projection,
            similarity: toNumber(row.similarity),
            source: 'versions' as const,
          })),
          ...knowledge.rows.map((row) => ({
            id: row.id,
            planId: null,
            status: row.source_status,
            destinationPlaceId: row.destination_place_id,
            totalDays: row.total_days,
            projection: row.projection,
            similarity: toNumber(row.similarity),
            source: 'knowledge' as const,
          })),
        ];

        /*
         * 两个来源各取 limit 条后合并再截断到 limit ——
         * 3.2.4 的「Top 5」是**总数**，不是每个来源 5 条。
         * 各取 5 条不截断的话，一次检索会往 LLM 上下文里塞 10 份行程。
         */
        candidates.sort((a, b) => b.similarity - a.similarity);
        return candidates.slice(0, query.limit);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: string }).code === QUERY_CANCELED
        ) {
          throw new RetrievalTimeoutError(query.timeoutMs);
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
