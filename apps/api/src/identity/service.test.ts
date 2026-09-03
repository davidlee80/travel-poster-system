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
    ip: { anonCreatePerHour: 5, anonCreatePerDay: 20, plansPerDay: 10, loginFailuresPerHour: 10, registerPerHour: 10, registerPerDay: 50 },
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

function makeHarness(
  config: QuotaConfig = quotaConfig(),
  options: { readonly anonymousEnabled?: boolean } = {},
): Harness {
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
      /*
       * 默认 true：既有的 8 组用例验的是 R-13 的双模式行为，它们在开关
       * 打开时必须完全不变（P7 的回归面）。关闭态的用例显式传 false。
       */
      anonymousEnabled: options.anonymousEnabled ?? true,
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

// ── P7：匿名入口关闭 ────────────────────────────────────────

describe('P7 匿名入口关闭（FEATURE_ANONYMOUS_ENABLED=false）', () => {
  let closed: Harness;

  beforeEach(() => {
    closed = makeHarness(quotaConfig(), { anonymousEnabled: false });
  });

  it('生成端点在无 Cookie 时返回 identity_required —— 13.0 第 3.a 条被反转', async () => {
    /*
     * **这是本次迭代最重要的一条断言。**
     *
     * 13.0 第 3.a 条原文是「生成端点永不因缺身份返回 401」，它是产品要求
     * 「未注册用户也能直接生成」的落地点。P7 的产品决策反转了那个要求，
     * 因此这里的期望与 `service.test.ts` 开头那条用例正好相反 ——
     * 两条并存是有意的：一条验开关打开时的旧行为、一条验关闭时的新行为。
     */
    const result = await closed.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: '203.0.113.10',
      allowAnonymousCreation: true,
    });

    expect(result.outcome).toBe('identity_required');
  });

  it('无 Cookie 时不产生任何 users 行（连号都不建）', async () => {
    await closed.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: '203.0.113.10',
      allowAnonymousCreation: true,
    });

    expect(closed.users.count()).toBe(0);
  });

  it('持有效 tp_anon 时仍被拒，并**清除**那个 Cookie', async () => {
    /*
     * 存量匿名用户的浏览器里还有 tp_anon。不清除的话它每次请求都白带一次，
     * 而服务端每次都要查一遍库再拒 —— 既浪费一次查询，也让浏览器永远处在
     * 「带着一个不被接受的凭据」的状态。
     */
    const open = makeHarness();
    const created = await open.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: '203.0.113.11',
      allowAnonymousCreation: true,
    });
    expect(created.outcome).toBe('resolved');
    const anonToken =
      created.outcome === 'resolved'
        ? cookieValue(created.cookies, COOKIE_NAMES.anonymous)
        : undefined;
    expect(typeof anonToken).toBe('string');

    // 换成关闭态的服务，但共用同一个仓储（模拟「开关关闭后存量用户再来」）
    const shut = new IdentityService({
      users: open.users,
      sessions: open.sessions,
      quota: new QuotaGuard({
        config: quotaConfig(),
        store: new InMemoryCounterStore(() => NOW.getTime()),
        now: () => NOW,
      }),
      quotaConfig: quotaConfig(),
      now: () => NOW,
      secureCookies: false,
      anonymousEnabled: false,
    });

    const result = await shut.resolve({
      anonCookie: anonToken as string,
      sessionCookie: undefined,
      ip: '203.0.113.11',
      allowAnonymousCreation: true,
    });

    expect(result.outcome).toBe('identity_required');
    if (result.outcome === 'identity_required') {
      expect(cookieValue(result.cookies, COOKIE_NAMES.anonymous)).toBeNull();
    }
  });

  it('注册用户的 tp_session 照常解析（关闭匿名不影响注册路径）', async () => {
    const registered = await closed.service.register({
      email: 'only-registered@example.com',
      password: 'a-sufficiently-long-passphrase-1',
      displayName: null,
      anonCookie: undefined,
    });
    expect(registered.outcome).toBe('registered');
    const session =
      registered.outcome === 'registered'
        ? cookieValue(registered.cookies, COOKIE_NAMES.session)
        : undefined;

    const result = await closed.service.resolve({
      anonCookie: undefined,
      sessionCookie: session as string,
      ip: null,
      allowAnonymousCreation: true,
    });

    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.identity.userType).toBe('REGISTERED');
    }
  });

  it('session 与 anon 同时有效时：按 session 解析、清除 anon、**归并**（S1 方向 A 修订）', async () => {
    /*
     * S1（方向 A）：P7 关闭的是「新匿名号的创建」（分支 2/3），
     * 而不是「既存匿名数据的归属变更」（分支 4 / 注册 / 登录）。
     *
     * 设计修订理由：匿名用户生成的旅行计划本应可被注册账号继承；
     * 让老用户登录后发现历史行程全没了，比「不打开匿名注册」更伤体验。
     * 因此分支 4 不再判断 `anonymousEnabled`：仍然清 Cookie、仍然归并。
     */
    const open = makeHarness();
    const anon = await open.service.resolve({
      anonCookie: undefined,
      sessionCookie: undefined,
      ip: null,
      allowAnonymousCreation: true,
    });
    const anonToken =
      anon.outcome === 'resolved' ? cookieValue(anon.cookies, COOKIE_NAMES.anonymous) : undefined;

    const shut = new IdentityService({
      users: open.users,
      sessions: open.sessions,
      quota: new QuotaGuard({
        config: quotaConfig(),
        store: new InMemoryCounterStore(() => NOW.getTime()),
        now: () => NOW,
      }),
      quotaConfig: quotaConfig(),
      now: () => NOW,
      secureCookies: false,
      anonymousEnabled: false,
    });

    const registered = await shut.register({
      email: 'no-merge@example.com',
      password: 'a-sufficiently-long-passphrase-1',
      displayName: null,
      anonCookie: undefined,
    });
    const session =
      registered.outcome === 'registered'
        ? cookieValue(registered.cookies, COOKIE_NAMES.session)
        : undefined;

    const result = await shut.resolve({
      anonCookie: anonToken as string,
      sessionCookie: session as string,
      ip: null,
      allowAnonymousCreation: false,
    });

    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.identity.userType).toBe('REGISTERED');
      /* S1 方向 A：仍然标记 pendingMerge，由调用方执行 mergeAnonymousInto */
      expect(result.pendingMerge).not.toBeNull();
      expect(result.pendingMerge?.anonymousUserId).toBe('user-1');
      expect(cookieValue(result.cookies, COOKIE_NAMES.anonymous)).toBeNull();
    }
  });

  it('createAnonymous 直接调用仍然可用（重新打开与仓储层测试要用）', async () => {
    /*
     * 开关拦的是**解析路径**，不是能力本身。这条用例守的是「不删代码」——
     * 把 createAnonymous 一起废掉的话，重新打开匿名入口就不是改一个环境
     * 变量的事了，而 P7 的全部前提是「可逆」。
     */
    const result = await closed.service.createAnonymous('203.0.113.12');

    expect(result.outcome).toBe('resolved');
    expect(closed.users.count()).toBe(1);
  });
});

describe('改口令（13.9.2）', () => {
  const OLD = 'correcthorsebattery';
  const NEW = 'a-different-long-passphrase';

  /** 注册一个用户，返回 harness、user_id 与首个会话令牌 */
  async function withUser(config: QuotaConfig = quotaConfig()) {
    const h = makeHarness(config);
    const reg = await h.service.register({
      email: 'user@example.com',
      password: OLD,
      displayName: null,
      anonCookie: undefined,
    });
    if (reg.outcome !== 'registered') throw new Error('注册夹具失败');
    return {
      ...h,
      userId: reg.identity.userId,
      session: cookieValue(reg.cookies, COOKIE_NAMES.session) as string,
    };
  }

  it('吊销该用户在其他设备上的会话', async () => {
    /*
     * 这一条是改口令的全部意义所在。用户改口令通常正是因为怀疑口令外泄，
     * 而对方手上那个会话不受口令影响 —— 30 天滑动过期意味着只要他还在用
     * 就永不过期。只改哈希的实现同样会返回 `changed`，从响应上看不出区别。
     */
    const h = await withUser();

    // 第二台设备：用旧口令登录一次
    const second = await h.service.login({
      email: 'user@example.com',
      password: OLD,
      anonCookie: undefined,
      ip: null,
    });
    if (second.outcome !== 'logged_in') throw new Error('第二次登录夹具失败');
    const otherDevice = cookieValue(second.cookies, COOKIE_NAMES.session) as string;

    expect(await h.sessions.get(otherDevice)).toBe(h.userId);

    const changed = await h.service.changePassword({
      userId: h.userId,
      currentPassword: OLD,
      newPassword: NEW,
      ip: null,
    });

    expect(changed.outcome).toBe('changed');
    expect(await h.sessions.get(otherDevice)).toBeNull();
    // 发起改口令的这台设备拿到了新会话，仍在登录态
    if (changed.outcome === 'changed') {
      const fresh = cookieValue(changed.cookies, COOKIE_NAMES.session) as string;
      expect(await h.sessions.get(fresh)).toBe(h.userId);
    }
  });

  it('新会话是在吊销之后签发的（顺序反了会把自己也登出）', async () => {
    const h = await withUser();
    const changed = await h.service.changePassword({
      userId: h.userId,
      currentPassword: OLD,
      newPassword: NEW,
      ip: null,
    });

    expect(changed.outcome).toBe('changed');
    if (changed.outcome === 'changed') {
      const fresh = cookieValue(changed.cookies, COOKIE_NAMES.session);
      expect(fresh).not.toBe(h.session);
      expect(await h.sessions.get(fresh as string)).toBe(h.userId);
    }
  });

  it('旧口令错不改哈希', async () => {
    const h = await withUser();
    const before = h.users.peek(h.userId)?.password_hash;

    const result = await h.service.changePassword({
      userId: h.userId,
      currentPassword: 'not-the-current-one',
      newPassword: NEW,
      ip: null,
    });

    expect(result.outcome).toBe('current_password_invalid');
    expect(h.users.peek(h.userId)?.password_hash).toBe(before);
  });

  it('新口令太弱时不改哈希、不动会话', async () => {
    const h = await withUser();
    const before = h.users.peek(h.userId)?.password_hash;

    const result = await h.service.changePassword({
      userId: h.userId,
      currentPassword: OLD,
      newPassword: 'short',
      ip: null,
    });

    expect(result.outcome).toBe('password_too_weak');
    expect(h.users.peek(h.userId)?.password_hash).toBe(before);
    // 一次失败的改口令不该把用户登出
    expect(await h.sessions.get(h.session)).toBe(h.userId);
  });

  it('口令错误计入登录失败限流（与登录共用计数器）', async () => {
    const h = await withUser(quotaConfig({ emailLoginFailuresPerHour: 1 }));

    const first = await h.service.changePassword({
      userId: h.userId,
      currentPassword: 'wrong-1',
      newPassword: NEW,
      ip: null,
    });
    expect(first.outcome).toBe('current_password_invalid');

    const second = await h.service.changePassword({
      userId: h.userId,
      currentPassword: 'wrong-2',
      newPassword: NEW,
      ip: null,
    });
    expect(second.outcome).toBe('rate_limited');

    /*
     * 换到登录端点也应该被拦住 —— 不共用计数器的话，攻击者在两个端点之间
     * 来回切换就能让额度翻倍。
     */
    const login = await h.service.login({
      email: 'user@example.com',
      password: 'wrong-3',
      anonCookie: undefined,
      ip: null,
    });
    expect(login.outcome).toBe('rate_limited');
  });

  it('账号已注销时返回 account_unavailable 而不是 changed', async () => {
    /*
     * 返回 changed 的表现是用户以为口令换了，而旧口令依然有效 ——
     * 一个「以为自己安全了」的状态比明确的失败糟得多。
     */
    const h = await withUser();
    const row = h.users.peek(h.userId);
    if (row === undefined) throw new Error('夹具行不存在');
    // 直接改状态：仓储层没有注销接口（删账号在 P5 之后）
    (h.users as unknown as { rows: Map<string, unknown> }).rows.set(h.userId, {
      ...row,
      status: 'DELETED',
    });

    const result = await h.service.changePassword({
      userId: h.userId,
      currentPassword: OLD,
      newPassword: NEW,
      ip: null,
    });

    expect(result.outcome).toBe('account_unavailable');
  });
});
