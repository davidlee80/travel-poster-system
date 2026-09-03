import { afterEach, describe, expect, it } from 'vitest';
import { GracefulShutdown, createSilentLogger, type ServiceConfig } from '@tps/shared';
import { buildServer } from './server.js';

const silentLogger = createSilentLogger();

const config: ServiceConfig = {
  serviceName: 'tps-api-test',
  nodeEnv: 'test',
  logLevel: 'silent',
  port: 0,
  shutdownTimeoutMs: 1000,
};

function makeShutdown(): GracefulShutdown {
  return new GracefulShutdown({
    logger: silentLogger,
    exit: () => {
      throw new Error('__exit__');
    },
  });
}

let app: ReturnType<typeof buildServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('API 探针', () => {
  it('/healthz 返回 200 live', async () => {
    app = buildServer({ config, logger: silentLogger, shutdown: makeShutdown() });

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'live' });
  });

  it('/readyz 在正常状态返回 200 ready', async () => {
    app = buildServer({ config, logger: silentLogger, shutdown: makeShutdown() });

    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready' });
  });

  it('排空期间 /readyz 返回 503，负载均衡据此摘除实例', async () => {
    const shutdown = makeShutdown();
    app = buildServer({ config, logger: silentLogger, shutdown });

    // 触发排空（exit 被替换为抛错，捕获后继续断言状态）
    await shutdown.shutdown('test').catch(() => undefined);

    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'draining', reason_code: 'SHUTTING_DOWN' });
  });

  it('排空期间 /healthz 仍返回 200（否则会被 SIGKILL 打断优雅停机）', async () => {
    const shutdown = makeShutdown();
    app = buildServer({ config, logger: silentLogger, shutdown });

    await shutdown.shutdown('test').catch(() => undefined);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('依赖不可用时 /readyz 返回 503 与结构化原因', async () => {
    app = buildServer({
      config,
      logger: silentLogger,
      shutdown: makeShutdown(),
      checkDependencies: () =>
        Promise.resolve({ ok: false, detail: { postgres: false, redis: true } }),
    });

    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      reason_code: 'SYS_DEPENDENCY_UNAVAILABLE',
      detail: { postgres: false, redis: true },
    });
  });

  it('/metrics 以 Prometheus 文本格式暴露', async () => {
    app = buildServer({ config, logger: silentLogger, shutdown: makeShutdown() });

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('21.3 的 request_id（TP-5-02）', () => {
  it('透传 X-Request-Id 请求头', async () => {
    app = buildServer({ config, logger: silentLogger, shutdown: makeShutdown() });

    /*
     * 网关或前端给的 ID 必须被沿用，否则同一次请求在网关日志与本服务日志里
     * 是两个不同的 ID —— 而跨服务追一次请求正是这个字段的用途。
     */
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'gateway-abc-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('gateway-abc-123');
  });

  it('没有请求头时生成的 ID 每次不同（不是递增序号）', async () => {
    app = buildServer({ config, logger: silentLogger, shutdown: makeShutdown() });

    const first = await app.inject({ method: 'GET', url: '/healthz' });
    const second = await app.inject({ method: 'GET', url: '/healthz' });

    const a = String(first.headers['x-request-id']);
    const b = String(second.headers['x-request-id']);

    expect(a).not.toBe(b);
    /*
     * 必须是 UUID 而不是 `req-1`：递增序号在多副本下必然重复，
     * 三个实例各自从 req-1 开始，日志里同一个 request_id 会命中三条
     * 毫不相关的请求。
     */
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/**
 * 传输层每-IP 限流。
 *
 * 它填的是 `QuotaGuard` 接不到的那一段：业务配额在身份解析**之后**判定，
 * 而身份解析本身就要查 Redis 与数据库 —— 不带有效 Cookie 的洪水根本走不到
 * 配额那一层，却已经把依赖打满了。
 */
describe('每-IP 限流', () => {
  /**
   * 限流只对**已匹配的路由**生效（Fastify 的 onRequest 钩子不跑 404 路径）。
   *
   * 因此用一个真存在的业务路由来验：`/api/v1/planner/config` 只需一个
   * 单方法仓储桩。拿 404 路径去验会得到一个永远绿的断言 ——
   * 而那正好会掩盖掉「限流根本没生效」这个失效。
   */
  const LIMITED_URL = '/api/v1/planner/config';

  /** 用一个极小的阈值把行为露出来，而不是发 300 个请求 */
  function tinyLimit(max = 2) {
    return buildServer({
      config,
      logger: silentLogger,
      shutdown: makeShutdown(),
      plannerConfig: { config: { getPublished: () => Promise.resolve(null) } },
      rateLimit: { max, timeWindowMs: 60_000 },
    });
  }

  it('超阈后返回 429 与 13.7 形态的错误体', async () => {
    app = tinyLimit(2);

    /* 前两次在阈值内：没发布配置时该路由返 503，不是 429 */
    expect((await app.inject({ method: 'GET', url: LIMITED_URL })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: LIMITED_URL })).statusCode).toBe(503);

    const limited = await app.inject({ method: 'GET', url: LIMITED_URL });

    expect(limited.statusCode).toBe(429);
    /*
     * 必须是 13.0 的信封。插件自带的体是 `{statusCode, error, message}`，
     * 而前端的错误处理读 `error.code` —— 拿到没有那个字段的体会
     * 掉进「未知错误」分支，用户看到的不是「请稍后再试」。
     */
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('SYS_RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('429 响应仍带 x-request-id', async () => {
    /*
     * 限流插件的钩子必须排在 request_id 钩子**之后**。反过来的表现是
     * 被限流拦住的请求没有这个头 —— 而它们恰好是最可能被用户报障的
     * 那批，而客服靠这个 ID 在日志里定位请求。
     */
    app = tinyLimit(1);

    await app.inject({ method: 'GET', url: LIMITED_URL });
    const limited = await app.inject({ method: 'GET', url: LIMITED_URL });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['x-request-id']).toBeDefined();
  });

  it('探针与 /metrics 豁免', async () => {
    /*
     * 不豁免的后果：K8s 的存活探针被限流打成 429 → 实例被重启；
     * Prometheus 被拦 → 监控断掉，而此时恰好是最需要监控的时候。
     */
    app = tinyLimit(1);

    for (const url of ['/healthz', '/readyz', '/metrics']) {
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${url} 第 ${i + 1} 次被限流`).not.toBe(429);
      }
    }
  });

  it('max 为 0 时不注册限流', async () => {
    /* 给需要发大量请求的用例一个出口，而不是让它们去猜阈值够不够大 */
    app = tinyLimit(0);

    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ method: 'GET', url: LIMITED_URL });
      expect(res.statusCode).toBe(503);
    }
  });
});
