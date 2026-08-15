import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { UniqueViolationError, createUsersRepository, type UsersRepository } from './users.js';

/**
 * users 表的集成测试（需要真实 PostgreSQL）。
 *
 * 覆盖单测无法覆盖的部分：**数据库约束本身**。
 * 三个 shape 约束（3.6.1）是身份数据正确性的最后防线 ——
 * 「匿名行带口令」或「注册行无邮箱」会让鉴权行为不可预测，
 * 这是最不该只靠应用层纪律保证的地方，因此必须验证约束真的会拒绝。
 *
 * 运行方式：
 *   DATABASE_URL=postgres://... pnpm test:integration
 *
 * 未设置 DATABASE_URL 时整体跳过（本地无 Docker 时不阻塞开发）。
 * CI 的 migrations job 会带着真实 pgvector 实例运行它。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('users 表约束（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repo: UsersRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
    });
    await migrate(pool, migrationsDirectory());
    repo = createUsersRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM users');
  });

  const anonInput = () => ({
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdIp: '203.0.113.7',
    dailyQuota: 5,
    monthlyQuota: 10,
  });

  const registeredInput = (email = 'user@example.com') => ({
    email,
    passwordHash: '$argon2id$fake',
    displayName: '小明',
    dailyQuota: 5,
    monthlyQuota: 20,
  });

  describe('三个 shape 约束（3.6.1）', () => {
    it('拒绝「匿名行带口令」', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, password_hash, anon_token_hash, anon_expires_at,
                              daily_plan_quota, monthly_plan_quota)
           VALUES ('ANONYMOUS', 'hash', $1, NOW() + INTERVAL '1 day', 5, 10)`,
          ['b'.repeat(64)],
        ),
      ).rejects.toThrow(/users_anonymous_shape/);
    });

    it('拒绝「匿名行带邮箱」', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, email, anon_token_hash, anon_expires_at,
                              daily_plan_quota, monthly_plan_quota)
           VALUES ('ANONYMOUS', 'x@example.com', $1, NOW() + INTERVAL '1 day', 5, 10)`,
          ['b'.repeat(64)],
        ),
      ).rejects.toThrow(/users_anonymous_shape/);
    });

    it('拒绝「匿名行无令牌哈希」', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, daily_plan_quota, monthly_plan_quota)
           VALUES ('ANONYMOUS', 5, 10)`,
        ),
      ).rejects.toThrow(/users_anonymous_shape/);
    });

    it('拒绝「注册行无邮箱」', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, password_hash, daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', 'hash', 5, 20)`,
        ),
      ).rejects.toThrow(/users_registered_shape/);
    });

    it('拒绝「注册行无口令」', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, email, daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', 'x@example.com', 5, 20)`,
        ),
      ).rejects.toThrow(/users_registered_shape/);
    });

    it('拒绝「MERGED 但无 merged_into」', async () => {
      const row = await repo.createRegistered(registeredInput());
      await expect(
        pool.query(`UPDATE users SET status = 'MERGED' WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/users_merged_shape/);
    });

    it('拒绝「非 MERGED 但有 merged_into」', async () => {
      const a = await repo.createRegistered(registeredInput('a@example.com'));
      const b = await repo.createRegistered(registeredInput('b@example.com'));
      await expect(
        pool.query(`UPDATE users SET merged_into = $2 WHERE id = $1`, [a.id, b.id]),
      ).rejects.toThrow(/users_merged_shape/);
    });

    it('拒绝 merged_into 自引用', async () => {
      const row = await repo.createRegistered(registeredInput());
      await expect(
        pool.query(`UPDATE users SET status = 'MERGED', merged_into = $1 WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/users_merged_not_self/);
    });

    it('拒绝未定义的 user_type 与 status', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, daily_plan_quota, monthly_plan_quota)
           VALUES ('GUEST', 5, 10)`,
        ),
      ).rejects.toThrow(/users_type_check/);
    });

    it('拒绝负配额', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (user_type, anon_token_hash, anon_expires_at,
                              daily_plan_quota, monthly_plan_quota)
           VALUES ('ANONYMOUS', $1, NOW() + INTERVAL '1 day', -1, 10)`,
          ['b'.repeat(64)],
        ),
      ).rejects.toThrow(/users_quota_positive/);
    });
  });

  describe('部分唯一索引', () => {
    it('注册邮箱唯一', async () => {
      await repo.createRegistered(registeredInput());
      await expect(repo.createRegistered(registeredInput())).rejects.toThrow(UniqueViolationError);
    });

    it('邮箱大小写不敏感（CITEXT）', async () => {
      await repo.createRegistered(registeredInput('User@Example.com'));
      await expect(repo.createRegistered(registeredInput('user@example.com'))).rejects.toThrow(
        UniqueViolationError,
      );
    });

    it('多个匿名行的 NULL 邮箱不冲突（部分索引的作用）', async () => {
      await repo.createAnonymous({ ...anonInput(), tokenHash: 'a'.repeat(64) });
      await repo.createAnonymous({ ...anonInput(), tokenHash: 'c'.repeat(64) });

      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM users WHERE user_type = 'ANONYMOUS'`,
      );
      expect(count.rows[0]?.count).toBe('2');
    });

    it('匿名令牌哈希唯一', async () => {
      await repo.createAnonymous(anonInput());
      await expect(repo.createAnonymous(anonInput())).rejects.toThrow();
    });
  });

  describe('匿名令牌查找', () => {
    it('有效令牌可查到', async () => {
      const created = await repo.createAnonymous(anonInput());
      const found = await repo.findActiveByAnonTokenHash('a'.repeat(64));
      expect(found?.id).toBe(created.id);
    });

    it('过期令牌查不到（过期判断在 SQL 中，用数据库时钟）', async () => {
      await repo.createAnonymous({
        ...anonInput(),
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await repo.findActiveByAnonTokenHash('a'.repeat(64))).toBeNull();
    });

    it('MERGED 行查不到', async () => {
      const anon = await repo.createAnonymous(anonInput());
      const target = await repo.createRegistered(registeredInput());
      await repo.mergeAnonymousInto(anon.id, target.id);

      expect(await repo.findActiveByAnonTokenHash('a'.repeat(64))).toBeNull();
    });
  });

  describe('原地升级（13.9.2）', () => {
    it('user_id 不变，令牌被清除，upgraded_at 写入', async () => {
      const anon = await repo.createAnonymous(anonInput());

      const upgraded = await repo.upgradeAnonymous({
        anonymousUserId: anon.id,
        email: 'user@example.com',
        passwordHash: '$argon2id$fake',
        displayName: '小明',
        dailyQuota: 5,
        monthlyQuota: 20,
      });

      expect(upgraded?.id).toBe(anon.id);
      expect(upgraded?.user_type).toBe('REGISTERED');
      expect(upgraded?.anon_expires_at).toBeNull();
      expect(upgraded?.upgraded_at).not.toBeNull();
      expect(await repo.findActiveByAnonTokenHash('a'.repeat(64))).toBeNull();
    });

    it('目标已非 ANONYMOUS 时返回 null（并发保护）', async () => {
      const anon = await repo.createAnonymous(anonInput());
      const input = {
        anonymousUserId: anon.id,
        email: 'user@example.com',
        passwordHash: '$argon2id$fake',
        displayName: null,
        dailyQuota: 5,
        monthlyQuota: 20,
      };

      expect(await repo.upgradeAnonymous(input)).not.toBeNull();
      expect(await repo.upgradeAnonymous({ ...input, email: 'other@example.com' })).toBeNull();
    });

    it('邮箱已占用时抛 UniqueViolationError', async () => {
      await repo.createRegistered(registeredInput());
      const anon = await repo.createAnonymous(anonInput());

      await expect(
        repo.upgradeAnonymous({
          anonymousUserId: anon.id,
          email: 'user@example.com',
          passwordHash: '$argon2id$fake',
          displayName: null,
          dailyQuota: 5,
          monthlyQuota: 20,
        }),
      ).rejects.toThrow(UniqueViolationError);
    });
  });

  describe('归并（13.9.4）', () => {
    it('标记 MERGED 并指向目标；幂等', async () => {
      const anon = await repo.createAnonymous(anonInput());
      const target = await repo.createRegistered(registeredInput());

      await repo.mergeAnonymousInto(anon.id, target.id);
      await repo.mergeAnonymousInto(anon.id, target.id);

      const row = await repo.findById(anon.id);
      expect(row?.status).toBe('MERGED');
      expect(row?.merged_into).toBe(target.id);
    });
  });

  describe('updated_at 触发器', () => {
    it('UPDATE 后 updated_at 自动推进', async () => {
      const row = await repo.createRegistered(registeredInput());
      const before = await pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM users WHERE id = $1',
        [row.id],
      );

      await pool.query(`UPDATE users SET display_name = '新名字' WHERE id = $1`, [row.id]);

      const after = await pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM users WHERE id = $1',
        [row.id],
      );

      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
        before.rows[0]!.updated_at.getTime(),
      );
    });
  });
});
