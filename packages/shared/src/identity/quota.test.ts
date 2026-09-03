import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import {
  InMemoryCounterStore,
  QUOTA_KEYS,
  assertQuotaInvariants,
  dayKey,
  hourKey,
  minuteKey,
  monthKey,
  quotaFor,
  type QuotaConfig,
} from './quota.js';
import { QuotaGuard } from './quota-guard.js';

/** 21.4 的初始默认值：匿名日配额 5、IP 日上限 10 */
function baseConfig(overrides: Partial<QuotaConfig> = {}): QuotaConfig {
  return {
    anonymous: { perMinute: 1, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 0 },
    registered: { perMinute: 3, dailyPlans: 5, monthlyPlans: 20, exportsPerPlan: 10, aiHero: 2 },
    ip: {
      anonCreatePerHour: 5,
      anonCreatePerDay: 20,
      plansPerDay: 10,
      loginFailuresPerHour: 10,
      registerPerHour: 10,
      registerPerDay: 50,
    },
    emailLoginFailuresPerHour: 5,
    anonTokenTtlDays: 30,
    ...overrides,
  };
}

function makeGuard(config: QuotaConfig = baseConfig(), nowIso = '2026-08-14T10:30:00.000Z') {
  const store = new InMemoryCounterStore(() => new Date(nowIso).getTime());
  return {
    guard: new QuotaGuard({ config, store, now: () => new Date(nowIso) }),
    store,
  };
}

describe('配置不变式（21.4）', () => {
  it('默认配置合法', () => {
    expect(() => assertQuotaInvariants(baseConfig())).not.toThrow();
  });

  it('IP 日上限低于匿名日配额两倍时拒绝启动', () => {
    const config = baseConfig({
      anonymous: { perMinute: 1, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 0 },
      ip: {
        anonCreatePerHour: 5,
        anonCreatePerDay: 20,
        plansPerDay: 9,
        loginFailuresPerHour: 10,
        registerPerHour: 10,
        registerPerDay: 50,
      },
    });

    expect(() => assertQuotaInvariants(config)).toThrow(ConfigError);
    expect(() => assertQuotaInvariants(config)).toThrow(/QUOTA_IP_PLANS_PER_DAY/);
  });

  it('恰好等于两倍时通过（边界）', () => {
    const config = baseConfig({
      ip: {
        anonCreatePerHour: 5,
        anonCreatePerDay: 20,
        plansPerDay: 10,
        loginFailuresPerHour: 10,
        registerPerHour: 10,
        registerPerDay: 50,
      },
    });
    expect(() => assertQuotaInvariants(config)).not.toThrow();
  });

  it('提高匿名日配额但忘记提高 IP 上限时被拦住（这是最可能发生的误配）', () => {
    const config = baseConfig({
      anonymous: { perMinute: 1, dailyPlans: 8, monthlyPlans: 20, exportsPerPlan: 3, aiHero: 0 },
      // IP 上限仍是 10，而 8 × 2 = 16
    });
    expect(() => assertQuotaInvariants(config)).toThrow(/必须 >= 2 ×/);
  });

  it('月配额低于日配额时拒绝（日配额将永远用不满）', () => {
    const config = baseConfig({
      registered: { perMinute: 3, dailyPlans: 5, monthlyPlans: 3, exportsPerPlan: 10, aiHero: 2 },
    });
    expect(() => assertQuotaInvariants(config)).toThrow(/月配额.*低于日配额/);
  });

  it('匿名 AI Hero 额度高于注册用户时拒绝（注册会失去意义）', () => {
    const config = baseConfig({
      anonymous: { perMinute: 1, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 5 },
    });
    expect(() => assertQuotaInvariants(config)).toThrow(/注册将失去意义/);
  });

  it('非正数配额被拒绝', () => {
    expect(() =>
      assertQuotaInvariants(
        baseConfig({
          anonymous: {
            perMinute: 1,
            dailyPlans: 0,
            monthlyPlans: 10,
            exportsPerPlan: 3,
            aiHero: 0,
          },
        }),
      ),
    ).toThrow(/必须为正数/);
  });
});

describe('身份分档（21.4）', () => {
  it('匿名日配额与注册持平（5），差异在月配额与 AI Hero 上', () => {
    const config = baseConfig();

    expect(quotaFor(config, 'ANONYMOUS').dailyPlans).toBe(5);
    expect(quotaFor(config, 'REGISTERED').dailyPlans).toBe(5);

    expect(quotaFor(config, 'ANONYMOUS').monthlyPlans).toBe(10);
    expect(quotaFor(config, 'REGISTERED').monthlyPlans).toBe(20);

    expect(quotaFor(config, 'ANONYMOUS').aiHero).toBe(0);
    expect(quotaFor(config, 'REGISTERED').aiHero).toBe(2);
  });
});

describe('生成配额消耗', () => {
  it('日配额内放行，剩余额度递减', async () => {
    const { guard } = makeGuard(
      baseConfig({
        anonymous: { perMinute: 99, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 0 },
      }),
    );

    const remainings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const decision = await guard.consumeGeneration({
        userId: 'u1',
        userType: 'ANONYMOUS',
        ip: null,
      });
      expect(decision.allowed).toBe(true);
      if (decision.allowed) remainings.push(decision.remaining);
    }

    expect(remainings).toEqual([4, 3, 2, 1, 0]);
  });

  it('第 6 次提交超出日配额（恰好用满 vs 超一个的边界）', async () => {
    const { guard } = makeGuard(
      baseConfig({
        anonymous: { perMinute: 99, dailyPlans: 5, monthlyPlans: 99, exportsPerPlan: 3, aiHero: 0 },
      }),
    );

    for (let i = 0; i < 5; i += 1) {
      const d = await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
      expect(d.allowed).toBe(true);
    }

    const sixth = await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
    expect(sixth.allowed).toBe(false);
    if (!sixth.allowed) {
      expect(sixth.reason).toBe('DAILY_QUOTA_EXCEEDED');
      expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('分钟级限流先于日配额报出（恢复最快的先报）', async () => {
    const { guard } = makeGuard();

    const first = await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
    expect(first.allowed).toBe(true);

    // 匿名每分钟 1 次
    const second = await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.reason).toBe('RATE_LIMITED_PER_MINUTE');
      expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('月配额耗尽时不给 Retry-After（无短期恢复路径）', async () => {
    const { guard } = makeGuard(
      baseConfig({
        anonymous: { perMinute: 99, dailyPlans: 99, monthlyPlans: 2, exportsPerPlan: 3, aiHero: 0 },
        ip: {
          anonCreatePerHour: 5,
          anonCreatePerDay: 20,
          plansPerDay: 999,
          loginFailuresPerHour: 10,
      registerPerHour: 10,
      registerPerDay: 50,
        },
      }),
    );

    await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
    await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
    const third = await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });

    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.reason).toBe('MONTHLY_QUOTA_EXCEEDED');
      expect(third.retryAfterSeconds).toBeNull();
    }
  });

  it('用户行上的配额覆盖值优先于配置默认值', async () => {
    const { guard } = makeGuard(
      baseConfig({
        anonymous: { perMinute: 99, dailyPlans: 5, monthlyPlans: 99, exportsPerPlan: 3, aiHero: 0 },
      }),
    );

    const first = await guard.consumeGeneration({
      userId: 'u1',
      userType: 'ANONYMOUS',
      ip: null,
      dailyQuotaOverride: 1,
    });
    expect(first.allowed).toBe(true);

    const second = await guard.consumeGeneration({
      userId: 'u1',
      userType: 'ANONYMOUS',
      ip: null,
      dailyQuotaOverride: 1,
    });
    expect(second.allowed).toBe(false);
  });

  it('不同用户的配额互不影响', async () => {
    const { guard } = makeGuard(
      baseConfig({
        anonymous: { perMinute: 99, dailyPlans: 1, monthlyPlans: 99, exportsPerPlan: 3, aiHero: 0 },
      }),
    );

    expect(
      (await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null })).allowed,
    ).toBe(true);
    expect(
      (await guard.consumeGeneration({ userId: 'u2', userType: 'ANONYMOUS', ip: null })).allowed,
    ).toBe(true);
    expect(
      (await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null })).allowed,
    ).toBe(false);
  });
});

describe('IP 维度兜底（21.4，清 Cookie 无效的那一层）', () => {
  it('同 IP 下多个匿名身份累计受限', async () => {
    const { guard } = makeGuard(
      baseConfig({
        anonymous: {
          perMinute: 99,
          dailyPlans: 99,
          monthlyPlans: 99,
          exportsPerPlan: 3,
          aiHero: 0,
        },
        ip: {
          anonCreatePerHour: 99,
          anonCreatePerDay: 99,
          plansPerDay: 3,
          loginFailuresPerHour: 10,
      registerPerHour: 10,
      registerPerDay: 50,
        },
      }),
    );

    // 每次换一个 userId（模拟清 Cookie 重新建号），但 IP 不变
    for (let i = 0; i < 3; i += 1) {
      const d = await guard.consumeGeneration({
        userId: `anon-${i}`,
        userType: 'ANONYMOUS',
        ip: '203.0.113.7',
      });
      expect(d.allowed).toBe(true);
    }

    const fourth = await guard.consumeGeneration({
      userId: 'anon-3',
      userType: 'ANONYMOUS',
      ip: '203.0.113.7',
    });
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) expect(fourth.reason).toBe('IP_DAILY_QUOTA_EXCEEDED');
  });

  it('注册用户不受 IP 维度生成限制（NAT 后的注册用户不应互相挤占）', async () => {
    const { guard } = makeGuard(
      baseConfig({
        registered: {
          perMinute: 99,
          dailyPlans: 99,
          monthlyPlans: 99,
          exportsPerPlan: 10,
          aiHero: 2,
        },
        ip: {
          anonCreatePerHour: 99,
          anonCreatePerDay: 99,
          plansPerDay: 1,
          loginFailuresPerHour: 10,
      registerPerHour: 10,
      registerPerDay: 50,
        },
      }),
    );

    for (let i = 0; i < 5; i += 1) {
      const d = await guard.consumeGeneration({
        userId: `reg-${i}`,
        userType: 'REGISTERED',
        ip: '203.0.113.7',
      });
      expect(d.allowed).toBe(true);
    }
  });

  it('拿不到 IP 时匿名创建放行（拿不到 IP 通常是代理配置问题，拒绝会让全部用户不可用）', async () => {
    const { guard } = makeGuard();
    const decision = await guard.consumeAnonCreation(null);
    expect(decision.allowed).toBe(true);
  });

  it('匿名创建超过每小时上限被拒，带 Retry-After', async () => {
    const { guard } = makeGuard();

    for (let i = 0; i < 5; i += 1) {
      expect((await guard.consumeAnonCreation('203.0.113.7')).allowed).toBe(true);
    }

    const sixth = await guard.consumeAnonCreation('203.0.113.7');
    expect(sixth.allowed).toBe(false);
    if (!sixth.allowed) {
      expect(sixth.reason).toBe('IP_ANON_CREATE_RATE_LIMITED');
      expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('不同 IP 的匿名创建互不影响', async () => {
    const { guard } = makeGuard();

    for (let i = 0; i < 5; i += 1) {
      await guard.consumeAnonCreation('203.0.113.7');
    }
    expect((await guard.consumeAnonCreation('203.0.113.8')).allowed).toBe(true);
  });
});

describe('导出配额（21.4）', () => {
  it('匿名 3 次、注册 10 次', async () => {
    const { guard } = makeGuard();

    for (let i = 0; i < 3; i += 1) {
      expect((await guard.consumeExport({ planId: 'p1', userType: 'ANONYMOUS' })).allowed).toBe(
        true,
      );
    }
    expect((await guard.consumeExport({ planId: 'p1', userType: 'ANONYMOUS' })).allowed).toBe(
      false,
    );

    for (let i = 0; i < 10; i += 1) {
      expect((await guard.consumeExport({ planId: 'p2', userType: 'REGISTERED' })).allowed).toBe(
        true,
      );
    }
    expect((await guard.consumeExport({ planId: 'p2', userType: 'REGISTERED' })).allowed).toBe(
      false,
    );
  });
});

describe('登录失败限速（13.9.3）', () => {
  it('同邮箱失败 5 次后锁定', async () => {
    const { guard } = makeGuard();

    for (let i = 0; i < 5; i += 1) {
      const r = await guard.recordLoginFailure({ ip: '203.0.113.7', email: 'a@example.com' });
      expect(r.locked).toBe(false);
    }
    const sixth = await guard.recordLoginFailure({ ip: '203.0.113.7', email: 'a@example.com' });
    expect(sixth.locked).toBe(true);
  });

  it('同 IP 遍历不同邮箱也会被锁（只按邮箱会漏掉账号遍历）', async () => {
    const { guard } = makeGuard();

    for (let i = 0; i < 10; i += 1) {
      const r = await guard.recordLoginFailure({ ip: '203.0.113.7', email: `u${i}@example.com` });
      expect(r.locked).toBe(false);
    }
    const eleventh = await guard.recordLoginFailure({
      ip: '203.0.113.7',
      email: 'u11@example.com',
    });
    expect(eleventh.locked).toBe(true);
  });

  it('邮箱大小写不影响计数（避免用 A@x.com / a@x.com 绕过）', async () => {
    const { guard } = makeGuard();

    for (let i = 0; i < 5; i += 1) {
      await guard.recordLoginFailure({ ip: null, email: i % 2 === 0 ? 'A@X.com' : 'a@x.COM' });
    }
    const next = await guard.recordLoginFailure({ ip: null, email: 'a@x.com' });
    expect(next.locked).toBe(true);
  });
});

describe('剩余额度只读查询（/auth/session）', () => {
  it('peek 不消耗额度', async () => {
    const { guard } = makeGuard();

    const before = await guard.peekRemaining({ userId: 'u1', userType: 'ANONYMOUS' });
    await guard.peekRemaining({ userId: 'u1', userType: 'ANONYMOUS' });
    const after = await guard.peekRemaining({ userId: 'u1', userType: 'ANONYMOUS' });

    expect(after.dailyRemaining).toBe(before.dailyRemaining);
    expect(before.dailyRemaining).toBe(5);
  });

  it('消耗后剩余额度下降，并给出重置时间', async () => {
    const { guard } = makeGuard();

    await guard.consumeGeneration({ userId: 'u1', userType: 'ANONYMOUS', ip: null });
    const remaining = await guard.peekRemaining({ userId: 'u1', userType: 'ANONYMOUS' });

    expect(remaining.dailyRemaining).toBe(4);
    expect(remaining.resetAt).toBe('2026-08-15T00:00:00.000Z');
  });
});

describe('计数键与时间窗', () => {
  it('固定窗口键按日/月/时/分切分', () => {
    const now = new Date('2026-08-14T10:30:45.000Z');

    expect(dayKey(now)).toBe('2026-08-14');
    expect(monthKey(now)).toBe('2026-08');
    expect(hourKey(now)).toBe('2026-08-14T10');
    expect(minuteKey(now)).toBe('2026-08-14T10:30');
  });

  it('跨日后日配额键变化（额度自然重置）', () => {
    const day1 = new Date('2026-08-14T23:59:59.000Z');
    const day2 = new Date('2026-08-15T00:00:00.000Z');

    expect(QUOTA_KEYS.userPlansPerDay('u1', day1)).not.toBe(QUOTA_KEYS.userPlansPerDay('u1', day2));
  });

  it('TTL 到期后计数归零', async () => {
    let clock = 1_000_000;
    const store = new InMemoryCounterStore(() => clock);

    expect(await store.increment('k', 10)).toBe(1);
    expect(await store.increment('k', 10)).toBe(2);

    clock += 11_000;
    expect(await store.peek('k')).toBe(0);
    expect(await store.increment('k', 10)).toBe(1);
  });
});
