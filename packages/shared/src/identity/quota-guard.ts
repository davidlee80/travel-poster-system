import {
  QUOTA_KEYS,
  TTL,
  quotaFor,
  type CounterStore,
  type QuotaConfig,
  type UserType,
} from './quota.js';

/**
 * 配额判定（设计稿 21.4）。
 *
 * 两类操作分开：
 *   `check*`    只读，不消耗额度 —— 供 `/auth/session` 返回剩余额度
 *   `consume*`  自增后判定 —— 供实际提交路径使用
 *
 * 判定用「自增后 > 上限」而不是「自增前 >= 上限」：前者天然原子（Redis 的
 * INCR 返回自增后的值），后者需要 GET + 比较 + INCR 三步，并发下会超发。
 */

export type QuotaDecision =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false;
      readonly reason: QuotaRejectionReason;
      /** 客户端可重试的等待秒数；不可恢复时为 null */
      readonly retryAfterSeconds: number | null;
    };

export type QuotaRejectionReason =
  | 'RATE_LIMITED_PER_MINUTE'
  | 'DAILY_QUOTA_EXCEEDED'
  | 'MONTHLY_QUOTA_EXCEEDED'
  | 'EXPORT_QUOTA_EXCEEDED'
  | 'IP_DAILY_QUOTA_EXCEEDED'
  | 'IP_ANON_CREATE_RATE_LIMITED';

export interface QuotaGuardDeps {
  readonly config: QuotaConfig;
  readonly store: CounterStore;
  /** 注入以便测试可控时间；生产传 `() => new Date()` */
  readonly now: () => Date;
}

/** 距下一个整日的秒数，用于 Retry-After */
function secondsUntilNextDay(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

function secondsUntilNextMinute(now: Date): number {
  return Math.max(1, 60 - now.getUTCSeconds());
}

function secondsUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(60, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export class QuotaGuard {
  constructor(private readonly deps: QuotaGuardDeps) {}

  /**
   * 提交生成请求的配额检查（分钟 / 日 / 月 / IP 日四层）。
   *
   * 检查顺序按「恢复时间从短到长」：分钟级限流的提示是「稍后重试」，
   * 日配额的提示是「明天再来」，月配额是「注册以获得更多额度」。
   * 先报恢复最快的那个，用户的下一步动作最明确。
   *
   * 注意：任一层拒绝时，**已经自增的层不回滚**。这是有意的 ——
   * 回滚需要分布式事务，而少量的额度损耗远好于并发下的超发。
   */
  async consumeGeneration(input: {
    readonly userId: string;
    readonly userType: UserType;
    readonly ip: string | null;
    /** 用户行上的覆盖值；缺省时用 config 中该身份类型的默认值 */
    readonly dailyQuotaOverride?: number;
    readonly monthlyQuotaOverride?: number;
  }): Promise<QuotaDecision> {
    const { config, store, now: nowFn } = this.deps;
    const now = nowFn();
    const base = quotaFor(config, input.userType);

    const dailyLimit = input.dailyQuotaOverride ?? base.dailyPlans;
    const monthlyLimit = input.monthlyQuotaOverride ?? base.monthlyPlans;

    const perMinute = await store.increment(
      QUOTA_KEYS.userSubmitPerMinute(input.userId, now),
      TTL.minute,
    );
    if (perMinute > base.perMinute) {
      return {
        allowed: false,
        reason: 'RATE_LIMITED_PER_MINUTE',
        retryAfterSeconds: secondsUntilNextMinute(now),
      };
    }

    const daily = await store.increment(QUOTA_KEYS.userPlansPerDay(input.userId, now), TTL.day);
    if (daily > dailyLimit) {
      return {
        allowed: false,
        reason: 'DAILY_QUOTA_EXCEEDED',
        retryAfterSeconds: secondsUntilNextDay(now),
      };
    }

    const monthly = await store.increment(
      QUOTA_KEYS.userPlansPerMonth(input.userId, now),
      TTL.month,
    );
    if (monthly > monthlyLimit) {
      // 月配额耗尽没有短期恢复路径，不给 Retry-After
      return { allowed: false, reason: 'MONTHLY_QUOTA_EXCEEDED', retryAfterSeconds: null };
    }

    // IP 维度只对匿名身份生效（21.4）：注册用户只受账号维度限制，
    // 否则 NAT 后的多个注册用户会互相挤占，而他们已经没有「再注册」的出路
    if (input.userType === 'ANONYMOUS' && input.ip !== null) {
      const ipDaily = await store.increment(QUOTA_KEYS.ipPlansPerDay(input.ip, now), TTL.day);
      if (ipDaily > config.ip.plansPerDay) {
        return {
          allowed: false,
          reason: 'IP_DAILY_QUOTA_EXCEEDED',
          retryAfterSeconds: secondsUntilNextDay(now),
        };
      }
    }

    return { allowed: true, remaining: Math.max(0, dailyLimit - daily) };
  }

  /**
   * 匿名身份创建限速（3.6.5、21.4）。
   *
   * 不限制匿名用户的**创建**，其他配额就毫无意义 ——
   * 攻击者清一次 Cookie 就重置额度。
   */
  async consumeAnonCreation(ip: string | null): Promise<QuotaDecision> {
    if (ip === null) {
      // 拿不到 IP 时放行而不是拒绝：拿不到 IP 通常是代理配置问题，
      // 因此拒绝会让全部用户无法使用。IP 维度是防滥用的加固层而非鉴权层。
      return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }

    const { config, store, now: nowFn } = this.deps;
    const now = nowFn();

    const hourly = await store.increment(QUOTA_KEYS.ipAnonCreatePerHour(ip, now), TTL.hour);
    if (hourly > config.ip.anonCreatePerHour) {
      return {
        allowed: false,
        reason: 'IP_ANON_CREATE_RATE_LIMITED',
        retryAfterSeconds: secondsUntilNextHour(now),
      };
    }

    const daily = await store.increment(QUOTA_KEYS.ipAnonCreatePerDay(ip, now), TTL.day);
    if (daily > config.ip.anonCreatePerDay) {
      return {
        allowed: false,
        reason: 'IP_ANON_CREATE_RATE_LIMITED',
        retryAfterSeconds: secondsUntilNextDay(now),
      };
    }

    return { allowed: true, remaining: Math.max(0, config.ip.anonCreatePerHour - hourly) };
  }

  /** 导出次数（按计划计数，21.4） */
  async consumeExport(input: {
    readonly planId: string;
    readonly userType: UserType;
  }): Promise<QuotaDecision> {
    const { config, store } = this.deps;
    const limit = quotaFor(config, input.userType).exportsPerPlan;

    const count = await store.increment(QUOTA_KEYS.planExports(input.planId), TTL.plan);
    if (count > limit) {
      return { allowed: false, reason: 'EXPORT_QUOTA_EXCEEDED', retryAfterSeconds: null };
    }
    return { allowed: true, remaining: Math.max(0, limit - count) };
  }

  /**
   * 登录失败计数（13.9.3）。
   *
   * IP 与邮箱双维度：只按 IP 会让攻击者换 IP 撞同一账号，
   * 只按邮箱会让攻击者用一个 IP 遍历大量账号。
   */
  async recordLoginFailure(input: {
    readonly ip: string | null;
    readonly email: string;
  }): Promise<{ readonly locked: boolean; readonly retryAfterSeconds: number }> {
    const { config, store, now: nowFn } = this.deps;
    const now = nowFn();

    const emailCount = await store.increment(
      QUOTA_KEYS.emailLoginFailuresPerHour(input.email, now),
      TTL.hour,
    );
    let ipCount = 0;
    if (input.ip !== null) {
      ipCount = await store.increment(QUOTA_KEYS.ipLoginFailuresPerHour(input.ip, now), TTL.hour);
    }

    const locked =
      emailCount > config.emailLoginFailuresPerHour || ipCount > config.ip.loginFailuresPerHour;

    return { locked, retryAfterSeconds: secondsUntilNextHour(now) };
  }

  /** 只读剩余额度，不消耗（供 `/auth/session` 使用） */
  async peekRemaining(input: {
    readonly userId: string;
    readonly userType: UserType;
    readonly dailyQuotaOverride?: number;
    readonly monthlyQuotaOverride?: number;
  }): Promise<{
    readonly dailyRemaining: number;
    readonly monthlyRemaining: number;
    readonly resetAt: string;
  }> {
    const { config, store, now: nowFn } = this.deps;
    const now = nowFn();
    const base = quotaFor(config, input.userType);

    const dailyLimit = input.dailyQuotaOverride ?? base.dailyPlans;
    const monthlyLimit = input.monthlyQuotaOverride ?? base.monthlyPlans;

    const daily = await store.peek(QUOTA_KEYS.userPlansPerDay(input.userId, now));
    const monthly = await store.peek(QUOTA_KEYS.userPlansPerMonth(input.userId, now));

    const resetAt = new Date(now);
    resetAt.setUTCHours(24, 0, 0, 0);

    return {
      dailyRemaining: Math.max(0, dailyLimit - daily),
      monthlyRemaining: Math.max(0, monthlyLimit - monthly),
      resetAt: resetAt.toISOString(),
    };
  }
}
