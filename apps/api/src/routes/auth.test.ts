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
    ip: { anonCreatePerHour: 5, anonCreatePerDay: 20, plansPerDay: 10, loginFailuresPerHour: 10 },
    emailLoginFailuresPerHour: 5,
    anonTokenTtlDays: 30,
    ...overrides,
  };
}

function makeApp(config: QuotaConfig = quotaConfig()) {
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
