import { afterEach, describe, expect, it } from 'vitest';
import {
  COOKIE_NAMES,
  InMemoryCounterStore,
  QuotaGuard,
  createSilentLogger,
  GracefulShutdown,
  type QuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import { FakeUsersRepository } from '../identity/fake-users-repository.js';
import { InMemorySessionStore } from '../identity/session-store.js';
import { IdentityService } from '../identity/service.js';
import { buildServer } from '../server.js';
import { parseCookies } from './identity-context.js';

/**
 * 端点层测试：只覆盖 HTTP 映射（状态码、Set-Cookie、错误体形态）。
 * 业务分支由 identity/service.test.ts 穷尽覆盖。
 */

const NOW = new Date('2026-08-14T10:00:00.000Z');

const serviceConfig: ServiceConfig = {
  serviceName: 'tps-api-test',
  nodeEnv: 'test',
  logLevel: 'silent',
  port: 0,
  shutdownTimeoutMs: 1000,
};

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

function makeApp(
  config: QuotaConfig = quotaConfig(),
  options: { readonly anonymousEnabled?: boolean } = {},
) {
  const logger = createSilentLogger();
  const users = new FakeUsersRepository(() => NOW);
  const sessions = new InMemorySessionStore(() => NOW.getTime());
  const store = new InMemoryCounterStore(() => NOW.getTime());
  const quota = new QuotaGuard({ config, store, now: () => NOW });

  const identity = new IdentityService({
    users,
    sessions,
    quota,
    quotaConfig: config,
    now: () => NOW,
    secureCookies: false,
    // 默认 true：既有用例验的是 R-13 的双模式行为，它们必须完全不变
    anonymousEnabled: options.anonymousEnabled ?? true,
  });

  const app = buildServer({
    config: serviceConfig,
    logger,
    shutdown: new GracefulShutdown({
      logger,
      exit: () => {
        throw new Error('__exit__');
      },
    }),
    auth: { identity, quota, secureCookies: false },
  });

  return { app, users };
}

/** 从 Set-Cookie 头中取出某个 Cookie 的值；已清除的返回空串 */
function setCookieValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers['set-cookie'];
  const list: string[] = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];

  const entry = list.find((c) => c.startsWith(`${name}=`));
  if (entry === undefined) return undefined;
  return entry.slice(name.length + 1).split(';')[0];
}

let app: ReturnType<typeof makeApp>['app'] | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/v1/auth/session（13.9.1）', () => {
  it('无 Cookie 时自动建匿名号并下发 tp_anon', async () => {
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ user_type: string; quota: { daily_remaining: number } }>();
    expect(body.user_type).toBe('ANONYMOUS');
    expect(body.quota.daily_remaining).toBe(5);

    const token = setCookieValue(res.headers, COOKIE_NAMES.anonymous);
    expect(token).toBeTruthy();
  });

  it('Cookie 属性含 HttpOnly 与 SameSite=Lax，开发环境不含 Secure', async () => {
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const raw = res.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? String(raw[0]) : String(raw);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('携带有效 tp_anon 时复用同一身份，不重复建号', async () => {
    const harness = makeApp();
    app = harness.app;

    const first = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const token = setCookieValue(first.headers, COOKIE_NAMES.anonymous);

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `${COOKIE_NAMES.anonymous}=${token as string}` },
    });

    expect(second.json<{ user_id: string }>().user_id).toBe(
      first.json<{ user_id: string }>().user_id,
    );
  });

  it('匿名创建被 IP 限速时返回 429 + Retry-After', async () => {
    const harness = makeApp();
    app = harness.app;

    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
      expect(r.statusCode).toBe(200);
    }

    const sixth = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });

    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
    expect(sixth.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_ANON_CREATION_RATE_LIMITED',
    );
  });
});

describe('POST /api/v1/auth/register（13.9.2）', () => {
  it('注册成功返回 201，下发会话并清除匿名 Cookie', async () => {
    const harness = makeApp();
    app = harness.app;

    const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const anonToken = setCookieValue(session.headers, COOKIE_NAMES.anonymous);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { cookie: `${COOKIE_NAMES.anonymous}=${anonToken as string}` },
      payload: { email: 'user@example.com', password: 'correcthorsebattery', display_name: '小明' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ user_type: string; user_id: string; email: string }>();
    expect(body.user_type).toBe('REGISTERED');
    expect(body.email).toBe('user@example.com');
    // 匿名升级：user_id 不变
    expect(body.user_id).toBe(session.json<{ user_id: string }>().user_id);

    expect(
      setCookieValue(res.headers as Record<string, unknown>, COOKIE_NAMES.session),
    ).toBeTruthy();
    expect(setCookieValue(res.headers as Record<string, unknown>, COOKIE_NAMES.anonymous)).toBe('');
  });

  it('邮箱大小写归一化（User@Example.com 与 user@example.com 视为同一个）', async () => {
    const harness = makeApp();
    app = harness.app;

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'User@Example.COM', password: 'correcthorsebattery' },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'anotherlongpassword' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_EMAIL_ALREADY_REGISTERED',
    );
  });

  it('弱口令返回 400 且 field 指向 password', async () => {
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'short' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; field?: string; retryable: boolean } }>();
    expect(body.error.code).toBe('AUTH_PASSWORD_TOO_WEAK');
    expect(body.error.field).toBe('password');
    expect(body.error.retryable).toBe(false);
  });

  it('邮箱格式非法返回 400 REQ_SCHEMA_INVALID', async () => {
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'correcthorsebattery' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('REQ_SCHEMA_INVALID');
  });
});

describe('POST /api/v1/auth/login（13.9.3）', () => {
  async function seed(harness: ReturnType<typeof makeApp>): Promise<void> {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'correcthorsebattery' },
    });
    expect(res.statusCode).toBe(201);
  }

  it('正确凭据返回 200 并下发会话', async () => {
    const harness = makeApp();
    app = harness.app;
    await seed(harness);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'user@example.com', password: 'correcthorsebattery' },
    });

    expect(res.statusCode).toBe(200);
    expect(
      setCookieValue(res.headers as Record<string, unknown>, COOKIE_NAMES.session),
    ).toBeTruthy();
  });

  it('口令错误与邮箱不存在的响应完全一致（防枚举）', async () => {
    const harness = makeApp();
    app = harness.app;
    await seed(harness);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'user@example.com', password: 'wrongpasswordhere' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'correcthorsebattery' },
    });

    expect(wrongPassword.statusCode).toBe(unknownEmail.statusCode);

    // request_id / trace_id 按设计每请求不同；安全属性是「除关联 ID 外完全一致」
    const strip = (r: typeof wrongPassword): unknown => {
      const body = r.json<{ error: Record<string, unknown> }>();
      const { request_id: _rid, trace_id: _tid, ...rest } = body.error;
      return rest;
    };

    expect(strip(wrongPassword)).toEqual(strip(unknownEmail));
    expect(wrongPassword.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_CREDENTIALS_INVALID',
    );
    // 响应头也不应有差异（如仅在某一路径下出现的 Retry-After）
    expect(wrongPassword.headers['retry-after']).toBe(unknownEmail.headers['retry-after']);
  });
});

describe('POST /api/v1/auth/logout（13.9.3）', () => {
  it('返回 204 并清除两个 Cookie', async () => {
    const harness = makeApp();
    app = harness.app;

    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'correcthorsebattery' },
    });
    const session = setCookieValue(reg.headers, COOKIE_NAMES.session);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `${COOKIE_NAMES.session}=${session as string}` },
    });

    expect(res.statusCode).toBe(204);
    expect(setCookieValue(res.headers as Record<string, unknown>, COOKIE_NAMES.session)).toBe('');
    expect(setCookieValue(res.headers as Record<string, unknown>, COOKIE_NAMES.anonymous)).toBe('');
  });
});

describe('无请求体的端点容忍 JSON content-type（浏览器实际发的形状）', () => {
  it('登出：content-type: application/json + 空体 → 204', async () => {
    /*
     * 这是一个真实存在过的 bug：前端的 `request()` 给所有请求无条件加了
     * `content-type: application/json`，而 `logout()` 没有请求体 ——
     * Fastify 默认对此回 400 `FST_ERR_CTP_EMPTY_JSON_BODY`。
     *
     * 症状是**「退出登录」按钮点了没反应**且没有任何报错：调用方不看登出的
     * 返回值，它接着去重新取身份，而身份还在。
     *
     * 现有的登出用例测不到它 —— `app.inject` 不传 payload 时不发
     * content-type，走不到那个解析器。因此这一条必须显式带上头。
     */
    const harness = makeApp();
    app = harness.app;

    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'correcthorsebattery' },
    });
    const session = setCookieValue(reg.headers, COOKIE_NAMES.session);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `${COOKIE_NAMES.session}=${session as string}`,
        'content-type': 'application/json',
      },
      // 不传 payload —— 浏览器 fetch 在 body 缺省时正是这个形状
    });

    expect(res.statusCode).toBe(204);
    expect(setCookieValue(res.headers, COOKIE_NAMES.session)).toBe('');
  });

  it('空体到需要请求体的端点 → 13.7 形态的 REQ_SCHEMA_INVALID', async () => {
    /*
     * 容忍空体不等于放过它：需要请求体的端点仍要拒，只是拒的形状变成 13.0 的
     * 错误信封（含 code / retryable / request_id），而不是 Fastify 自带的
     * `{statusCode, code, error, message}` —— 后者不符合契约，
     * 前端的 `(body).error` 读不出来，只能退回一句「服务暂时不可用」。
     */
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; retryable: boolean; request_id: string } }>();
    expect(body.error.code).toBe('REQ_SCHEMA_INVALID');
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toMatch(/\S/);
  });

  it('畸形 JSON 仍然被拒（容忍空体不等于容忍坏数据）', async () => {
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/auth/password（13.9.2 改口令）', () => {
  const OLD = 'correcthorsebattery';
  const NEW = 'a-different-long-passphrase';

  /** 注册一个用户并返回它的会话 Cookie */
  async function registerUser(
    instance: NonNullable<typeof app>,
    email = 'user@example.com',
  ): Promise<string> {
    const reg = await instance.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: OLD },
    });
    return setCookieValue(reg.headers, COOKIE_NAMES.session) as string;
  }

  function change(
    instance: NonNullable<typeof app>,
    session: string,
    payload: Record<string, string>,
  ) {
    return instance.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${COOKIE_NAMES.session}=${session}` },
      payload,
    });
  }

  it('改成功返回 204 并下发新会话 Cookie', async () => {
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);

    const res = await change(app, session, { current_password: OLD, new_password: NEW });

    expect(res.statusCode).toBe(204);
    const fresh = setCookieValue(res.headers, COOKIE_NAMES.session);
    expect(fresh).toBeTruthy();
    // 必须是**另一个**会话：全部旧会话（含当前这一个）都被吊销了
    expect(fresh).not.toBe(session);
  });

  it('旧会话在改口令后立即失效，新会话可用', async () => {
    /*
     * 这是改口令唯一真正重要的断言。只改哈希不动会话的实现同样会返回 204，
     * 而用户改口令通常正是因为怀疑口令外泄 —— 对方手上那个会话
     * 30 天滑动过期，只要他还在用就永不过期。
     */
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);

    const res = await change(app, session, { current_password: OLD, new_password: NEW });
    const fresh = setCookieValue(res.headers, COOKIE_NAMES.session);

    const withOld = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${COOKIE_NAMES.session}=${session}` },
      payload: { current_password: NEW, new_password: 'yet-another-long-passphrase' },
    });
    expect(withOld.statusCode).toBe(401);

    const withNew = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `${COOKIE_NAMES.session}=${fresh as string}` },
    });
    expect(withNew.statusCode).toBe(200);
    expect(withNew.json<{ user_type: string }>().user_type).toBe('REGISTERED');
  });

  it('改完之后新口令能登录、旧口令不能', async () => {
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);
    await change(app, session, { current_password: OLD, new_password: NEW });

    const withNew = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'user@example.com', password: NEW },
    });
    expect(withNew.statusCode).toBe(200);

    const withOld = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'user@example.com', password: OLD },
    });
    expect(withOld.statusCode).toBe(401);
  });

  it('旧口令错返回 400 AUTH_CURRENT_PASSWORD_INVALID，field 指向 current_password', async () => {
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);

    const res = await change(app, session, {
      current_password: 'not-the-current-one',
      new_password: NEW,
    });

    /*
     * 400 而不是 401：401 在前端有全局含义（会话失效 → 重新解析身份），
     * 用它表示「输错一个字」会把笔误当成掉线处理。
     */
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; field?: string } }>();
    expect(body.error.code).toBe('AUTH_CURRENT_PASSWORD_INVALID');
    expect(body.error.field).toBe('current_password');
  });

  it('新口令太弱返回 400 AUTH_PASSWORD_TOO_WEAK，field 指向 new_password', async () => {
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);

    const res = await change(app, session, { current_password: OLD, new_password: 'short' });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; field?: string } }>();
    expect(body.error.code).toBe('AUTH_PASSWORD_TOO_WEAK');
    expect(body.error.field).toBe('new_password');
  });

  it('旧口令错时不先报新口令太弱（校验顺序不泄漏旧口令是否正确）', async () => {
    /*
     * 若强度校验排在验证旧口令之前，不知道旧口令的人就能拿两种不同的响应
     * 当作预言机：弱新口令 + 猜的旧口令回 PASSWORD_TOO_WEAK 说明旧口令
     * 还没验到，回 CURRENT_PASSWORD_INVALID 说明……顺序本身泄漏了信息。
     */
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);

    const res = await change(app, session, {
      current_password: 'not-the-current-one',
      new_password: 'short',
    });

    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_CURRENT_PASSWORD_INVALID',
    );
  });

  it('口令连续错到上限返回 429（与登录共用计数器）', async () => {
    const harness = makeApp(quotaConfig({ emailLoginFailuresPerHour: 2 }));
    app = harness.app;
    const session = await registerUser(app);

    for (let i = 0; i < 2; i += 1) {
      const res = await change(app, session, { current_password: `wrong-${i}`, new_password: NEW });
      expect(res.statusCode).toBe(400);
    }

    const locked = await change(app, session, { current_password: 'wrong-x', new_password: NEW });
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe('AUTH_RATE_LIMITED');
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('缺字段返回 400 REQ_SCHEMA_INVALID', async () => {
    const harness = makeApp();
    app = harness.app;
    const session = await registerUser(app);

    const res = await change(app, session, { current_password: OLD });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('REQ_SCHEMA_INVALID');
  });
});

describe('账号级端点拦截匿名身份（13.0、TP-1-37）', () => {
  it('匿名身份访问改口令端点返回 403 AUTH_ANONYMOUS_FORBIDDEN', async () => {
    const harness = makeApp();
    app = harness.app;

    const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const anonToken = setCookieValue(session.headers, COOKIE_NAMES.anonymous);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${COOKIE_NAMES.anonymous}=${anonToken as string}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_ANONYMOUS_FORBIDDEN');
  });

  it('无身份访问账号级端点返回 401（不现场建号）', async () => {
    const harness = makeApp();
    app = harness.app;

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password' });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AUTH_IDENTITY_REQUIRED');
  });
});

describe('Cookie 解析', () => {
  it('解析多个 Cookie', () => {
    expect(parseCookies('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('URL 解码值', () => {
    expect(parseCookies('t=a%2Fb%3Dc')).toEqual({ t: 'a/b=c' });
  });

  it('值中含等号时只按第一个等号切分（Base64URL 不含 = 但仍需健壮）', () => {
    expect(parseCookies('t=abc=def')).toEqual({ t: 'abc=def' });
  });

  it('空头与畸形项不崩溃', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('=novalue; ; valid=1')).toEqual({ valid: '1' });
  });
});

// ── P7：匿名入口关闭后的端点行为 ──────────────────────────

describe('P7 匿名入口关闭（端点层）', () => {
  it('GET /auth/session 返回 401 而不是自动建号', async () => {
    /*
     * 这是 13.0 第 3.a 条反转后最直接可见的一处：会话端点原本是匿名号的
     * **唯一签发入口**（前端一进页面就调它）。
     *
     * 返回 401 而不是 200 + `{authenticated:false}`：13.0 的错误体是统一
     * 契约，为「未登录」单开一种成功响应会让客户端多一条分支，而它要做的事
     * （引导注册）与拿到 401 时完全一样。
     */
    const h = makeApp(quotaConfig(), { anonymousEnabled: false });

    const response = await h.app.inject({ method: 'GET', url: '/api/v1/auth/session' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('AUTH_IDENTITY_REQUIRED');
    // 关键：一个匿名号都没建
    expect(h.users.count()).toBe(0);
  });

  it('GET /auth/session 不下发 tp_anon', async () => {
    const h = makeApp(quotaConfig(), { anonymousEnabled: false });

    const response = await h.app.inject({ method: 'GET', url: '/api/v1/auth/session' });

    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
    expect(list.filter((c) => c.startsWith(`${COOKIE_NAMES.anonymous}=`))).toEqual([]);
  });

  it('带着存量 tp_anon 访问时被拒，且响应清除该 Cookie', async () => {
    /*
     * 存量匿名用户的浏览器里还有 tp_anon。不清的话它每次请求都白带一次、
     * 服务端每次都要查一遍库再拒，而浏览器永远处在「带着一个不被接受的
     * 凭据」的状态。
     *
     * 先用打开态签一个真实令牌，再换成关闭态的应用（共用同一仓储）——
     * 这正是「开关关闭后存量用户再来」的形状。
     */
    const open = makeApp();
    const issued = await open.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const anonValue = setCookieValue(issued.headers, COOKIE_NAMES.anonymous);
    expect(anonValue).toBeTruthy();
    const anonCookie = `${COOKIE_NAMES.anonymous}=${anonValue ?? ''}`;

    const shut = makeApp(quotaConfig(), { anonymousEnabled: false });
    const response = await shut.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: anonCookie },
    });

    expect(response.statusCode).toBe(401);

    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
    const cleared = list.find((c) => c.startsWith(`${COOKIE_NAMES.anonymous}=`));
    expect(cleared, '应下发一条清除 tp_anon 的 Set-Cookie').toBeDefined();
    expect(cleared).toContain('Max-Age=0');
  });

  it('注册不带 tp_anon 也能成功（关闭匿名后唯一的入口）', async () => {
    const h = makeApp(quotaConfig(), { anonymousEnabled: false });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'registered-only@example.com',
        password: 'a-sufficiently-long-passphrase-1',
      },
    });

    expect(response.statusCode).toBe(201);
    // 13.9.1 的响应体是扁平的 SessionResponse，没有 user 包装
    expect(response.json<{ user_type: string }>().user_type).toBe('REGISTERED');
  });

  it('注册时携带 tp_anon 不再原地升级，而是新建账号', async () => {
    /*
     * 与 resolve() 分支 4 的口径一致：存量匿名数据走保留期清理，
     * 不留一条把它接到新账号上的路。半开状态（新号建不了但旧号能升级）
     * 的问题是那条路径此后再没有真实流量走过。
     */
    const open = makeApp();
    const issued = await open.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const anonCookie = `${COOKIE_NAMES.anonymous}=${setCookieValue(issued.headers, COOKIE_NAMES.anonymous) ?? ''}`;
    const anonCountBefore = open.users.count();
    expect(anonCountBefore).toBe(1);

    const response = await open.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { cookie: anonCookie },
      payload: {
        email: 'no-upgrade@example.com',
        password: 'a-sufficiently-long-passphrase-1',
      },
    });
    expect(response.statusCode).toBe(201);
    // 打开态：原地升级，行数不变
    expect(open.users.count()).toBe(1);

    // 关闭态：同样的请求应当新建一行
    const shut = makeApp(quotaConfig(), { anonymousEnabled: false });
    const seeded = makeApp();
    const seededSession = await seeded.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const seededAnon = `${COOKIE_NAMES.anonymous}=${setCookieValue(seededSession.headers, COOKIE_NAMES.anonymous) ?? ''}`;
    const shutResponse = await shut.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { cookie: seededAnon },
      payload: {
        email: 'fresh-account@example.com',
        password: 'a-sufficiently-long-passphrase-1',
      },
    });

    expect(shutResponse.statusCode).toBe(201);
    /*
     * shut 的仓储原本是空的，注册后只有这一个新建的注册账号。
     *
     * 「有没有原地升级」只能靠行数判断 —— 13.9.1 的响应体里没有 upgraded
     * 字段（那是 IdentityService 的内部结局，只用于选 upgrade / register
     * 两个指标事件）。这也是为什么打开态那一半要断言「行数不变」：
     * 两个断言合起来才区分得出「升级」与「新建」。
     */
    expect(shut.users.count()).toBe(1);
  });
});
