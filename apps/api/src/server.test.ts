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
