import type { Pool, PoolClient } from 'pg';

/**
 * users 仓储（R-13，设计稿 3.6、十五章、13.9）。
 *
 * 仓储接口与 SQL 实现分离：身份逻辑（`apps/api/src/identity`）依赖接口，
 * 因此可以用假仓储做完整单测；SQL 本身由集成测试覆盖（需要真实 PostgreSQL，
 * 见 `pnpm test:integration`）。
 *
 * 这个分层不是为了「可替换数据库」——我们不会换掉 PostgreSQL——
 * 而是为了让身份逻辑的分支（四分支解析、升级、归并的幂等性）能被穷尽测试。
 * 那些分支的正确性直接决定鉴权行为，不适合只靠端到端测试抽查。
 */

export type UserType = 'ANONYMOUS' | 'REGISTERED';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'MERGED' | 'DELETED';

export interface UserRow {
  readonly id: string;
  readonly user_type: UserType;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly display_name: string | null;
  readonly anon_expires_at: Date | null;
  readonly status: UserStatus;
  readonly merged_into: string | null;
  readonly daily_plan_quota: number;
  readonly monthly_plan_quota: number;
  readonly upgraded_at: Date | null;
  readonly last_seen_at: Date;
  readonly created_at: Date;
}

export interface CreateAnonymousInput {
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdIp: string | null;
  readonly dailyQuota: number;
  readonly monthlyQuota: number;
}

export interface CreateRegisteredInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string | null;
  readonly dailyQuota: number;
  readonly monthlyQuota: number;
}

export interface UpgradeAnonymousInput {
  readonly anonymousUserId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string | null;
  readonly dailyQuota: number;
  readonly monthlyQuota: number;
}

/** 归并结果：各表改挂的行数，供审计与幂等性验证 */
export interface MergeCounts {
  readonly travelRequests: number;
  readonly travelPlans: number;
  readonly generationJobs: number;
  readonly exports: number;
}

export interface UsersRepository {
  /** 按匿名令牌哈希查找。只返回 ACTIVE 且未过期的行。 */
  findActiveByAnonTokenHash(tokenHash: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  /** 按邮箱查找。只返回 ACTIVE 的注册用户。 */
  findActiveByEmail(email: string): Promise<UserRow | null>;

  createAnonymous(input: CreateAnonymousInput): Promise<UserRow>;
  createRegistered(input: CreateRegisteredInput): Promise<UserRow>;

  /**
   * 匿名原地升级为注册（13.9.2）。
   *
   * 返回 null 表示该行已不是 ANONYMOUS —— 说明有并发请求先升级了，
   * 调用方应返回 `AUTH_ANONYMOUS_ALREADY_UPGRADED` 让客户端改走登录。
   */
  upgradeAnonymous(input: UpgradeAnonymousInput): Promise<UserRow | null>;

  /** 匿名活跃续期（避免正在使用中的数据被保留期清理） */
  touchAnonymous(id: string, newExpiresAt: Date): Promise<void>;

  /**
   * 匿名归并（13.9.4）：把匿名用户名下的业务行改挂到目标用户，
   * 然后把匿名行标记 MERGED。**单事务、幂等**。
   */
  mergeAnonymousInto(anonymousUserId: string, targetUserId: string): Promise<MergeCounts>;
}

/** 唯一约束冲突（PostgreSQL 23505），供调用方区分「邮箱已占用」等情形 */
export class UniqueViolationError extends Error {
  constructor(readonly constraintName: string) {
    super(`唯一约束冲突: ${constraintName}`);
    this.name = 'UniqueViolationError';
  }
}

function isUniqueViolation(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const USER_COLUMNS = `
  id, user_type, email, password_hash, display_name,
  anon_expires_at, status, merged_into,
  daily_plan_quota, monthly_plan_quota,
  upgraded_at, last_seen_at, created_at
`;

export function createUsersRepository(pool: Pool): UsersRepository {
  async function one(sql: string, params: unknown[]): Promise<UserRow | null> {
    const result = await pool.query<UserRow>(sql, params);
    return result.rows[0] ?? null;
  }

  return {
    async findActiveByAnonTokenHash(tokenHash) {
      // 过期判断放在 SQL 里而不是应用层：应用层判断会因进程时钟漂移而与
      // 保留期清理任务（用数据库时钟）产生分歧
      return one(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE anon_token_hash = $1
           AND user_type = 'ANONYMOUS'
           AND status = 'ACTIVE'
           AND anon_expires_at > NOW()`,
        [tokenHash],
      );
    },

    async findById(id) {
      return one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    },

    async findActiveByEmail(email) {
      return one(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE email = $1 AND user_type = 'REGISTERED' AND status = 'ACTIVE'`,
        [email],
      );
    },

    async createAnonymous(input) {
      const row = await one(
        `INSERT INTO users
           (user_type, anon_token_hash, anon_expires_at, created_ip,
            daily_plan_quota, monthly_plan_quota)
         VALUES ('ANONYMOUS', $1, $2, $3, $4, $5)
         RETURNING ${USER_COLUMNS}`,
        [input.tokenHash, input.expiresAt, input.createdIp, input.dailyQuota, input.monthlyQuota],
      );
      if (!row) throw new Error('创建匿名用户未返回行');
      return row;
    },

    async createRegistered(input) {
      try {
        const row = await one(
          `INSERT INTO users
             (user_type, email, password_hash, display_name,
              daily_plan_quota, monthly_plan_quota)
           VALUES ('REGISTERED', $1, $2, $3, $4, $5)
           RETURNING ${USER_COLUMNS}`,
          [
            input.email,
            input.passwordHash,
            input.displayName,
            input.dailyQuota,
            input.monthlyQuota,
          ],
        );
        if (!row) throw new Error('创建注册用户未返回行');
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new UniqueViolationError(err.constraint ?? 'users_email_uk');
        }
        throw err;
      }
    },

    async upgradeAnonymous(input) {
      try {
        // `AND user_type = 'ANONYMOUS'` 是并发保护：两个请求同时升级同一匿名行时，
        // 第二个的受影响行数为 0，返回 null（13.9.2）
        return await one(
          `UPDATE users SET
             user_type = 'REGISTERED',
             email = $2,
             password_hash = $3,
             display_name = $4,
             daily_plan_quota = $5,
             monthly_plan_quota = $6,
             anon_token_hash = NULL,
             anon_expires_at = NULL,
             upgraded_at = NOW()
           WHERE id = $1 AND user_type = 'ANONYMOUS' AND status = 'ACTIVE'
           RETURNING ${USER_COLUMNS}`,
          [
            input.anonymousUserId,
            input.email,
            input.passwordHash,
            input.displayName,
            input.dailyQuota,
            input.monthlyQuota,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new UniqueViolationError(err.constraint ?? 'users_email_uk');
        }
        throw err;
      }
    },

    async touchAnonymous(id, newExpiresAt) {
      await pool.query(
        `UPDATE users SET last_seen_at = NOW(), anon_expires_at = $2
         WHERE id = $1 AND user_type = 'ANONYMOUS'`,
        [id, newExpiresAt],
      );
    },

    async mergeAnonymousInto(anonymousUserId, targetUserId) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');

        // 固定顺序，全部为 `WHERE user_id = :anon` 的条件更新 → 幂等，
        // 中途失败整体回滚，客户端下次登录重试即可（13.9.4）
        const counts: Record<string, number> = {};
        for (const table of ['travel_requests', 'travel_plans', 'generation_jobs', 'exports']) {
          // 表在 P2 才创建；P1 阶段跳过尚不存在的表，使归并逻辑可以先行上线
          const exists = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = $1
             ) AS exists`,
            [table],
          );
          if (exists.rows[0]?.exists !== true) {
            counts[table] = 0;
            continue;
          }

          // 表名来自上面的常量白名单，非用户输入，因此可以内插
          const updated = await client.query(
            `UPDATE ${table} SET user_id = $2 WHERE user_id = $1`,
            [anonymousUserId, targetUserId],
          );
          counts[table] = updated.rowCount ?? 0;
        }

        await client.query(
          `UPDATE users SET status = 'MERGED', merged_into = $2
           WHERE id = $1 AND status <> 'MERGED'`,
          [anonymousUserId, targetUserId],
        );

        await client.query('COMMIT');

        return {
          travelRequests: counts['travel_requests'] ?? 0,
          travelPlans: counts['travel_plans'] ?? 0,
          generationJobs: counts['generation_jobs'] ?? 0,
          exports: counts['exports'] ?? 0,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
