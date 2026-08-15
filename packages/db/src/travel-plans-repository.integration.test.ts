import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPool } from './pool.js';
import {
  createTravelPlansRepository,
  decodeCursor,
  type TravelPlansRepository,
} from './travel-plans.js';
import { UniqueViolationError, createUsersRepository, type UsersRepository } from './users.js';

/**
 * 计划仓储与匿名归并（TP-2-08、TP-2-15、TP-2-26、TP-2-27、TP-2-28，需 PostgreSQL）。
 *
 * 这些行为**只有真实数据库能验证**：
 *   - 唯一索引在并发下的表现（13.8 的「最终真相」）；
 *   - 复合游标的行值比较 `(created_at, id) < ($1, $2)`；
 *   - 归并的单事务原子性与幂等性；
 *   - `current_version_id` 触发器对 REJECTED 版本的拒绝。
 *
 * 运行：`DATABASE_URL=postgres://... pnpm test:integration`
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('计划仓储（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repository: TravelPlansRepository;
  let users: UsersRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 12,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    repository = createTravelPlansRepository(pool);
    users = createUsersRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM users');
  });

  async function anonymousUser(): Promise<string> {
    const row = await users.createAnonymous({
      tokenHash: `hash-${Math.random().toString(36).slice(2)}${Date.now()}`,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      createdIp: null,
      dailyQuota: 5,
      monthlyQuota: 10,
    });
    return row.id;
  }

  async function registeredUser(email: string): Promise<string> {
    const row = await users.createRegistered({
      email,
      passwordHash: 'argon2-placeholder',
      displayName: null,
      dailyQuota: 5,
      monthlyQuota: 20,
    });
    return row.id;
  }

  function generationInput(userId: string, key: string) {
    return {
      userId,
      clientRequestId: 'req-client-001',
      idempotencyKey: key,
      rawRequest: { schema_version: 'travel_request_ui_v1' },
      normalizedRequest: { schema_version: 'normalized_travel_request_v1' },
      destinationName: '杭州',
      destinationPlaceId: 'cn-hangzhou',
      startDate: '2026-04-10',
      endDate: '2026-04-14',
      totalDays: 5,
      travelerCount: 3,
    };
  }

  /** 64 位十六进制的假幂等键 */
  const key = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);

  describe('createGeneration', () => {
    it('同事务插入请求、计划与任务', async () => {
      const userId = await anonymousUser();
      const handles = await repository.createGeneration(generationInput(userId, key('abc')));

      const counts = await pool.query<{ requests: string; plans: string; jobs: string }>(
        `SELECT (SELECT count(*) FROM travel_requests) AS requests,
                (SELECT count(*) FROM travel_plans) AS plans,
                (SELECT count(*) FROM generation_jobs) AS jobs`,
      );
      expect(counts.rows[0]).toEqual({ requests: '1', plans: '1', jobs: '1' });

      const job = await pool.query<{ status: string; progress: number; plan_id: string }>(
        `SELECT status, progress, plan_id FROM generation_jobs WHERE id = $1`,
        [handles.jobId],
      );
      expect(job.rows[0]).toMatchObject({ status: 'QUEUED', progress: 0, plan_id: handles.planId });
    });

    it('幂等键重复时抛 UniqueViolationError 且不留残行', async () => {
      /*
       * 「不留残行」是同事务的直接体现：travel_requests 冲突时，
       * 若 plan 与 job 已经在别的事务里插进去了，库里就会出现
       * 一个没有请求的计划 —— 而列表端点会把它显示出来。
       */
      const userId = await anonymousUser();
      await repository.createGeneration(generationInput(userId, key('dup')));

      await expect(
        repository.createGeneration(generationInput(userId, key('dup'))),
      ).rejects.toBeInstanceOf(UniqueViolationError);

      const plans = await pool.query<{ count: string }>('SELECT count(*) FROM travel_plans');
      expect(plans.rows[0]!.count).toBe('1');
    });

    it('TP-2-08：并发 10 次同键提交只产生 1 个 plan_id', async () => {
      /*
       * 13.8 的验收项，且这里**完全不用 Redis** —— 正是「Redis 关闭后
       * 唯一索引仍生效」的直接验证。Redis 锁只是快路径。
       */
      const userId = await anonymousUser();
      const input = generationInput(userId, key('race'));

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => repository.createGeneration(input)),
      );

      const created = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const failure of rejected) {
        // 必须是唯一约束冲突而不是别的错误：连接池耗尽也会让 9 个失败，
        // 那时这条用例会「通过」而其实什么都没验证到
        expect(failure.reason).toBeInstanceOf(UniqueViolationError);
      }

      const plans = await pool.query<{ count: string }>('SELECT count(*) FROM travel_plans');
      expect(plans.rows[0]!.count).toBe('1');
    });

    it('不同用户可用相同的 client_request_id（幂等键含 user_id）', async () => {
      const a = await anonymousUser();
      const b = await anonymousUser();

      await repository.createGeneration(generationInput(a, key('userA')));
      await repository.createGeneration(generationInput(b, key('userB')));

      const plans = await pool.query<{ count: string }>('SELECT count(*) FROM travel_plans');
      expect(plans.rows[0]!.count).toBe('2');
    });
  });

  describe('findByIdempotencyKey', () => {
    it('返回既有任务的 ID 与状态', async () => {
      const userId = await anonymousUser();
      const handles = await repository.createGeneration(generationInput(userId, key('find')));

      const found = await repository.findByIdempotencyKey(userId, key('find'));
      expect(found).toMatchObject({ ...handles, jobStatus: 'QUEUED' });
    });

    it('他人的幂等键查不到', async () => {
      const owner = await anonymousUser();
      const other = await anonymousUser();
      await repository.createGeneration(generationInput(owner, key('mine')));

      expect(await repository.findByIdempotencyKey(other, key('mine'))).toBeNull();
    });

    it('不存在时返回 null', async () => {
      const userId = await anonymousUser();
      expect(await repository.findByIdempotencyKey(userId, key('none'))).toBeNull();
    });
  });

  describe('findPlanForUser（13.3）', () => {
    async function planWithVersion(
      userId: string,
      versionStatus: 'READY' | 'REPAIRED' | 'REJECTED',
    ): Promise<string> {
      const handles = await repository.createGeneration(
        generationInput(userId, key(`v-${versionStatus}-${userId.slice(0, 6)}`)),
      );
      const version = await pool.query<{ id: string }>(
        `INSERT INTO travel_plan_versions (
           plan_id, version_number, status, plan_json, retrieval_projection,
           destination_place_id, total_days)
         VALUES ($1, 1, $2, $3::jsonb, '{}'::jsonb, 'cn-hangzhou', 5)
         RETURNING id`,
        [handles.planId, versionStatus, JSON.stringify({ title: '杭州五日文化慢游计划' })],
      );

      if (versionStatus !== 'REJECTED') {
        await pool.query('UPDATE travel_plans SET current_version_id = $2 WHERE id = $1', [
          handles.planId,
          version.rows[0]!.id,
        ]);
      }
      return handles.planId;
    }

    it('返回当前版本的 plan_json', async () => {
      const userId = await anonymousUser();
      const planId = await planWithVersion(userId, 'READY');

      const detail = await repository.findPlanForUser(planId, userId);
      expect(detail?.planJson).toEqual({ title: '杭州五日文化慢游计划' });
    });

    it('REPAIRED 版本同样可读', async () => {
      const userId = await anonymousUser();
      const planId = await planWithVersion(userId, 'REPAIRED');
      expect(await repository.findPlanForUser(planId, userId)).not.toBeNull();
    });

    it('只有 REJECTED 版本时返回 null（验收标准 15）', async () => {
      /*
       * 「绝不展示未通过校验的草稿」。REJECTED 版本只落库供排查，
       * 因此 current_version_id 保持为空 —— 触发器也会拒绝把它设上去。
       */
      const userId = await anonymousUser();
      const planId = await planWithVersion(userId, 'REJECTED');
      expect(await repository.findPlanForUser(planId, userId)).toBeNull();
    });

    it('数据库拒绝把 REJECTED 版本设为 current_version_id', async () => {
      const userId = await anonymousUser();
      const handles = await repository.createGeneration(generationInput(userId, key('trigger')));
      const version = await pool.query<{ id: string }>(
        `INSERT INTO travel_plan_versions (
           plan_id, version_number, status, plan_json, retrieval_projection,
           destination_place_id, total_days)
         VALUES ($1, 1, 'REJECTED', '{}'::jsonb, '{}'::jsonb, 'cn-hangzhou', 5)
         RETURNING id`,
        [handles.planId],
      );

      await expect(
        pool.query('UPDATE travel_plans SET current_version_id = $2 WHERE id = $1', [
          handles.planId,
          version.rows[0]!.id,
        ]),
      ).rejects.toThrow();
    });

    it('他人的计划返回 null', async () => {
      const owner = await anonymousUser();
      const other = await anonymousUser();
      const planId = await planWithVersion(owner, 'READY');

      expect(await repository.findPlanForUser(planId, other)).toBeNull();
    });
  });

  describe('findJobForUser（13.2）', () => {
    it('强制 user_id 谓词', async () => {
      const owner = await anonymousUser();
      const other = await anonymousUser();
      const handles = await repository.createGeneration(generationInput(owner, key('job')));

      expect(await repository.findJobForUser(handles.jobId, owner)).not.toBeNull();
      expect(await repository.findJobForUser(handles.jobId, other)).toBeNull();
    });
  });

  describe('listPlansForUser（13.9.5）', () => {
    async function seedPlans(userId: string, count: number): Promise<void> {
      for (let i = 0; i < count; i += 1) {
        await repository.createGeneration(generationInput(userId, key(`list-${i}-${userId}`)));
      }
    }

    it('按 created_at 倒序返回', async () => {
      const userId = await anonymousUser();
      await seedPlans(userId, 3);

      const page = await repository.listPlansForUser({ userId, limit: 10 });
      expect(page.items).toHaveLength(3);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();

      const times = page.items.map((item) => item.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('复合游标翻页不重复不遗漏', async () => {
      const userId = await anonymousUser();
      await seedPlans(userId, 5);

      const first = await repository.listPlansForUser({ userId, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);

      const second = await repository.listPlansForUser({
        userId,
        limit: 2,
        cursor: first.nextCursor!,
      });
      const third = await repository.listPlansForUser({
        userId,
        limit: 2,
        cursor: second.nextCursor!,
      });

      const ids = [...first.items, ...second.items, ...third.items].map((item) => item.planId);
      expect(new Set(ids).size).toBe(5);
      expect(third.hasMore).toBe(false);
    });

    it('翻页中途插入新计划不会让后续页重复（复合游标 vs OFFSET）', async () => {
      /*
       * 用 OFFSET 的实现在这里会失败：新计划插到列表最前面后，
       * `OFFSET 2` 指向的位置整体后移，第二页会重复第一页的最后一条。
       * 用户看到的是同一个计划出现两次。
       */
      const userId = await anonymousUser();
      await seedPlans(userId, 4);

      const first = await repository.listPlansForUser({ userId, limit: 2 });
      await repository.createGeneration(generationInput(userId, key(`inserted-${userId}`)));

      const second = await repository.listPlansForUser({
        userId,
        limit: 2,
        cursor: first.nextCursor!,
      });

      const overlap = second.items.filter((item) =>
        first.items.some((prev) => prev.planId === item.planId),
      );
      expect(overlap).toEqual([]);
    });

    it('游标非法时从第一页开始，而不是报错', async () => {
      // 游标来自客户端，可能被截断或是上一版格式。
      // 500 会让用户看到一个打不开的页面，而回到开头至少还能用
      const userId = await anonymousUser();
      await seedPlans(userId, 2);

      const page = await repository.listPlansForUser({
        userId,
        limit: 10,
        cursor: '!!!not-base64',
      });
      expect(page.items).toHaveLength(2);
      expect(decodeCursor('!!!not-base64')).toBeNull();
    });

    it('只返回自己的计划', async () => {
      const a = await anonymousUser();
      const b = await anonymousUser();
      await seedPlans(a, 2);

      expect((await repository.listPlansForUser({ userId: b, limit: 10 })).items).toEqual([]);
    });

    it('FAILED 的计划也返回（用户需要看到失败记录）', async () => {
      const userId = await anonymousUser();
      const handles = await repository.createGeneration(generationInput(userId, key('failed')));
      await pool.query(`UPDATE travel_plans SET status = 'FAILED' WHERE id = $1`, [handles.planId]);

      const page = await repository.listPlansForUser({ userId, limit: 10 });
      expect(page.items.map((item) => item.status)).toEqual(['FAILED']);
    });
  });

  // ── TP-2-26 / TP-2-27：匿名归并 ────────────────────────────

  describe('13.9.4 匿名归并', () => {
    async function anonymousWithData(): Promise<{ anonId: string; planId: string; key: string }> {
      const anonId = await anonymousUser();
      const idempotencyKey = key(`merge-${anonId}`);
      const handles = await repository.createGeneration(generationInput(anonId, idempotencyKey));

      // 归并要改挂四张表，导出也在其中 —— 少改一张的表现是用户注册后
      // 发现部分历史记录不见了，没有任何报错
      const version = await pool.query<{ id: string }>(
        `INSERT INTO travel_plan_versions (
           plan_id, version_number, status, plan_json, retrieval_projection,
           destination_place_id, total_days)
         VALUES ($1, 1, 'READY', '{}'::jsonb, '{}'::jsonb, 'cn-hangzhou', 5)
         RETURNING id`,
        [handles.planId],
      );
      await pool.query(
        `INSERT INTO exports (
           user_id, plan_id, plan_version_id, template_id, format, scope, idempotency_key)
         VALUES ($1, $2, $3, 'travel_infographic_v1', 'PNG', 'ALL_DAYS',
                 md5(random()::text) || md5(random()::text))`,
        [anonId, handles.planId, version.rows[0]!.id],
      );
      return { anonId, planId: handles.planId, key: idempotencyKey };
    }

    it('四张表一起改挂，匿名行标记 MERGED', async () => {
      const { anonId, planId } = await anonymousWithData();
      const targetId = await registeredUser('merge-target@example.com');

      const counts = await users.mergeAnonymousInto(anonId, targetId);
      expect(counts).toEqual({
        travelRequests: 1,
        travelPlans: 1,
        generationJobs: 1,
        exports: 1,
      });

      const plan = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM travel_plans WHERE id = $1',
        [planId],
      );
      expect(plan.rows[0]!.user_id).toBe(targetId);

      const anon = await users.findById(anonId);
      expect(anon).toMatchObject({ status: 'MERGED', merged_into: targetId });
    });

    it('TP-2-27：idempotency_key 保持原值不重算', async () => {
      /*
       * 13.9.4 明确「不重算」。重算会带来两个问题：唯一约束冲突
       * （匿名期与注册期提交过相同需求时两行会算出同一个键），
       * 以及语义错误 —— 幂等键描述的是「当时那次提交」，不是「现在的归属」。
       */
      const { anonId, key: originalKey } = await anonymousWithData();
      const targetId = await registeredUser('keep-key@example.com');

      await users.mergeAnonymousInto(anonId, targetId);

      const row = await pool.query<{ idempotency_key: string; user_id: string }>(
        'SELECT idempotency_key, user_id FROM travel_requests LIMIT 1',
      );
      expect(row.rows[0]!.idempotency_key).toBe(originalKey);
      expect(row.rows[0]!.user_id).toBe(targetId);
    });

    it('门禁 #25：匿名期与注册期提交过相同需求，归并后无唯一约束冲突', async () => {
      /*
       * 键含 user_id，因此匿名那次与注册那次算出的键本来就不同。
       * 归并只改 user_id、不动键，于是两行可以共存 ——
       * 这正是「不重算」在数据层的意义。
       */
      const anonId = await anonymousUser();
      const targetId = await registeredUser('same-need@example.com');

      await repository.createGeneration(generationInput(anonId, key(`anon-${anonId}`)));
      await repository.createGeneration(generationInput(targetId, key(`reg-${targetId}`)));

      await expect(users.mergeAnonymousInto(anonId, targetId)).resolves.toMatchObject({
        travelRequests: 1,
      });

      const rows = await pool.query<{ count: string }>(
        'SELECT count(*) FROM travel_requests WHERE user_id = $1',
        [targetId],
      );
      expect(rows.rows[0]!.count).toBe('2');
    });

    it('幂等：重复执行无副作用', async () => {
      const { anonId } = await anonymousWithData();
      const targetId = await registeredUser('idempotent-merge@example.com');

      const first = await users.mergeAnonymousInto(anonId, targetId);
      const second = await users.mergeAnonymousInto(anonId, targetId);

      expect(first.travelPlans).toBe(1);
      // 第二次没有属于匿名身份的行可改，因此全部为 0
      expect(second).toEqual({
        travelRequests: 0,
        travelPlans: 0,
        generationJobs: 0,
        exports: 0,
      });

      const anon = await users.findById(anonId);
      expect(anon?.merged_into).toBe(targetId);
    });

    it('重复归并不会改写 merged_into 指向另一个账号', async () => {
      // 审计链必须指向**第一次**归并的目标；被后来者改写就追不回原始归属
      const { anonId } = await anonymousWithData();
      const firstTarget = await registeredUser('first-target@example.com');
      const secondTarget = await registeredUser('second-target@example.com');

      await users.mergeAnonymousInto(anonId, firstTarget);
      await users.mergeAnonymousInto(anonId, secondTarget);

      expect((await users.findById(anonId))?.merged_into).toBe(firstTarget);
    });

    it('门禁 #24：MERGED 行不可再作身份使用', async () => {
      /*
       * `findActiveByAnonTokenHash` 只认 ACTIVE。归并后旧 Cookie 若仍能解析出
       * 那个匿名身份，用户就会在登录后又被识别为访客，而他的新计划会挂到
       * 一个已经 MERGED 的行上 —— 那些计划在任何列表里都查不到。
       */
      const tokenHash = `hash-merged-${Date.now()}`;
      const row = await users.createAnonymous({
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        createdIp: null,
        dailyQuota: 5,
        monthlyQuota: 10,
      });
      const targetId = await registeredUser('gate24@example.com');

      expect(await users.findActiveByAnonTokenHash(tokenHash)).not.toBeNull();
      await users.mergeAnonymousInto(row.id, targetId);
      expect(await users.findActiveByAnonTokenHash(tokenHash)).toBeNull();
    });

    it('归并后的计划能被目标账号列出', async () => {
      const { anonId } = await anonymousWithData();
      const targetId = await registeredUser('list-after-merge@example.com');

      await users.mergeAnonymousInto(anonId, targetId);

      const page = await repository.listPlansForUser({ userId: targetId, limit: 10 });
      expect(page.items).toHaveLength(1);
    });
  });
});
