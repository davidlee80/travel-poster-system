import {
  COOKIE_NAMES,
  type QuotaGuard,
  checkPasswordStrength,
  hashPassword,
  hashToken,
  issueOpaqueToken,
  verifyPassword,
  type QuotaConfig,
} from '@tps/shared';
import { UniqueViolationError, type UserRow, type UsersRepository } from '@tps/db';
import type { SessionStore } from './session-store.js';

/**
 * 身份服务（R-13，设计稿 3.6、13.0、13.9）。
 *
 * 只依赖仓储接口与会话存储接口，因此四分支解析、原地升级与归并的全部分支
 * 都能用假实现穷尽测试。这些分支的正确性直接决定鉴权行为 ——
 * 「匿名 A 能否看到匿名 B 的计划」不适合只靠端到端测试抽查。
 */

export type IdentityKind = 'ANONYMOUS' | 'REGISTERED';

export interface Identity {
  readonly userId: string;
  readonly userType: IdentityKind;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly dailyQuota: number;
  readonly monthlyQuota: number;
}

/** 需要下发到客户端的 Cookie 变更 */
export interface CookieMutation {
  readonly name: string;
  /** null 表示清除该 Cookie */
  readonly value: string | null;
  readonly maxAgeSeconds: number;
}

export interface ResolveInput {
  readonly anonCookie: string | undefined;
  readonly sessionCookie: string | undefined;
  readonly ip: string | null;
  /**
   * 是否允许在无身份时现场创建匿名用户。
   *
   * 只有生成端点为 true（13.0 第 3.a 条）：那是产品要求「未注册用户也能
   * 直接生成」的落地点。其余端点都在访问某个已有资源，无身份即 401。
   */
  readonly allowAnonymousCreation: boolean;
}

export type ResolveResult =
  | {
      readonly outcome: 'resolved';
      readonly identity: Identity;
      readonly cookies: readonly CookieMutation[];
      /** 同时持有两种有效凭据时，需要执行匿名归并（13.9.4） */
      readonly pendingMerge: { readonly anonymousUserId: string } | null;
    }
  | { readonly outcome: 'identity_required' }
  | {
      readonly outcome: 'anon_creation_rate_limited';
      readonly retryAfterSeconds: number | null;
    };

export type RegisterResult =
  | {
      readonly outcome: 'registered';
      readonly identity: Identity;
      readonly cookies: readonly CookieMutation[];
      /** true 表示由匿名原地升级而来，历史计划自动继承 */
      readonly upgraded: boolean;
    }
  | { readonly outcome: 'email_taken' }
  | { readonly outcome: 'password_too_weak'; readonly reason: string }
  | { readonly outcome: 'anonymous_already_upgraded' };

export type LoginResult =
  | {
      readonly outcome: 'logged_in';
      readonly identity: Identity;
      readonly cookies: readonly CookieMutation[];
      readonly merged: { readonly anonymousUserId: string } | null;
    }
  | { readonly outcome: 'invalid_credentials' }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export interface IdentityServiceDeps {
  readonly users: UsersRepository;
  readonly sessions: SessionStore;
  readonly quota: QuotaGuard;
  readonly quotaConfig: QuotaConfig;
  readonly now: () => Date;
  readonly secureCookies: boolean;
}

function toIdentity(row: UserRow): Identity {
  return {
    userId: row.id,
    userType: row.user_type,
    email: row.email,
    displayName: row.display_name,
    dailyQuota: row.daily_plan_quota,
    monthlyQuota: row.monthly_plan_quota,
  };
}

export class IdentityService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  private anonTtlSeconds(): number {
    return this.deps.quotaConfig.anonTokenTtlDays * 86_400;
  }

  private anonExpiry(): Date {
    return new Date(this.deps.now().getTime() + this.anonTtlSeconds() * 1000);
  }

  /**
   * 13.0 的四分支身份解析。
   *
   * 顺序不可调换：
   *   1. tp_session 有效        → REGISTERED
   *   2. 仅 tp_anon 有效        → ANONYMOUS
   *   3. 都无效 + 生成端点      → 现场建匿名号
   *      都无效 + 其他端点      → identity_required
   *   4. 两者同时有效           → 以 session 为准，并标记待归并
   *
   * 第 4 条放在最后判断是因为它是第 1 条的特例 ——
   * 先按 session 解析出身份，再看是否额外携带了匿名令牌。
   */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const { users, sessions } = this.deps;

    // 分支 1 / 4：会话优先
    if (input.sessionCookie !== undefined) {
      const userId = await sessions.get(input.sessionCookie);
      if (userId !== null) {
        const row = await users.findById(userId);
        if (row !== null && row.status === 'ACTIVE' && row.user_type === 'REGISTERED') {
          // 滑动过期：每次使用都续期（13.0）
          await sessions.touch(input.sessionCookie);

          // 分支 4：同时持有有效匿名令牌 → 待归并
          let pendingMerge: { anonymousUserId: string } | null = null;
          if (input.anonCookie !== undefined) {
            const anon = await users.findActiveByAnonTokenHash(hashToken(input.anonCookie));
            if (anon !== null && anon.id !== row.id) {
              pendingMerge = { anonymousUserId: anon.id };
            }
          }

          return {
            outcome: 'resolved',
            identity: toIdentity(row),
            cookies: pendingMerge
              ? [{ name: COOKIE_NAMES.anonymous, value: null, maxAgeSeconds: 0 }]
              : [],
            pendingMerge,
          };
        }
      }
    }

    // 分支 2：匿名令牌
    if (input.anonCookie !== undefined) {
      const row = await users.findActiveByAnonTokenHash(hashToken(input.anonCookie));
      if (row !== null) {
        // 活跃续期，避免正在使用中的匿名数据被保留期清理（15.1）
        await users.touchAnonymous(row.id, this.anonExpiry());
        return { outcome: 'resolved', identity: toIdentity(row), cookies: [], pendingMerge: null };
      }
    }

    // 分支 3
    if (!input.allowAnonymousCreation) {
      return { outcome: 'identity_required' };
    }

    return this.createAnonymous(input.ip);
  }

  /** 现场创建匿名用户并签发令牌（13.9.1、3.6.3） */
  async createAnonymous(ip: string | null): Promise<ResolveResult> {
    const { users, quota, quotaConfig } = this.deps;

    const rateLimit = await quota.consumeAnonCreation(ip);
    if (!rateLimit.allowed) {
      return {
        outcome: 'anon_creation_rate_limited',
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      };
    }

    const token = issueOpaqueToken();
    const row = await users.createAnonymous({
      tokenHash: token.hash,
      expiresAt: this.anonExpiry(),
      createdIp: ip,
      dailyQuota: quotaConfig.anonymous.dailyPlans,
      monthlyQuota: quotaConfig.anonymous.monthlyPlans,
    });

    return {
      outcome: 'resolved',
      identity: toIdentity(row),
      cookies: [
        { name: COOKIE_NAMES.anonymous, value: token.value, maxAgeSeconds: this.anonTtlSeconds() },
      ],
      pendingMerge: null,
    };
  }

  /**
   * 注册（13.9.2）。
   *
   * 携带有效匿名令牌时**原地升级**：user_id 不变，历史计划自动继承。
   * 这是统一 users 表设计的核心收益 —— 独立匿名表方案在这里要跨 4 张表
   * 搬归属列，还要处理搬到一半失败的部分继承状态。
   */
  async register(input: {
    readonly email: string;
    readonly password: string;
    readonly displayName: string | null;
    readonly anonCookie: string | undefined;
  }): Promise<RegisterResult> {
    const { users, sessions, quotaConfig } = this.deps;

    const strength = checkPasswordStrength(input.password);
    if (!strength.ok) {
      return { outcome: 'password_too_weak', reason: strength.reason };
    }

    const passwordHash = await hashPassword(input.password);
    const quotas = {
      dailyQuota: quotaConfig.registered.dailyPlans,
      monthlyQuota: quotaConfig.registered.monthlyPlans,
    };

    let row: UserRow | null = null;
    let upgraded = false;

    const anonRow =
      input.anonCookie === undefined
        ? null
        : await users.findActiveByAnonTokenHash(hashToken(input.anonCookie));

    try {
      if (anonRow !== null) {
        row = await users.upgradeAnonymous({
          anonymousUserId: anonRow.id,
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          ...quotas,
        });
        if (row === null) {
          // 并发升级：另一个请求先完成了（13.9.2）
          return { outcome: 'anonymous_already_upgraded' };
        }
        upgraded = true;
      } else {
        row = await users.createRegistered({
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          ...quotas,
        });
      }
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        return { outcome: 'email_taken' };
      }
      throw err;
    }

    const session = await sessions.create(row.id);

    return {
      outcome: 'registered',
      identity: toIdentity(row),
      cookies: [
        { name: COOKIE_NAMES.session, value: session.token, maxAgeSeconds: session.ttlSeconds },
        // 升级后匿名令牌失效，必须清除，否则下次请求会走分支 4 触发无意义的归并
        { name: COOKIE_NAMES.anonymous, value: null, maxAgeSeconds: 0 },
      ],
      upgraded,
    };
  }

  /**
   * 登录（13.9.3），副作用包含匿名归并（13.9.4）。
   *
   * 失败统一返回 `invalid_credentials`，不区分「邮箱不存在」与「口令错误」
   * —— 区分会让攻击者能枚举已注册邮箱。
   */
  async login(input: {
    readonly email: string;
    readonly password: string;
    readonly anonCookie: string | undefined;
    readonly ip: string | null;
  }): Promise<LoginResult> {
    const { users, sessions, quota } = this.deps;

    const row = await users.findActiveByEmail(input.email);

    // 邮箱不存在时也执行一次口令校验，避免响应时间差异泄漏邮箱是否注册。
    // 用一个固定的假哈希，其计算成本与真实校验相同。
    const passwordOk =
      row?.password_hash !== undefined && row?.password_hash !== null
        ? await verifyPassword(row.password_hash, input.password)
        : await verifyPassword(DUMMY_ARGON2_HASH, input.password);

    if (row === null || !passwordOk) {
      const failure = await quota.recordLoginFailure({ ip: input.ip, email: input.email });
      if (failure.locked) {
        return { outcome: 'rate_limited', retryAfterSeconds: failure.retryAfterSeconds };
      }
      return { outcome: 'invalid_credentials' };
    }

    // 归并：该设备上先匿名用过，再登录已有账号
    let merged: { anonymousUserId: string } | null = null;
    if (input.anonCookie !== undefined) {
      const anonRow = await users.findActiveByAnonTokenHash(hashToken(input.anonCookie));
      if (anonRow !== null && anonRow.id !== row.id) {
        await users.mergeAnonymousInto(anonRow.id, row.id);
        merged = { anonymousUserId: anonRow.id };
      }
    }

    const session = await sessions.create(row.id);

    return {
      outcome: 'logged_in',
      identity: toIdentity(row),
      cookies: [
        { name: COOKIE_NAMES.session, value: session.token, maxAgeSeconds: session.ttlSeconds },
        { name: COOKIE_NAMES.anonymous, value: null, maxAgeSeconds: 0 },
      ],
      merged,
    };
  }

  /**
   * 登出（13.9.3）。
   *
   * 只吊销当前会话，**不重新签发匿名令牌** —— 登出后用户处于无身份状态，
   * 下次生成时会现场建新匿名用户。若此处签发匿名令牌，用户会以为自己
   * 登出了却仍能看到某个身份的数据，语义混乱。
   */
  async logout(sessionCookie: string | undefined): Promise<readonly CookieMutation[]> {
    if (sessionCookie !== undefined) {
      await this.deps.sessions.revoke(sessionCookie);
    }
    return [
      { name: COOKIE_NAMES.session, value: null, maxAgeSeconds: 0 },
      { name: COOKIE_NAMES.anonymous, value: null, maxAgeSeconds: 0 },
    ];
  }

  /** 执行待归并（由 resolve 的分支 4 标记） */
  async completePendingMerge(anonymousUserId: string, targetUserId: string): Promise<void> {
    await this.deps.users.mergeAnonymousInto(anonymousUserId, targetUserId);
  }
}

/**
 * 用于「邮箱不存在」路径的固定假哈希。
 *
 * 目的是让不存在的邮箱与存在的邮箱在响应时间上不可区分。
 * 这是一个真实的 Argon2id 哈希（明文为随机值，无人知晓），
 * 因此 verify 的计算成本与正常路径一致。
 */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZTEyMw$Zt8xZ3wVLxHVJ4vN7kQ8fXvYbHqK5mR2sT9uW1pC3dE';
