import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';

/**
 * 业务主干表的集成测试（TP-2-01、TP-2-02，需真实 PostgreSQL）。
 *
 * 覆盖的都是**只有数据库才能验证**的东西：级联行为、延迟外键、触发器、
 * 列级 GRANT。这些是 15.3 保留期清理、验收标准 15、门禁 #28 的实现基础，
 * 全部无法用单测替代。
 *
 * 运行：`DATABASE_URL=postgres://... pnpm test:integration`
 * 未设 DATABASE_URL 时整体跳过。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('业务主干表（集成，需 PostgreSQL）', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // users 的级联会带走全部业务行，因此只删这一张即可
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM plan_knowledge');
  });

  // ── 测试夹具 ──────────────────────────────────────────────

  async function insertUser(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      /*
       * daily/monthly_plan_quota 是 NOT NULL 且**无数据库默认值** ——
       * 21.4 的分档由应用在插入时写入（不同 user_type 不同额度），
       * 数据库给默认值反而会掩盖「忘了按身份分档」这个错误。
       */
      `INSERT INTO users (
         user_type, status, anon_token_hash, anon_expires_at,
         daily_plan_quota, monthly_plan_quota)
       VALUES ('ANONYMOUS', 'ACTIVE',
               md5(random()::text) || md5(random()::text),
               NOW() + INTERVAL '30 days', 5, 10)
       RETURNING id`,
    );
    return rows[0]!.id;
  }

  async function insertRequest(userId: string, totalDays = 3): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO travel_requests (
         user_id, client_request_id, idempotency_key, raw_request, normalized_request,
         destination_name, destination_place_id, start_date, end_date, total_days, traveler_count)
       VALUES ($1, 'req-1', md5(random()::text) || md5(random()::text), '{}', '{}',
               '杭州', 'cn-hangzhou', DATE '2026-04-01',
               DATE '2026-04-01' + ($2::int - 1), $2, 2)
       RETURNING id`,
      [userId, totalDays],
    );
    return rows[0]!.id;
  }

  async function insertPlan(userId: string, requestId: string, totalDays = 3): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO travel_plans (user_id, request_id, destination_name, start_date, total_days)
       VALUES ($1, $2, '杭州', DATE '2026-04-01', $3)
       RETURNING id`,
      [userId, requestId, totalDays],
    );
    return rows[0]!.id;
  }

  async function insertVersion(
    planId: string,
    status: 'READY' | 'REPAIRED' | 'REJECTED',
    versionNumber = 1,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO travel_plan_versions (
         plan_id, version_number, status, plan_json, retrieval_projection,
         destination_place_id, total_days)
       VALUES ($1, $2, $3, '{"days":[]}', '{"theme":"canal_culture"}', 'cn-hangzhou', 3)
       RETURNING id`,
      [planId, versionNumber, status],
    );
    return rows[0]!.id;
  }

  // ── 15.3 级联删除 ─────────────────────────────────────────

  describe('15.3 级联删除', () => {
    it('删除 users 行带走全部关联业务行', async () => {
      /*
       * 15.1 的保留期清理**依赖**级联。缺一条外键的 CASCADE，清理任务会在
       * 删 users 行时报外键冲突 —— 而它是后台批处理，报错只留在日志里，
       * 表现是「匿名数据一直没被清掉」，而不是任何显式失败。
       */
      const userId = await insertUser();
      const requestId = await insertRequest(userId);
      const planId = await insertPlan(userId, requestId);
      const versionId = await insertVersion(planId, 'READY');

      await pool.query(
        `INSERT INTO generation_jobs (user_id, request_id, plan_id, plan_version_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, requestId, planId, versionId],
      );
      await pool.query(
        `INSERT INTO exports (user_id, plan_id, plan_version_id, template_id, format, scope, idempotency_key)
         VALUES ($1, $2, $3, 'travel_infographic_v1', 'PNG', 'ALL_DAYS',
                 md5(random()::text) || md5(random()::text))`,
        [userId, planId, versionId],
      );

      await pool.query('DELETE FROM users WHERE id = $1', [userId]);

      for (const table of [
        'travel_requests',
        'travel_plans',
        'travel_plan_versions',
        'generation_jobs',
        'exports',
      ]) {
        const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
        expect(rows[0]!.count, `${table} 未被级联清空`).toBe('0');
      }
    });

    it('删除计划带走其版本', async () => {
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));
      await insertVersion(planId, 'READY');

      await pool.query('DELETE FROM travel_plans WHERE id = $1', [planId]);

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) FROM travel_plan_versions',
      );
      expect(rows[0]!.count).toBe('0');
    });
  });

  // ── current_version_id 的延迟外键与触发器 ─────────────────

  describe('current_version_id 约束', () => {
    it('同事务内互相引用可以写入（延迟外键）', async () => {
      /*
       * 十五章为了避免循环依赖而选择「不加外键，由应用维护」。
       * 那样一来「指向不存在的版本」就成了可能状态，症状是查询计划时
       * join 不到内容、页面空白。延迟外键让循环写入合法而指针依然可靠。
       */
      const userId = await insertUser();
      const requestId = await insertRequest(userId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: planRows } = await client.query<{ id: string }>(
          `INSERT INTO travel_plans (user_id, request_id, destination_name, start_date, total_days)
           VALUES ($1, $2, '杭州', DATE '2026-04-01', 3) RETURNING id`,
          [userId, requestId],
        );
        const planId = planRows[0]!.id;

        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO travel_plan_versions (
             plan_id, version_number, status, plan_json, retrieval_projection,
             destination_place_id, total_days)
           VALUES ($1, 1, 'READY', '{}', '{}', 'cn-hangzhou', 3) RETURNING id`,
          [planId],
        );

        await client.query('UPDATE travel_plans SET current_version_id = $1 WHERE id = $2', [
          versionRows[0]!.id,
          planId,
        ]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await pool.query<{ current_version_id: string | null }>(
        'SELECT current_version_id FROM travel_plans',
      );
      expect(rows[0]!.current_version_id).not.toBeNull();
    });

    it('提交时指向不存在的版本会失败', async () => {
      const userId = await insertUser();
      const requestId = await insertRequest(userId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO travel_plans (
             user_id, request_id, destination_name, start_date, total_days, current_version_id)
           VALUES ($1, $2, '杭州', DATE '2026-04-01', 3, gen_random_uuid())`,
          [userId, requestId],
        );
        // 延迟外键：INSERT 本身通过，违约在 COMMIT 时才暴露
        await expect(client.query('COMMIT')).rejects.toThrow(/foreign key|外键/i);
      } finally {
        client.release();
      }
    });

    it('拒绝把 REJECTED 版本设为 current（验收标准 15）', async () => {
      /*
       * 把校验失败的计划展示给用户是正确性失败，而它**没有任何外部症状**：
       * 用户看到一份完整的计划，只是内容违反业务规则（预算与明细不符、
       * 时间重叠之类）。这类不变式不该靠「只有一个写入方」的纪律保证。
       */
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));
      const rejectedId = await insertVersion(planId, 'REJECTED');

      await expect(
        pool.query('UPDATE travel_plans SET current_version_id = $1 WHERE id = $2', [
          rejectedId,
          planId,
        ]),
      ).rejects.toThrow(/REJECTED/);
    });

    it.each([['READY'], ['REPAIRED']] as const)('允许 %s 版本作为 current', async (status) => {
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));
      const versionId = await insertVersion(planId, status);

      await pool.query('UPDATE travel_plans SET current_version_id = $1 WHERE id = $2', [
        versionId,
        planId,
      ]);

      const { rows } = await pool.query<{ current_version_id: string }>(
        'SELECT current_version_id FROM travel_plans WHERE id = $1',
        [planId],
      );
      expect(rows[0]!.current_version_id).toBe(versionId);
    });

    it('拒绝指向其他计划的版本', async () => {
      // 跨计划指针会让 A 的页面显示 B 的内容 —— 这是跨用户数据泄漏
      const userId = await insertUser();
      const requestId = await insertRequest(userId);
      const planA = await insertPlan(userId, requestId);
      const planB = await insertPlan(userId, requestId);
      const versionOfB = await insertVersion(planB, 'READY');

      await expect(
        pool.query('UPDATE travel_plans SET current_version_id = $1 WHERE id = $2', [
          versionOfB,
          planA,
        ]),
      ).rejects.toThrow(/不属于计划/);
    });
  });

  // ── CHECK 约束的反向测试 ──────────────────────────────────

  describe('CHECK 约束', () => {
    it('total_days 必须与日期区间一致', async () => {
      // 不一致时后续每一步都按不同天数工作，症状离根因很远
      const userId = await insertUser();
      await expect(
        pool.query(
          `INSERT INTO travel_requests (
             user_id, client_request_id, idempotency_key, raw_request, normalized_request,
             destination_name, start_date, end_date, total_days, traveler_count)
           VALUES ($1, 'r', md5(random()::text) || md5(random()::text), '{}', '{}',
                   '杭州', DATE '2026-04-01', DATE '2026-04-05', 3, 2)`,
          [userId],
        ),
      ).rejects.toThrow(/days_match/);
    });

    it('SINGLE_DAY 导出必须且只能带一个天号', async () => {
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));
      const versionId = await insertVersion(planId, 'READY');

      const insertExport = (scope: string, days: number[] | null) =>
        pool.query(
          `INSERT INTO exports (
             user_id, plan_id, plan_version_id, template_id, format, scope, day_numbers, idempotency_key)
           VALUES ($1, $2, $3, 't', 'PNG', $4, $5, md5(random()::text) || md5(random()::text))`,
          [userId, planId, versionId, scope, days],
        );

      /*
       * 第一条是 R-18 的核心：十五章原写法因三值逻辑**恰好漏掉**它 ——
       * NULL OR FALSE 求值为 NULL，而 Postgres 把 NULL 当作满足 CHECK。
       * 单日导出没说哪一天，渲染 Worker 只能失败或静默导出第 1 天。
       */
      await expect(insertExport('SINGLE_DAY', null)).rejects.toThrow(/day_numbers/);
      // 空数组：array_length 同样返回 NULL，因此改用 cardinality
      await expect(insertExport('SINGLE_DAY', [])).rejects.toThrow(/day_numbers/);
      await expect(insertExport('SINGLE_DAY', [1, 2])).rejects.toThrow(/day_numbers/);
      await expect(insertExport('ALL_DAYS', [1])).rejects.toThrow(/day_numbers/);
      await expect(insertExport('FULL_PLAN', [1])).rejects.toThrow(/day_numbers/);
      await expect(insertExport('SINGLE_DAY', [3])).resolves.toBeDefined();
      await expect(insertExport('ALL_DAYS', null)).resolves.toBeDefined();
    });

    it('终态任务必须有 finished_at，非终态必须没有', async () => {
      const userId = await insertUser();
      const requestId = await insertRequest(userId);

      const insertJob = (status: string, finished: boolean, errorCode: string | null) =>
        pool.query(
          `INSERT INTO generation_jobs (user_id, request_id, status, finished_at, error_code)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, requestId, status, finished ? new Date() : null, errorCode],
        );

      await expect(insertJob('COMPLETED', false, null)).rejects.toThrow(/finished_shape/);
      await expect(insertJob('GENERATING_PLAN', true, null)).rejects.toThrow(/finished_shape/);
      await expect(insertJob('COMPLETED', true, null)).resolves.toBeDefined();
    });

    it('FAILED 任务必须带错误码', async () => {
      // 21.3 的失败率按 error_code 分组，缺码的行会整体消失在统计之外
      const userId = await insertUser();
      const requestId = await insertRequest(userId);

      await expect(
        pool.query(
          `INSERT INTO generation_jobs (user_id, request_id, status, finished_at)
           VALUES ($1, $2, 'FAILED', NOW())`,
          [userId, requestId],
        ),
      ).rejects.toThrow(/error_shape/);
    });

    it('拒绝 16.1 状态集之外的状态', async () => {
      const userId = await insertUser();
      const requestId = await insertRequest(userId);

      await expect(
        pool.query(
          `INSERT INTO generation_jobs (user_id, request_id, status) VALUES ($1, $2, 'RENDERING')`,
          [userId, requestId],
        ),
      ).rejects.toThrow(/status_check/);
    });

    it('修复与重生成次数不得超过 3.2.2 的上限', async () => {
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));

      const insertWith = (repair: number, regen: number) =>
        pool.query(
          `INSERT INTO travel_plan_versions (
             plan_id, version_number, status, plan_json, retrieval_projection,
             total_days, repair_iterations, regeneration_count)
           VALUES ($1, $2, 'READY', '{}', '{}', 3, $3, $4)`,
          [planId, repair * 10 + regen + 1, repair, regen],
        );

      await expect(insertWith(4, 0)).rejects.toThrow(/repair_check/);
      await expect(insertWith(0, 3)).rejects.toThrow(/regeneration_check/);
      await expect(insertWith(3, 2)).resolves.toBeDefined();
    });

    it('plan_knowledge 不接受 REJECTED 来源', async () => {
      // 让违反业务规则的安排参与检索，等于把错误推荐给后来的用户
      await expect(
        pool.query(
          `INSERT INTO plan_knowledge (destination_place_id, total_days, projection, embedding, source_status)
           VALUES ('cn-hangzhou', 3, '{}', array_fill(0::real, ARRAY[1536])::vector, 'REJECTED')`,
        ),
      ).rejects.toThrow(/source_status_check/);
    });
  });

  // ── 15.2 列级 GRANT（门禁 #28）─────────────────────────────

  describe('15.2 检索隔离', () => {
    it('travel_retrieval_ro 读不到 plan_json（门禁 #28）', async () => {
      /*
       * 列级 GRANT 是投影隔离的**最后**一道防线：即使应用代码写错，
       * 数据库也会拒绝返回 plan_json。前面还有三层（纯函数投影、
       * 仓储返回类型不含该字段、embedding 由投影计算），
       * 但只有这一层不依赖任何人写对代码。
       */
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));
      await insertVersion(planId, 'READY');

      const client = await pool.connect();
      try {
        await client.query('SET ROLE travel_retrieval_ro');

        await expect(client.query('SELECT plan_json FROM travel_plan_versions')).rejects.toThrow(
          /permission denied/i,
        );
        await expect(
          client.query('SELECT constraint_report FROM travel_plan_versions'),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('travel_retrieval_ro 能读到检索所需的全部列', async () => {
      /*
       * 反向的一半同样重要：授权太少会让检索路径根本跑不起来，
       * 而那时最省事的「修法」是给它 SELECT 全表权限 —— 隔离就没了。
       * 这条断言把「够用」也钉住，让收紧与放松都必须是显式改动。
       */
      const userId = await insertUser();
      const planId = await insertPlan(userId, await insertRequest(userId));
      await insertVersion(planId, 'READY');

      const client = await pool.connect();
      try {
        await client.query('SET ROLE travel_retrieval_ro');

        const { rows } = await client.query(
          `SELECT id, plan_id, status, destination_place_id, total_days,
                  retrieval_projection, plan_embedding
             FROM travel_plan_versions
            WHERE status IN ('READY', 'REPAIRED')`,
        );
        expect(rows).toHaveLength(1);

        await expect(client.query('SELECT * FROM plan_knowledge')).resolves.toBeDefined();
      } finally {
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('travel_retrieval_ro 不能写', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE travel_retrieval_ro');
        await expect(
          client.query(`UPDATE travel_plan_versions SET total_days = 1`),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });
  });

  // ── 索引与向量维度 ────────────────────────────────────────

  describe('索引', () => {
    it('两个 HNSW 余弦索引都存在', async () => {
      // 缺索引时检索仍然「能用」—— 只是全表扫描，1.5 秒上限（3.2.4）
      // 在数据量上来后必然超时，而那时已经在线上了
      const { rows } = await pool.query<{ indexdef: string; indexname: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE indexname IN ('travel_plan_versions_embedding_idx', 'plan_knowledge_embedding_idx')`,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.indexdef, `${row.indexname} 不是 HNSW`).toMatch(/USING hnsw/);
        expect(row.indexdef, `${row.indexname} 不是余弦距离`).toMatch(/vector_cosine_ops/);
      }
    });

    it('向量列维度是 1536', async () => {
      // 维度写错时插入会失败，但错误信息只说「expected N dimensions」，
      // 不会告诉你哪一侧写错了。这里把契约固定下来
      const { rows } = await pool.query<{ dims: number }>(
        `SELECT atttypmod AS dims FROM pg_attribute
          WHERE attrelid = 'travel_plan_versions'::regclass AND attname = 'plan_embedding'`,
      );
      expect(rows[0]!.dims).toBe(1536);
    });

    it('检索索引不含 user_id（3.2.4 跨身份）', async () => {
      /*
       * 全局检索**刻意**不区分注册与匿名用户（R-13）。索引里出现 user_id
       * 说明有人把检索改成了按用户过滤 —— 那会让匿名用户的行程知识
       * 无法被复用，而这正是 plan_knowledge 存在的理由。
       */
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE indexname = 'travel_plan_versions_retrieval_idx'`,
      );
      expect(rows[0]!.indexdef).not.toMatch(/user_id/);
    });
  });
});
