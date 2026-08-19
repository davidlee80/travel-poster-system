import type {
  CreateAnonymousInput,
  CreateRegisteredInput,
  MergeCounts,
  UpgradeAnonymousInput,
  UserRow,
  UsersRepository,
} from '@tps/db';
import { UniqueViolationError } from '@tps/db';

/**
 * 内存版 users 仓储，供身份逻辑的单测使用。
 *
 * 刻意复现真实 SQL 实现的**关键行为**，否则测试会给出虚假的信心：
 *   - `findActiveByAnonTokenHash` 过滤过期与非 ACTIVE 行
 *   - `upgradeAnonymous` 在目标已非 ANONYMOUS 时返回 null（并发保护）
 *   - 邮箱唯一冲突抛 `UniqueViolationError`
 *   - `mergeAnonymousInto` 幂等
 *
 * SQL 本身由集成测试覆盖（需要真实 PostgreSQL）。
 */
export class FakeUsersRepository implements UsersRepository {
  private readonly rows = new Map<string, UserRow>();
  private nextId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** 测试辅助：直接读取某行当前状态 */
  peek(id: string): UserRow | undefined {
    return this.rows.get(id);
  }

  /**
   * 测试辅助：当前行数。
   *
   * P7 用它断言「匿名入口关闭时连号都不建」—— 那一条只能靠行数表达：
   * 返回 `identity_required` 但顺手建了一行的实现，从响应上看不出区别。
   */
  count(): number {
    return this.rows.size;
  }

  /** 测试辅助：模拟业务表中挂在某用户名下的行数 */
  readonly businessRows = new Map<string, number>();

  private put(row: UserRow): UserRow {
    this.rows.set(row.id, row);
    return row;
  }

  async findActiveByAnonTokenHash(tokenHash: string): Promise<UserRow | null> {
    for (const row of this.rows.values()) {
      if (
        this.tokenHashes.get(row.id) === tokenHash &&
        row.user_type === 'ANONYMOUS' &&
        row.status === 'ACTIVE' &&
        row.anon_expires_at !== null &&
        row.anon_expires_at.getTime() > this.now().getTime()
      ) {
        return Promise.resolve(row);
      }
    }
    return Promise.resolve(null);
  }

  private readonly tokenHashes = new Map<string, string>();

  async findById(id: string): Promise<UserRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  async findActiveByEmail(email: string): Promise<UserRow | null> {
    for (const row of this.rows.values()) {
      if (
        row.email !== null &&
        row.email.toLowerCase() === email.toLowerCase() &&
        row.user_type === 'REGISTERED' &&
        row.status === 'ACTIVE'
      ) {
        return Promise.resolve(row);
      }
    }
    return Promise.resolve(null);
  }

  async createAnonymous(input: CreateAnonymousInput): Promise<UserRow> {
    const id = `user-${this.nextId++}`;
    this.tokenHashes.set(id, input.tokenHash);
    return Promise.resolve(
      this.put({
        id,
        user_type: 'ANONYMOUS',
        email: null,
        password_hash: null,
        display_name: null,
        anon_expires_at: input.expiresAt,
        status: 'ACTIVE',
        merged_into: null,
        daily_plan_quota: input.dailyQuota,
        monthly_plan_quota: input.monthlyQuota,
        upgraded_at: null,
        last_seen_at: this.now(),
        created_at: this.now(),
      }),
    );
  }

  async createRegistered(input: CreateRegisteredInput): Promise<UserRow> {
    if ((await this.findActiveByEmail(input.email)) !== null) {
      throw new UniqueViolationError('users_email_uk');
    }
    const id = `user-${this.nextId++}`;
    return this.put({
      id,
      user_type: 'REGISTERED',
      email: input.email,
      password_hash: input.passwordHash,
      display_name: input.displayName,
      anon_expires_at: null,
      status: 'ACTIVE',
      merged_into: null,
      daily_plan_quota: input.dailyQuota,
      monthly_plan_quota: input.monthlyQuota,
      upgraded_at: null,
      last_seen_at: this.now(),
      created_at: this.now(),
    });
  }

  async upgradeAnonymous(input: UpgradeAnonymousInput): Promise<UserRow | null> {
    const row = this.rows.get(input.anonymousUserId);
    // 复现 SQL 的 `AND user_type = 'ANONYMOUS'` 并发保护
    if (!row || row.user_type !== 'ANONYMOUS' || row.status !== 'ACTIVE') {
      return Promise.resolve(null);
    }
    if ((await this.findActiveByEmail(input.email)) !== null) {
      throw new UniqueViolationError('users_email_uk');
    }

    this.tokenHashes.delete(row.id);
    return this.put({
      ...row,
      user_type: 'REGISTERED',
      email: input.email,
      password_hash: input.passwordHash,
      display_name: input.displayName,
      anon_expires_at: null,
      daily_plan_quota: input.dailyQuota,
      monthly_plan_quota: input.monthlyQuota,
      upgraded_at: this.now(),
    });
  }

  async touchAnonymous(id: string, newExpiresAt: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.user_type === 'ANONYMOUS') {
      this.put({ ...row, anon_expires_at: newExpiresAt, last_seen_at: this.now() });
    }
    return Promise.resolve();
  }

  async mergeAnonymousInto(anonymousUserId: string, targetUserId: string): Promise<MergeCounts> {
    const moved = this.businessRows.get(anonymousUserId) ?? 0;
    if (moved > 0) {
      this.businessRows.set(targetUserId, (this.businessRows.get(targetUserId) ?? 0) + moved);
      this.businessRows.set(anonymousUserId, 0);
    }

    const row = this.rows.get(anonymousUserId);
    if (row && row.status !== 'MERGED') {
      this.tokenHashes.delete(row.id);
      this.put({ ...row, status: 'MERGED', merged_into: targetUserId });
    }

    return Promise.resolve({
      travelRequests: moved,
      travelPlans: 0,
      generationJobs: 0,
      exports: 0,
    });
  }
}
