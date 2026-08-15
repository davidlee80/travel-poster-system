import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPool } from './pool.js';
import {
  createRetrievalRepository,
  type RetrievalQuery,
  type RetrievalRepository,
} from './retrieval.js';

/**
 * 全局历史检索（TP-2-22、TP-2-23，需真实 PostgreSQL）。
 *
 * 覆盖两道门禁：
 *   #26  匿名 A 的杭州计划能被注册 B 的生成检索命中（跨用户、跨身份）
 *   #28  用 `travel_retrieval_ro` 执行 `SELECT plan_json` 被数据库拒绝，
 *        且检索**实际需要的七列都能读**
 *
 * 第二条的「两个方向都要测」是 15.2 明确要求的。只测「读不到 plan_json」
 * 是不够的：授权太少会让检索路径跑不起来，而那时最省事的修法是给它整表
 * `SELECT` —— 隔离就没了。两个方向都锁住，收紧与放松都必须是显式改动。
 *
 * 运行：`DATABASE_URL=postgres://... pnpm test:integration`
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

/** 15.2 授予的七列，一列不多一列不少 */
const GRANTED_COLUMNS = [
  'id',
  'plan_id',
  'status',
  'destination_place_id',
  'total_days',
  'retrieval_projection',
  'plan_embedding',
] as const;

const DIMENSIONS = 1536;

/**
 * 构造单位向量：只在指定下标上取值，整体归一化。
 *
 * 手工构造而不是用 `@tps/llm` 的哈希向量器：这里要验证的是**阈值筛选**，
 * 需要精确已知的余弦值。用真实向量器的话余弦是个「大概 0.8」的数，
 * 测「0.75 阈值」就变成了测运气。
 */
function unitVector(entries: readonly (readonly [number, number])[]): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const [index, value] of entries) vector[index] = value;
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  return vector.map((v) => v / norm);
}

/** 与查询向量余弦分别为 1.0 / 0.8 / 0.5 */
const QUERY_VECTOR = unitVector([[0, 1]]);
const IDENTICAL = unitVector([[0, 1]]);
const SIMILAR = unitVector([
  [0, 0.8],
  [1, 0.6],
]);
const DISTANT = unitVector([
  [0, 0.5],
  [1, 0.866_025_403_784_438_6],
]);

function literal(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

const PROJECTION = {
  schema_version: 'retrieval_projection_v1',
  destination: { name: '杭州', place_id: 'cn-hangzhou' },
  total_days: 5,
  days: [
    {
      theme: '运河人文',
      subtitle: '',
      schedule: [
        {
          title: '拱宸桥与大运河博物馆',
          period: 'MORNING',
          duration_minutes: 150,
          description: '参观运河沿岸建筑与专题展。',
          location: { name: '拱宸桥', place_id: 'hz-gongchen-bridge' },
        },
      ],
      food_recommendations: [{ name: '片儿川', entity_type: 'DISH' }],
      route_recommendations: [{ nodes: ['拱宸桥', '大兜路'] }],
    },
  ],
};

describeIntegration('全局历史检索（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repository: RetrievalRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    repository = createRetrievalRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM plan_knowledge');
  });

  // ── 夹具 ──────────────────────────────────────────────────

  /**
   * 两种身份分开写 INSERT，而不是用一条带 CASE 的语句。
   *
   * `users` 上有两组互斥的 CHECK（匿名必须有 `anon_token_hash` 与过期时间、
   * 注册必须有邮箱与口令哈希，见 0002 迁移），一条语句里塞 CASE 只会让
   * 「哪些列该有值」变得难读，而这正是那些 CHECK 想说清的事。
   */
  async function insertUser(type: 'ANONYMOUS' | 'REGISTERED'): Promise<string> {
    const sql =
      type === 'ANONYMOUS'
        ? `INSERT INTO users (
             user_type, status, anon_token_hash, anon_expires_at,
             daily_plan_quota, monthly_plan_quota)
           VALUES ('ANONYMOUS', 'ACTIVE',
                   md5(random()::text) || md5(random()::text),
                   NOW() + INTERVAL '30 days', 5, 10)
           RETURNING id`
        : `INSERT INTO users (
             user_type, status, email, password_hash,
             daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', 'ACTIVE',
                   md5(random()::text) || '@example.com', 'argon2-placeholder', 5, 20)
           RETURNING id`;

    const { rows } = await pool.query<{ id: string }>(sql);
    return rows[0]!.id;
  }

  interface VersionOptions {
    readonly userType: 'ANONYMOUS' | 'REGISTERED';
    readonly placeId?: string;
    readonly totalDays?: number;
    readonly status?: 'READY' | 'REPAIRED' | 'REJECTED';
    readonly embedding?: readonly number[];
    /** 只存在于 plan_json 的敏感内容，用于验证它不可能被检索读到 */
    readonly secret?: string;
  }

  async function insertVersion(
    options: VersionOptions,
  ): Promise<{ planId: string; versionId: string }> {
    const {
      userType,
      placeId = 'cn-hangzhou',
      totalDays = 5,
      status = 'READY',
      embedding = IDENTICAL,
      secret = '预算 30000 元',
    } = options;

    const userId = await insertUser(userType);
    const { rows: requestRows } = await pool.query<{ id: string }>(
      `INSERT INTO travel_requests (
         user_id, client_request_id, idempotency_key, raw_request, normalized_request,
         destination_name, destination_place_id, start_date, end_date, total_days, traveler_count)
       VALUES ($1, 'req-1', md5(random()::text) || md5(random()::text), '{}', '{}',
               '杭州', $2, DATE '2026-04-01', DATE '2026-04-01' + ($3::int - 1), $3, 2)
       RETURNING id`,
      [userId, placeId, totalDays],
    );
    const requestId = requestRows[0]!.id;

    /*
     * `travel_plans` 上**没有** destination_place_id ——
     * 它只在 travel_requests 与（按 R-17 冗余的）travel_plan_versions 上。
     * 这正是 15.2 隔离设计成立的前提：检索角色读不到 travel_plans，
     * 所需的两个过滤维度必须冗余到版本表。
     */
    const { rows: planRows } = await pool.query<{ id: string }>(
      `INSERT INTO travel_plans (
         user_id, request_id, status, destination_name, start_date, total_days)
       VALUES ($1, $2, 'READY', '杭州', DATE '2026-04-01', $3)
       RETURNING id`,
      [userId, requestId, totalDays],
    );
    const planId = planRows[0]!.id;

    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO travel_plan_versions (
         plan_id, version_number, status, plan_json, retrieval_projection,
         destination_place_id, total_days, plan_embedding)
       VALUES ($1, 1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::vector)
       RETURNING id`,
      [
        planId,
        status,
        JSON.stringify({ secret, summary: secret }),
        JSON.stringify(PROJECTION),
        placeId,
        totalDays,
        literal(embedding),
      ],
    );

    return { planId, versionId: versionRows[0]!.id };
  }

  const query = (overrides: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
    embedding: QUERY_VECTOR,
    destinationPlaceId: 'cn-hangzhou',
    totalDays: 5,
    minSimilarity: 0.75,
    limit: 5,
    dayTolerance: 3,
    timeoutMs: 1_500,
    ...overrides,
  });

  // ── 门禁 #28：列级 GRANT ──────────────────────────────────

  describe('门禁 #28：列级 GRANT 是最后一道防线', () => {
    it('用 travel_retrieval_ro 读 plan_json 被数据库拒绝', async () => {
      await insertVersion({ userType: 'ANONYMOUS' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE travel_retrieval_ro');
        await expect(
          client.query('SELECT plan_json FROM travel_plan_versions LIMIT 1'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it.each([...GRANTED_COLUMNS])('用 travel_retrieval_ro 能读 %s', async (column) => {
      /*
       * 反方向。授权太少会让检索跑不起来，而那时最省事的修法是给整表
       * SELECT —— 隔离就没了。两个方向都测住，收紧与放松都得是显式改动。
       */
      await insertVersion({ userType: 'ANONYMOUS' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE travel_retrieval_ro');
        const result = await client.query(`SELECT ${column} FROM travel_plan_versions LIMIT 1`);
        expect(result.rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it.each(['constraint_report', 'llm_model', 'input_tokens'])(
      '未授予的列 %s 同样被拒绝',
      async (column) => {
        await insertVersion({ userType: 'ANONYMOUS' });

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE travel_retrieval_ro');
          await expect(
            client.query(`SELECT ${column} FROM travel_plan_versions LIMIT 1`),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
    );

    it('travel_plans 整表不可读（否则会读到 user_id）', async () => {
      /*
       * R-17 的理由在这里变成断言：给这个角色 travel_plans 的权限会让它
       * 读到 user_id，隔离本身就失去意义。因此 place_id 与 total_days
       * 必须冗余到版本表上。
       */
      await insertVersion({ userType: 'ANONYMOUS' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE travel_retrieval_ro');
        await expect(
          client.query('SELECT user_id FROM travel_plans LIMIT 1'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  // ── 门禁 #26：跨用户跨身份 ────────────────────────────────

  describe('门禁 #26：跨用户、跨身份', () => {
    it('匿名用户的计划能被注册用户的生成检索命中', async () => {
      const anonymous = await insertVersion({ userType: 'ANONYMOUS' });

      // 注册用户 B 自己也有一个计划，检索时要排除它
      const registered = await insertVersion({ userType: 'REGISTERED' });

      const results = await repository.findSimilar(query({ excludePlanId: registered.planId }));

      expect(results.map((r) => r.id)).toEqual([anonymous.versionId]);
      expect(results[0]!.source).toBe('versions');
      expect(results[0]!.similarity).toBeCloseTo(1, 6);
    });

    it('检索结果里不含 plan_json 的内容', async () => {
      await insertVersion({ userType: 'ANONYMOUS', secret: '联系电话 13800000000' });

      const results = await repository.findSimilar(query());
      expect(JSON.stringify(results)).not.toContain('13800000000');
    });

    it('排除自身计划的全部版本', async () => {
      const own = await insertVersion({ userType: 'REGISTERED' });
      await pool.query(
        `INSERT INTO travel_plan_versions (
           plan_id, version_number, status, plan_json, retrieval_projection,
           destination_place_id, total_days, plan_embedding)
         VALUES ($1, 2, 'REPAIRED', '{}'::jsonb, $2::jsonb, 'cn-hangzhou', 5, $3::vector)`,
        [own.planId, JSON.stringify(PROJECTION), literal(IDENTICAL)],
      );

      const results = await repository.findSimilar(query({ excludePlanId: own.planId }));
      expect(results).toEqual([]);
    });
  });

  // ── 3.2.4 的过滤条件 ──────────────────────────────────────

  describe('3.2.4 过滤条件', () => {
    it('REJECTED 版本不参与检索（验收标准 15）', async () => {
      // 校验没通过的内容参与检索，等于把错误的安排推荐给后来的用户
      await insertVersion({ userType: 'ANONYMOUS', status: 'REJECTED' });
      expect(await repository.findSimilar(query())).toEqual([]);
    });

    it('REPAIRED 版本参与检索', async () => {
      const repaired = await insertVersion({ userType: 'ANONYMOUS', status: 'REPAIRED' });
      const results = await repository.findSimilar(query());
      expect(results.map((r) => r.id)).toEqual([repaired.versionId]);
    });

    it('不同 place_id 不召回', async () => {
      await insertVersion({ userType: 'ANONYMOUS', placeId: 'cn-suzhou' });
      expect(await repository.findSimilar(query())).toEqual([]);
    });

    // 5±3 是**闭区间**，因此越界的是 1 天与 9 天，不是 2 天与 8 天
    it.each([1, 9])('天数超出 ±3 天（%i 天）不召回', async (totalDays) => {
      await insertVersion({ userType: 'ANONYMOUS', totalDays });
      expect(await repository.findSimilar(query())).toEqual([]);
    });

    it.each([2, 5, 8])('天数在 ±3 天边界内（%i 天）召回', async (totalDays) => {
      const version = await insertVersion({ userType: 'ANONYMOUS', totalDays });
      const results = await repository.findSimilar(query({ totalDays: 5, dayTolerance: 3 }));
      // 2 与 8 都恰好在 5±3 的闭区间内
      expect(results.map((r) => r.id)).toEqual([version.versionId]);
    });

    it('余弦低于 0.75 不召回，等于 0.8 召回', async () => {
      const similar = await insertVersion({ userType: 'ANONYMOUS', embedding: SIMILAR });
      await insertVersion({ userType: 'ANONYMOUS', embedding: DISTANT });

      const results = await repository.findSimilar(query());
      expect(results.map((r) => r.id)).toEqual([similar.versionId]);
      expect(results[0]!.similarity).toBeCloseTo(0.8, 6);
    });

    it('没有向量的版本不召回', async () => {
      // plan_embedding 可空（写入是两步）；把 NULL 当成距离 0 会让
      // 未向量化的计划排在最前面
      const { planId } = await insertVersion({ userType: 'ANONYMOUS' });
      await pool.query('UPDATE travel_plan_versions SET plan_embedding = NULL WHERE plan_id = $1', [
        planId,
      ]);
      expect(await repository.findSimilar(query())).toEqual([]);
    });

    it('Top N 是跨来源的总数', async () => {
      for (let i = 0; i < 3; i += 1) {
        await insertVersion({ userType: 'ANONYMOUS' });
      }
      await pool.query(
        `INSERT INTO plan_knowledge (destination_place_id, total_days, projection, embedding, source_status)
         VALUES ('cn-hangzhou', 5, $1::jsonb, $2::vector, 'READY'),
                ('cn-hangzhou', 4, $1::jsonb, $2::vector, 'REPAIRED')`,
        [JSON.stringify(PROJECTION), literal(IDENTICAL)],
      );

      const results = await repository.findSimilar(query({ limit: 4 }));
      expect(results).toHaveLength(4);
    });

    it('plan_knowledge 也是检索来源', async () => {
      await pool.query(
        `INSERT INTO plan_knowledge (destination_place_id, total_days, projection, embedding, source_status)
         VALUES ('cn-hangzhou', 5, $1::jsonb, $2::vector, 'READY')`,
        [JSON.stringify(PROJECTION), literal(IDENTICAL)],
      );

      const results = await repository.findSimilar(query());
      expect(results).toHaveLength(1);
      expect(results[0]!.source).toBe('knowledge');
      expect(results[0]!.planId).toBeNull();
    });

    it('空库返回空数组而不是抛错（TP-2-24 的前提）', async () => {
      expect(await repository.findSimilar(query())).toEqual([]);
    });
  });
});
