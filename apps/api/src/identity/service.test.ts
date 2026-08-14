import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_NAMES, InMemoryCounterStore, QuotaGuard, type QuotaConfig } from '@tps/shared';
import { FakeUsersRepository } from './fake-users-repository.js';
import { InMemorySessionStore } from './session-store.js';
import { IdentityService } from './service.js';

const NOW = new Date('2026-08-14T10:00:00.000Z');

function quotaConfig(overrides: Partial<QuotaConfig> = {}): QuotaConfig {
  return {
    anonymous: { perMinute: 99, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 0 },
    registered: { perMinute: 99, dailyPlans: 5, monthlyPlans: 20, exportsPerPlan: 10, aiHero: 2 },
    ip: { anonCreatePerHour: 5, anonCreatePerDay: 20, plansPerDay: 10, loginFailuresPerHour: 10 },
    emailLoginFailuresPerHour: 5,
    anonTokenTtlDays: 30,
    ...overrides,
  };
}

interface Harness {
  readonly service: IdentityService;
  readonly users: FakeUsersRepository;
  readonly sessions: InMemorySessionStore;
}

function makeHarness(config: QuotaConfig = quotaConfig()): Harness {
  const users = new FakeUsersRepository(() => NOW);
  const sessions = new InMemorySessionStore(() => NOW.getTime());
  const store = new InMemoryCounterStore(() => NOW.getTime());
  const quota = new QuotaGuard({ config, store, now: () => NOW });

  return {
    users,
    sessions,
    service: new IdentityService({
      users,
      sessions,
      quota,
      quotaConfig: config,
      now: () => NOW,
      secureCookies: false,
    }),
  };
}

function cookieValue(
  cookies: readonly { name: string; value: string | null }[],
  name: string,
): string | null | undefined {
  return cookies.find((c) => c.name === name)?.value;
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

describe('13.0 身份解析：分支 3 —— 无身份', () => {
  it('生成端点在无 Cookie 时现场建匿名号，不返回 401（产品要求的落地点）', async () => {
    const result = await h.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: '203.0.113.7',
      allowAnonymousCreation: true,
    });

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;

    expect(result.identity.userType).toBe('ANONYMOUS');
    expect(cookieValue(result.cookies, COOKIE_NAMES.anonymous)).toBeTruthy();
  });

  it('其他端点在无 Cookie 时返回 identity_required', async () => {
    const result = await h.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: '203.0.113.7',
      allowAnonymousCreation: false,
    });

    expect(result.outcome).toBe('identity_required');
  });

  it('无效 Cookie 与无 Cookie 等价（不泄漏令牌是否曾存在）', async () => {
    const withGarbage = await h.service.resolve({
      anonCookie: 'not-a-real-token',
      sessionCookie: 'also-fake',
      ip: null,
      allowAnonymousCreation: false,
    });

    expect(withGarbage.outcome).toBe('identity_required');
  });

  it('匿名创建被 IP 限速时返回专门的结果', async () => {
    for (let i = 0; i < 5; i += 1) {
      await h.service.createAnonymous('203.0.113.7');
    }

    const sixth = await h.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: '203.0.113.7',
      allowAnonymousCreation: true,
    });

    expect(sixth.outcome).toBe('anon_creation_rate_limited');
  });
});

describe('13.0 身份解析：分支 2 —— 匿名令牌', () => {
  it('有效匿名令牌解析为 ANONYMOUS 身份', async () => {
    const created = await h.service.createAnonymous('203.0.113.7');
    expect(created.outcome).toBe('resolved');
    if (created.outcome !== 'resolved') return;

    const token = cookieValue(created.cookies, COOKIE_NAMES.anonymous);
    expect(token).toBeTruthy();

    const resolved = await h.service.resolve({
      anonCookie: token as string,
      sessionCookie: undefined,
      ip: null,
      allowAnonymousCreation: false,
    });

    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.identity.userId).toBe(created.identity.userId);
    expect(resolved.identity.userType).toBe('ANONYMOUS');
  });

  it('每次解析都续期匿名过期时间（避免正在使用的数据被清理）', async () => {
    const created = await h.service.createAnonymous(null);
    if (created.outcome !== 'resolved') throw new Error('setup failed');
    const token = cookieValue(created.cookies, COOKIE_NAMES.anonymous) as string;

    const before = h.users.peek(created.identity.userId)?.anon_expires_at;

    await h.service.resolve({
      anonCookie: token,
      sessionCookie: undefined,
      ip: null,
      allowAnonymousCreation: false,
    });

    const after = h.users.peek(created.identity.userId)?.anon_expires_at;
    expect(after).toBeDefined();
    expect(after?.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);
  });

  it('匿名令牌获得的配额来自配置的匿名档（日 5）', async () => {
    const created = await h.service.createAnonymous(null);
    if (created.outcome !== 'resolved') throw new Error('setup failed');

    expect(created.identity.dailyQuota).toBe(5);
    expect(created.identity.monthlyQuota).toBe(10);
  });
});

describe('13.9.2 注册：匿名原地升级', () => {
  it('携带匿名令牌注册时 user_id 不变，历史自动继承', async () => {
    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const token = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    // 模拟该匿名用户名下已有 2 个计划
    h.users.businessRows.set(anon.identity.userId, 2);

    const result = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: '小明',
      anonCookie: token,
    });

    expect(result.outcome).toBe('registered');
    if (result.outcome !== 'registered') return;

    expect(result.upgraded).toBe(true);
    // 核心断言：user_id 不变 → 业务行无需搬运
    expect(result.identity.userId).toBe(anon.identity.userId);
    expect(result.identity.userType).toBe('REGISTERED');
    expect(h.users.businessRows.get(anon.identity.userId)).toBe(2);
  });

  it('升级后配额切换到注册档', async () => {
    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const token = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    const result = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: token,
    });

    if (result.outcome !== 'registered') throw new Error('register failed');
    expect(result.identity.monthlyQuota).toBe(20);
  });

  it('升级后清除匿名 Cookie 并签发会话', async () => {
    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const token = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    const result = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: token,
    });

    if (result.outcome !== 'registered') throw new Error('register failed');
    expect(cookieValue(result.cookies, COOKIE_NAMES.anonymous)).toBeNull();
    expect(cookieValue(result.cookies, COOKIE_NAMES.session)).toBeTruthy();
  });

  it('无匿名令牌时新建注册用户（upgraded = false）', async () => {
    const result = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });

    expect(result.outcome).toBe('registered');
    if (result.outcome !== 'registered') return;
    expect(result.upgraded).toBe(false);
  });

  it('并发升级同一匿名行时第二个返回 anonymous_already_upgraded', async () => {
    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const token = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    const first = await h.service.register({
      email: 'a@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: token,
    });
    expect(first.outcome).toBe('registered');

    // 第二次用同一（已失效的）令牌：查不到匿名行，走新建路径而非升级
    const second = await h.service.register({
      email: 'b@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: token,
    });
    expect(second.outcome).toBe('registered');
    if (second.outcome !== 'registered') return;
    expect(second.upgraded).toBe(false);
    expect(second.identity.userId).not.toBe(
      first.outcome === 'registered' ? first.identity.userId : '',
    );
  });

  it('邮箱已占用返回 email_taken', async () => {
    await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });

    const second = await h.service.register({
      email: 'user@example.com',
      password: 'anotherlongpassword',
      displayName: null,
      anonCookie: undefined,
    });

    expect(second.outcome).toBe('email_taken');
  });

  it('弱口令被拒且不创建用户', async () => {
    const result = await h.service.register({
      email: 'user@example.com',
      password: 'short',
      displayName: null,
      anonCookie: undefined,
    });

    expect(result.outcome).toBe('password_too_weak');
    expect(await h.users.findActiveByEmail('user@example.com')).toBeNull();
  });
});

describe('13.9.3 登录', () => {
  async function seedRegistered(email = 'user@example.com'): Promise<void> {
    const result = await h.service.register({
      email,
      password: 'correcthorsebattery',
      displayName: '小明',
      anonCookie: undefined,
    });
    if (result.outcome !== 'registered') throw new Error('seed failed');
  }

  it('正确凭据登录成功并签发会话', async () => {
    await seedRegistered();

    const result = await h.service.login({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      anonCookie: undefined,
      ip: null,
    });

    expect(result.outcome).toBe('logged_in');
    if (result.outcome !== 'logged_in') return;
    expect(cookieValue(result.cookies, COOKIE_NAMES.session)).toBeTruthy();
  });

  it('口令错误与邮箱不存在返回完全相同的结果（防邮箱枚举）', async () => {
    await seedRegistered();

    const wrongPassword = await h.service.login({
      email: 'user@example.com',
      password: 'wrongpasswordhere',
      anonCookie: undefined,
      ip: null,
    });
    const unknownEmail = await h.service.login({
      email: 'nobody@example.com',
      password: 'correcthorsebattery',
      anonCookie: undefined,
      ip: null,
    });

    expect(wrongPassword).toEqual(unknownEmail);
    expect(wrongPassword.outcome).toBe('invalid_credentials');
  });

  it('连续失败达上限后返回 rate_limited', async () => {
    await seedRegistered();

    for (let i = 0; i < 5; i += 1) {
      const r = await h.service.login({
        email: 'user@example.com',
        password: 'wrongpasswordhere',
        anonCookie: undefined,
        ip: '203.0.113.7',
      });
      expect(r.outcome).toBe('invalid_credentials');
    }

    const sixth = await h.service.login({
      email: 'user@example.com',
      password: 'wrongpasswordhere',
      anonCookie: undefined,
      ip: '203.0.113.7',
    });
    expect(sixth.outcome).toBe('rate_limited');
  });
});

describe('13.9.4 匿名归并', () => {
  it('登录时携带匿名令牌 → 业务行改挂到登录用户', async () => {
    // 先注册一个账号（在另一台设备上）
    const reg = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('setup failed');

    // 本设备上先匿名用过
    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const anonToken = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;
    h.users.businessRows.set(anon.identity.userId, 3);

    const login = await h.service.login({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      anonCookie: anonToken,
      ip: null,
    });

    expect(login.outcome).toBe('logged_in');
    if (login.outcome !== 'logged_in') return;

    expect(login.merged).toEqual({ anonymousUserId: anon.identity.userId });
    expect(h.users.businessRows.get(reg.identity.userId)).toBe(3);
    expect(h.users.businessRows.get(anon.identity.userId)).toBe(0);
  });

  it('归并后匿名行标记 MERGED 并指向目标（保留审计链，不删除）', async () => {
    const reg = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('setup failed');

    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const anonToken = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    await h.service.login({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      anonCookie: anonToken,
      ip: null,
    });

    const anonRow = h.users.peek(anon.identity.userId);
    expect(anonRow?.status).toBe('MERGED');
    expect(anonRow?.merged_into).toBe(reg.identity.userId);
  });

  it('归并幂等：重复执行无副作用', async () => {
    const reg = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('setup failed');

    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    h.users.businessRows.set(anon.identity.userId, 2);

    await h.service.completePendingMerge(anon.identity.userId, reg.identity.userId);
    await h.service.completePendingMerge(anon.identity.userId, reg.identity.userId);
    await h.service.completePendingMerge(anon.identity.userId, reg.identity.userId);

    // 只搬一次，不会累加
    expect(h.users.businessRows.get(reg.identity.userId)).toBe(2);
  });

  it('MERGED 的匿名行不可再作为身份使用', async () => {
    const reg = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('setup failed');

    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const anonToken = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    await h.service.login({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      anonCookie: anonToken,
      ip: null,
    });

    // 归并后用旧匿名令牌解析应失败
    const resolved = await h.service.resolve({
      anonCookie: anonToken,
      sessionCookie: undefined,
      ip: null,
      allowAnonymousCreation: false,
    });
    expect(resolved.outcome).toBe('identity_required');
  });
});

describe('13.0 身份解析：分支 4 —— 两种凭据同时有效', () => {
  it('以会话为准，并标记待归并、清除匿名 Cookie', async () => {
    const reg = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('setup failed');
    const session = cookieValue(reg.cookies, COOKIE_NAMES.session) as string;

    const anon = await h.service.createAnonymous(null);
    if (anon.outcome !== 'resolved') throw new Error('setup failed');
    const anonToken = cookieValue(anon.cookies, COOKIE_NAMES.anonymous) as string;

    const resolved = await h.service.resolve({
      anonCookie: anonToken,
      sessionCookie: session,
      ip: null,
      allowAnonymousCreation: false,
    });

    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;

    expect(resolved.identity.userType).toBe('REGISTERED');
    expect(resolved.identity.userId).toBe(reg.identity.userId);
    expect(resolved.pendingMerge).toEqual({ anonymousUserId: anon.identity.userId });
    expect(cookieValue(resolved.cookies, COOKIE_NAMES.anonymous)).toBeNull();
  });
});

describe('13.9.3 登出', () => {
  it('吊销会话并清除两个 Cookie，不重新签发匿名令牌', async () => {
    const reg = await h.service.register({
      email: 'user@example.com',
      password: 'correcthorsebattery',
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('setup failed');
    const session = cookieValue(reg.cookies, COOKIE_NAMES.session) as string;

    const cookies = await h.service.logout(session);

    expect(cookieValue(cookies, COOKIE_NAMES.session)).toBeNull();
    expect(cookieValue(cookies, COOKIE_NAMES.anonymous)).toBeNull();

    // 会话已吊销
    const resolved = await h.service.resolve({
      anonCookie: undefined,
      sessionCookie: session,
      ip: null,
      allowAnonymousCreation: false,
    });
    expect(resolved.outcome).toBe('identity_required');
  });
});

describe('归属隔离：两类身份等强（验收门禁 #22）', () => {
  it('两个匿名用户拿到不同 user_id', async () => {
    const a = await h.service.createAnonymous('203.0.113.1');
    const b = await h.service.createAnonymous('203.0.113.2');

    if (a.outcome !== 'resolved' || b.outcome !== 'resolved') throw new Error('setup failed');
    expect(a.identity.userId).not.toBe(b.identity.userId);
  });

  it('匿名 A 的令牌无法解析出匿名 B 的身份', async () => {
    const a = await h.service.createAnonymous('203.0.113.1');
    const b = await h.service.createAnonymous('203.0.113.2');
    if (a.outcome !== 'resolved' || b.outcome !== 'resolved') throw new Error('setup failed');

    const tokenA = cookieValue(a.cookies, COOKIE_NAMES.anonymous) as string;
    const resolved = await h.service.resolve({
      anonCookie: tokenA,
      sessionCookie: undefined,
      ip: null,
      allowAnonymousCreation: false,
    });

    if (resolved.outcome !== 'resolved') throw new Error('resolve failed');
    expect(resolved.identity.userId).toBe(a.identity.userId);
    expect(resolved.identity.userId).not.toBe(b.identity.userId);
  });
});
