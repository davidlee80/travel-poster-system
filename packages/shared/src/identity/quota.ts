import { ConfigError, optionalInt } from '../config.js';

/**
 * 双身份配额与 IP 防刷（TP-1-38/39，设计稿 21.4）。
 *
 * 全部数值来自环境变量，代码里没有硬编码的配额常量 —— 调整配额只改配置。
 *
 * ## 匿名日配额与 IP 日上限的耦合
 *
 * 「单 IP 每日生成总量」是真正的兜底：它不依赖 Cookie，清 Cookie 无效。
 * 但它必须**高于**单匿名用户的日配额，否则 IP 维度会先撞墙，账号维度配额
 * 就成了摆设，而受影响的是 NAT 后的正常用户（办公网、校园网）。
 *
 * 因此 `QUOTA_IP_PLANS_PER_DAY >= 2 × QUOTA_ANON_DAILY_PLANS` 是一条不变式，
 * 在启动时校验并 fail fast —— 带着错误配置上线的表现是「部分用户莫名被限流」，
 * 这种问题极难从工单里定位。
 */

export type UserType = 'ANONYMOUS' | 'REGISTERED';

export interface IdentityQuota {
  readonly perMinute: number;
  readonly dailyPlans: number;
  readonly monthlyPlans: number;
  readonly exportsPerPlan: number;
  /** 实时 AI Hero 生成次数。匿名为 0：只用缓存与素材库（21.4） */
  readonly aiHero: number;
}

export interface IpQuota {
  readonly anonCreatePerHour: number;
  readonly anonCreatePerDay: number;
  readonly plansPerDay: number;
  readonly loginFailuresPerHour: number;
}

export interface QuotaConfig {
  readonly anonymous: IdentityQuota;
  readonly registered: IdentityQuota;
  readonly ip: IpQuota;
  readonly emailLoginFailuresPerHour: number;
  /** 匿名令牌与匿名数据保留期（天） */
  readonly anonTokenTtlDays: number;
}

/**
 * 从环境变量加载配额，并校验不变式。
 *
 * 默认值即 21.4 表格中的初始值。匿名日配额为 5（与注册持平），差异体现在
 * 月配额、导出次数、AI Hero 额度与数据保留期上 —— 让匿名用户的单次体验
 * 不打折，注册的价值落在长期保留与跨设备访问上。
 */
export function loadQuotaConfig(): QuotaConfig {
  const config: QuotaConfig = {
    anonymous: {
      perMinute: optionalInt('QUOTA_ANON_PER_MINUTE', 1),
      dailyPlans: optionalInt('QUOTA_ANON_DAILY_PLANS', 5),
      monthlyPlans: optionalInt('QUOTA_ANON_MONTHLY_PLANS', 10),
      exportsPerPlan: optionalInt('QUOTA_ANON_EXPORTS_PER_PLAN', 3),
      aiHero: optionalInt('QUOTA_ANON_AI_HERO', 0),
    },
    registered: {
      perMinute: optionalInt('QUOTA_REGISTERED_PER_MINUTE', 3),
      dailyPlans: optionalInt('QUOTA_REGISTERED_DAILY_PLANS', 5),
      monthlyPlans: optionalInt('QUOTA_REGISTERED_MONTHLY_PLANS', 20),
      exportsPerPlan: optionalInt('QUOTA_REGISTERED_EXPORTS_PER_PLAN', 10),
      aiHero: optionalInt('QUOTA_REGISTERED_AI_HERO', 2),
    },
    ip: {
      anonCreatePerHour: optionalInt('QUOTA_IP_ANON_CREATE_PER_HOUR', 5),
      anonCreatePerDay: optionalInt('QUOTA_IP_ANON_CREATE_PER_DAY', 20),
      plansPerDay: optionalInt('QUOTA_IP_PLANS_PER_DAY', 10),
      loginFailuresPerHour: optionalInt('QUOTA_IP_LOGIN_FAILURES_PER_HOUR', 10),
    },
    emailLoginFailuresPerHour: optionalInt('QUOTA_EMAIL_LOGIN_FAILURES_PER_HOUR', 5),
    anonTokenTtlDays: optionalInt('ANON_TOKEN_TTL_DAYS', 30),
  };

  assertQuotaInvariants(config);
  return config;
}

/** 配置不变式。违反即拒绝启动，不允许带着错误配额上线。 */
export function assertQuotaInvariants(config: QuotaConfig): void {
  const problems: string[] = [];

  // 核心不变式：IP 日上限必须给同 IP 下的多个正常用户留出空间
  const required = config.anonymous.dailyPlans * 2;
  if (config.ip.plansPerDay < required) {
    problems.push(
      `QUOTA_IP_PLANS_PER_DAY (${config.ip.plansPerDay}) 必须 >= ` +
        `2 × QUOTA_ANON_DAILY_PLANS (${config.anonymous.dailyPlans}) = ${required}。` +
        `否则 IP 维度会先于账号配额撞墙，NAT 后的正常用户会莫名被限流（设计稿 21.4）。`,
    );
  }

  // 月配额不应低于日配额，否则日配额永远用不满，用户会困惑
  for (const [name, quota] of [
    ['匿名', config.anonymous],
    ['注册', config.registered],
  ] as const) {
    if (quota.monthlyPlans < quota.dailyPlans) {
      problems.push(
        `${name}用户的月配额 (${quota.monthlyPlans}) 低于日配额 (${quota.dailyPlans})，` +
          `日配额将永远用不满。`,
      );
    }
  }

  // 匿名 AI Hero 额度不应高于注册用户 —— 那会让注册失去意义
  if (config.anonymous.aiHero > config.registered.aiHero) {
    problems.push(
      `匿名用户的 AI Hero 额度 (${config.anonymous.aiHero}) 高于注册用户 ` +
        `(${config.registered.aiHero})，注册将失去意义。`,
    );
  }

  for (const [key, value] of [
    ['QUOTA_ANON_DAILY_PLANS', config.anonymous.dailyPlans],
    ['QUOTA_REGISTERED_DAILY_PLANS', config.registered.dailyPlans],
    ['QUOTA_IP_ANON_CREATE_PER_HOUR', config.ip.anonCreatePerHour],
    ['ANON_TOKEN_TTL_DAYS', config.anonTokenTtlDays],
  ] as const) {
    if (value <= 0) {
      problems.push(`${key} 必须为正数，实际为 ${value}。`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`配额配置不合法:\n  - ${problems.join('\n  - ')}`);
  }
}

export function quotaFor(config: QuotaConfig, userType: UserType): IdentityQuota {
  return userType === 'ANONYMOUS' ? config.anonymous : config.registered;
}

// ── 计数存储 ────────────────────────────────────────────────

/**
 * 限流计数器。
 *
 * 抽象成接口是为了让配额判定逻辑能被完整单测 —— 判定逻辑的边界
 * （恰好用满 vs 超一个）是最容易写错也最容易被用户撞上的地方，
 * 不适合只靠连着 Redis 的端到端测试抽查。
 */
export interface CounterStore {
  /**
   * 自增并返回自增后的值；键首次出现时设置 TTL。
   *
   * `amount` 缺省为 1。一次加 N 而不是循环调用 N 次，是因为「一条候选链
   * 发出了 N 个请求」是**一个**事件（AI 成本计数，21.4）—— 拆成 N 次
   * 网络往返除了慢，还让「加到一半失败」变成可能的中间状态。
   */
  increment(key: string, ttlSeconds: number, amount?: number): Promise<number>;
  /** 只读当前值，不自增。用于「查询剩余额度」而不消耗额度。 */
  peek(key: string): Promise<number>;
}

/** 进程内实现。用于单测与无 Redis 的本地开发；**不可用于多实例生产**。 */
export class InMemoryCounterStore implements CounterStore {
  private readonly counters = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async increment(key: string, ttlSeconds: number, amount = 1): Promise<number> {
    const current = this.read(key);
    const next = current + amount;
    this.counters.set(key, { value: next, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve(next);
  }

  async peek(key: string): Promise<number> {
    return Promise.resolve(this.read(key));
  }

  private read(key: string): number {
    const entry = this.counters.get(key);
    if (!entry) return 0;
    if (entry.expiresAt <= this.now()) {
      this.counters.delete(key);
      return 0;
    }
    return entry.value;
  }
}

// ── 键构造 ──────────────────────────────────────────────────

/**
 * 计数键。
 *
 * 时间窗以「日期/小时字符串」编码进键，配合 TTL 自动重置 ——
 * 不用滑动窗口是有意的：固定窗口的「剩余额度」对用户可解释
 * （「明天 0 点重置」），滑动窗口无法给出确定的恢复时间。
 */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function minuteKey(now: Date): string {
  return now.toISOString().slice(0, 16);
}

export const QUOTA_KEYS = {
  userPlansPerDay: (userId: string, now: Date) => `q:plans:d:${dayKey(now)}:${userId}`,
  userPlansPerMonth: (userId: string, now: Date) => `q:plans:m:${monthKey(now)}:${userId}`,
  userSubmitPerMinute: (userId: string, now: Date) => `q:submit:${minuteKey(now)}:${userId}`,
  planExports: (planId: string) => `q:exports:${planId}`,
  ipPlansPerDay: (ip: string, now: Date) => `q:ip:plans:d:${dayKey(now)}:${ip}`,
  ipAnonCreatePerHour: (ip: string, now: Date) => `q:ip:anon:h:${hourKey(now)}:${ip}`,
  ipAnonCreatePerDay: (ip: string, now: Date) => `q:ip:anon:d:${dayKey(now)}:${ip}`,
  ipLoginFailuresPerHour: (ip: string, now: Date) => `q:ip:loginfail:${hourKey(now)}:${ip}`,
  emailLoginFailuresPerHour: (email: string, now: Date) =>
    `q:email:loginfail:${hourKey(now)}:${email.toLowerCase()}`,
} as const;

export const TTL = {
  minute: 120,
  hour: 3_900,
  day: 90_000,
  month: 32 * 86_400,
  /** 导出计数与计划同生命周期，按导出文件保留期（90 天）设置 */
  plan: 90 * 86_400,
} as const;
