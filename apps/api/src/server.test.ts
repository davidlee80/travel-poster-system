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
