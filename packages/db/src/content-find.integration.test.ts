import { randomUUID } from 'node:crypto';

import { uuidv7 } from '@tps/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createContentFindRepository, type ContentFindRepository } from './content-find.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPool } from './pool.js';
import { createUsersRepository, type UsersRepository } from './users.js';

/**
 * 13.11 内部内容检索（TP-6-16，需真实 PostgreSQL）。
 *
 * 这里验证的是 **SQL 本身**：三种查询形态、UUIDv7 主键范围扫描、
 * 以及存量 v4 行的 `created_at` 兜底。后者尤其需要真实数据库 ——
 * `substring(v.id::text, 15, 1)` 依赖 PostgreSQL 的 uuid 文本形式，
 * 假仓储只会重复我对它的理解。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('内部内容检索（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repo: ContentFindRepository;
  let users: UsersRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 10_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    repo = createContentFindRepository(pool);
    users = createUsersRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
  });

  /** 造一个匿名用户 + 计划 + 版本。`contentId` 决定版本行主键 */
  async function seed(options: {
    readonly contentId: string;
    readonly createdAt?: Date;
    readonly status?: string;
  }): Promise<{ userId: string; planId: string; contentId: string }> {
    const user = await users.createAnonymous({
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      createdIp: null,
      dailyQuota: 5,
      monthlyQuota: 10,
    });

    const request = await pool.query<{ id: string }>(
      `INSERT INTO travel_requests (user_id, client_request_id, idempotency_key, destination_name,
                                    start_date, end_date, total_days, traveler_count,
                                    raw_request, normalized_request)
       VALUES ($1, $2, $3, '杭州', '2026-09-01', '2026-09-05', 5, 2,
               '{}'::jsonb, '{}'::jsonb)
       RETURNING id`,
      [user.id, randomUUID(), randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')],
    );
    const plan = await pool.query<{ id: string }>(
      `INSERT INTO travel_plans (user_id, request_id, destination_name, start_date, total_days)
       VALUES ($1, $2, '杭州', '2026-09-01', 5) RETURNING id`,
      [user.id, request.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO travel_plan_versions
         (id, plan_id, version_number, status, plan_json, retrieval_projection,
          destination_place_id, total_days, created_at)
       VALUES ($1::uuid, $2, 1, $3, '{}'::jsonb, '{}'::jsonb, 'cn-hangzhou', 5,
               COALESCE($4::timestamptz, NOW()))`,
      [options.contentId, plan.rows[0]!.id, options.status ?? 'READY', options.createdAt ?? null],
    );

    return { userId: user.id, planId: plan.rows[0]!.id, contentId: options.contentId };
  }

  describe('三种查询形态（13.11）', () => {
    it('按 content-id 精确命中单行', async () => {
      const target = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 19)) });
      await seed({ contentId: uuidv7(Date.UTC(2026, 7, 20)) });

      const rows = await repo.find({ contentId: target.contentId, limit: 10 });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contentId: target.contentId,
        planId: target.planId,
        userId: target.userId,
        userType: 'ANONYMOUS',
        versionStatus: 'READY',
        destinationPlaceId: 'cn-hangzhou',
        totalDays: 5,
      });
    });

    it('按 user 命中该用户的全部内容', async () => {
      const mine = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 19)) });
      await seed({ contentId: uuidv7(Date.UTC(2026, 7, 20)) });

      const rows = await repo.find({ userId: mine.userId, limit: 10 });

      expect(rows.map((row) => row.contentId)).toEqual([mine.contentId]);
    });

    it('按时间范围命中（UUIDv7 主键范围扫描）', async () => {
      const inside = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 15)) });
      await seed({ contentId: uuidv7(Date.UTC(2026, 6, 1)) });
      await seed({ contentId: uuidv7(Date.UTC(2026, 8, 20)) });

      const rows = await repo.find({
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        limit: 10,
      });

      expect(rows.map((row) => row.contentId)).toEqual([inside.contentId]);
    });

    it('user + 时间范围组合', async () => {
      const target = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 15)) });
      await seed({ contentId: uuidv7(Date.UTC(2026, 7, 16)) });

      const rows = await repo.find({
        userId: target.userId,
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        limit: 10,
      });

      expect(rows.map((row) => row.contentId)).toEqual([target.contentId]);
    });
  });

  describe('存量 v4 行的兜底（R-48/R-53）', () => {
    it('v4 行按 created_at 被时间范围查到', async () => {
      /*
       * v4 的「时间前缀」是随机数据，因此主键范围扫描对它无意义 ——
       * 那一支要么漏掉它、要么把它误判进别的月份。第二支谓词
       * （`substring(id::text, 15, 1) <> '7'` + created_at）专门收它们。
       */
      const legacy = await seed({
        contentId: randomUUID(),
        createdAt: new Date(Date.UTC(2026, 7, 15)),
      });

      const rows = await repo.find({
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        limit: 10,
      });

      expect(rows.map((row) => row.contentId)).toContain(legacy.contentId);
    });

    it('区间外的 v4 行不被查到', async () => {
      const outside = await seed({
        contentId: randomUUID(),
        createdAt: new Date(Date.UTC(2026, 5, 1)),
      });

      const rows = await repo.find({
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        limit: 10,
      });

      expect(rows.map((row) => row.contentId)).not.toContain(outside.contentId);
    });

    it('v7 行**不**走兜底支（否则同一行会被两支各命中一次）', async () => {
      /*
       * 谓词是 OR，因此如果兜底支也收 v7 行，一行会满足两支。
       * SQL 的 WHERE 不会因此返回重复行，但这条断言守的是另一件事：
       * 兜底支的 `substring(...) <> '7'` 一旦写错（比如取错位置），
       * 全部 v7 行都会退化成 created_at 扫描 —— 索引失效而结果仍然正确，
       * 于是没有任何测试会红，只有生产变慢。
       */
      const v7 = await seed({
        contentId: uuidv7(Date.UTC(2026, 7, 15)),
        // 故意让 created_at 落在区间外：v7 走主键支仍应命中
        createdAt: new Date(Date.UTC(2020, 0, 1)),
      });

      const rows = await repo.find({
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        limit: 10,
      });

      expect(rows.map((row) => row.contentId)).toContain(v7.contentId);
    });
  });

  describe('输出内容', () => {
    it('含关联的 job 与 export ID（FR-6.6.2 的锚点链）', async () => {
      const seeded = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 19)) });
      const request = await pool.query<{ id: string }>(
        'SELECT id FROM travel_requests WHERE user_id = $1',
        [seeded.userId],
      );
      const job = await pool.query<{ id: string }>(
        `INSERT INTO generation_jobs (user_id, request_id, plan_id, plan_version_id)
         VALUES ($1, $2, $3, $4::uuid) RETURNING id`,
        [seeded.userId, request.rows[0]!.id, seeded.planId, seeded.contentId],
      );
      const exp = await pool.query<{ id: string }>(
        `INSERT INTO exports (user_id, plan_id, plan_version_id, template_id, format, scope,
                              idempotency_key)
         VALUES ($1, $2, $3::uuid, 'travel_infographic_v1', 'PDF', 'FULL_PLAN', $4)
         RETURNING id`,
        [seeded.userId, seeded.planId, seeded.contentId, randomUUID().replace(/-/g, '')],
      );

      const rows = await repo.find({ contentId: seeded.contentId, limit: 10 });

      expect(rows[0]?.jobIds).toEqual([job.rows[0]!.id]);
      expect(rows[0]?.exportIds).toEqual([exp.rows[0]!.id]);
    });

    it('没有关联 job/export 时是空数组而不是 null', async () => {
      const seeded = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 19)) });
      const rows = await repo.find({ contentId: seeded.contentId, limit: 10 });

      expect(rows[0]?.jobIds).toEqual([]);
      expect(rows[0]?.exportIds).toEqual([]);
    });

    it('status 筛选生效', async () => {
      await seed({ contentId: uuidv7(Date.UTC(2026, 7, 19)), status: 'READY' });
      const rejected = await seed({
        contentId: uuidv7(Date.UTC(2026, 7, 20)),
        status: 'REJECTED',
      });

      const rows = await repo.find({
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        status: 'REJECTED',
        limit: 10,
      });

      expect(rows.map((row) => row.contentId)).toEqual([rejected.contentId]);
    });

    it('limit 生效，且按 ID 降序（最新的在前）', async () => {
      const older = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 10)) });
      const newer = await seed({ contentId: uuidv7(Date.UTC(2026, 7, 20)) });

      const rows = await repo.find({
        from: new Date(Date.UTC(2026, 7, 1)),
        to: new Date(Date.UTC(2026, 8, 1)),
        limit: 1,
      });

      expect(rows.map((row) => row.contentId)).toEqual([newer.contentId]);
      expect(rows.map((row) => row.contentId)).not.toContain(older.contentId);
    });
  });

  describe('防护', () => {
    it('不带任何筛选维度时抛错（避免全表扫描与打错命令）', async () => {
      await expect(repo.find({ limit: 10 })).rejects.toThrow(/至少需要/);
    });

    it('只给 status 也不够（它不是筛选维度而是过滤器）', async () => {
      await expect(repo.find({ status: 'READY', limit: 10 })).rejects.toThrow(/至少需要/);
    });
  });
});
