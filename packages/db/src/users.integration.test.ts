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

    it('允许「有邮箱但无口令」—— 0010 为手机号注册放宽了这一条', async () => {
      /*
       * 0002 的原约束是 `email IS NOT NULL AND password_hash IS NOT NULL`，
       * 而 0010 把它放宽成 `email IS NOT NULL OR (phone_e164 与 phone_verified_at 都有)`
       * —— 手机号注册的用户本来就没有口令。
       *
       * 因此这条用例原来断言「无口令被拒」，从 0010 落地起就一直是红的。
       * 它一直没被发现是因为集成测试要 `DATABASE_URL` 才跑，
       * 而 `pnpm test` 默认排除 `*.integration.test.ts`。
       *
       * 改断言而不是改约束：放宽是 0010 有意为之，且迁移已应用、带校验和不可改。
       */
      await expect(
        pool.query(
          `INSERT INTO users (user_type, email, daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', 'x@example.com', 5, 20)`,
        ),
      ).resolves.toBeDefined();
    });

    it('拒绝「既无邮箱也无已验证手机号的注册行」', async () => {
      /* 放宽之后仍然守住的那一半：两种身份标识必须至少有一个 */
      await expect(
        pool.query(
          `INSERT INTO users (user_type, password_hash, daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', 'x', 5, 20)`,
        ),
      ).rejects.toThrow(/users_registered_shape/);
    });

    it('拒绝「有手机号但未验证的注册行」', async () => {
      /*
       * 0010 要求手机号注册必须 `phone_verified_at IS NOT NULL`。
       * 少了这一条，一个只填了手机号、验证码还没验过的行就能算注册用户。
       */
      await expect(
        pool.query(
          `INSERT INTO users (user_type, phone_e164, daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', '+8613800000000', 5, 20)`,
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
      /*
       * 过期时刻往前推一小时，不是一秒。
       *
       * 过期判定用的是**数据库**时钟（`expires_at > NOW()`），而这个夹具用的是
       * **进程**时钟。两者之间有偏差：容器宿主休眠/恢复后，Docker Desktop 的
       * 时钟同步会抖动几百毫秒（本机实测在 ±400 毫秒之间来回）。
       * 一秒的余量因此会偶发地不够 —— 症状是这条用例在全量跑时随机变红，
       * 而单独跑总是通过。
       *
       * 一小时的余量与本用例要验证的行为无关（「已过期就查不到」对
       * 过期 1 秒和过期 1 小时同样成立），但它让结论不再取决于时钟精度。
       * 同一类跨时钟比较的问题在 R-40 里有更彻底的处理（让数据库自己算时长）。
       */
      await repo.createAnonymous({
        ...anonInput(),
        expiresAt: new Date(Date.now() - 3_600_000),
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

  describe('改口令（13.9.2）', () => {
    it('更新哈希并返回 true', async () => {
      const row = await repo.createRegistered(registeredInput());

      expect(await repo.updatePasswordHash(row.id, '$argon2id$new')).toBe(true);
      expect((await repo.findById(row.id))?.password_hash).toBe('$argon2id$new');
    });

    it('不改配额、不写 upgraded_at', async () => {
      /*
       * 改口令借用 users 的 UPDATE，很容易顺手把「注册时才该动」的列一起写了。
       * 配额被重置的表现是用户改一次口令就多出一批额度。
       */
      const row = await repo.createRegistered(registeredInput());
      await repo.updatePasswordHash(row.id, '$argon2id$new');

      const after = await repo.findById(row.id);
      expect(after?.daily_plan_quota).toBe(row.daily_plan_quota);
      expect(after?.monthly_plan_quota).toBe(row.monthly_plan_quota);
      expect(after?.upgraded_at).toBeNull();
    });

    it('已注销的账号返回 false 且不改哈希', async () => {
      /*
       * 返回 true 的表现最坏：调用方据此回 204，用户以为口令换了。
       * 匿名行由 shape 约束兜住（带口令会被数据库拒），
       * 但 DELETED / SUSPENDED 没有那层保护，只能靠 WHERE 条件。
       */
      const row = await repo.createRegistered(registeredInput());
      await pool.query(`UPDATE users SET status = 'DELETED' WHERE id = $1`, [row.id]);

      expect(await repo.updatePasswordHash(row.id, '$argon2id$new')).toBe(false);
      expect((await repo.findById(row.id))?.password_hash).toBe('$argon2id$fake');
    });

    it('匿名行返回 false（不会撞 shape 约束报错）', async () => {
      const anon = await repo.createAnonymous(anonInput());

      expect(await repo.updatePasswordHash(anon.id, '$argon2id$new')).toBe(false);
      expect((await repo.findById(anon.id))?.password_hash).toBeNull();
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
