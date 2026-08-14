import {
  GracefulShutdown,
  QuotaGuard,
  createLogger,
  loadQuotaConfig,
  loadServiceConfig,
  nodeEnv,
  optionalBool,
  InMemoryCounterStore,
} from '@tps/shared';
import { registerDefaultMetrics } from '@tps/observability';
import { checkDatabase, createPool, createUsersRepository, loadDbConfig } from '@tps/db';
import { IdentityService } from './identity/service.js';
import { InMemorySessionStore } from './identity/session-store.js';
import { buildServer } from './server.js';

const SERVICE_NAME = 'tps-api';

async function main(): Promise<void> {
  const config = loadServiceConfig(SERVICE_NAME, 3001);
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.logLevel,
    pretty: nodeEnv() === 'development',
  });

  registerDefaultMetrics(SERVICE_NAME);

  // 配额配置在启动时校验不变式，不合法直接拒绝启动（21.4）——
  // 带着错误配额上线的表现是「部分用户莫名被限流」，极难从工单定位
  const quotaConfig = loadQuotaConfig();

  const shutdown = new GracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  }).listen();

  const pool = createPool(loadDbConfig());
  // 先注册基础设施：关闭时它会最后被停，保证上层组件仍能用连接收尾
  shutdown.register('database-pool', async () => {
    await pool.end();
  });

  /*
   * P1 使用进程内的会话与计数存储。
   *
   * 两者都是**多实例不安全**的：会话存内存会导致负载均衡下随机登出，
   * 计数存内存会导致配额按实例各算一份。Redis 实现在 P2 随队列一起接入
   * （TP-2-08 的幂等锁同样需要 Redis），届时只需替换这两处的实现。
   *
   * 现在就用内存实现而不是等 Redis：身份链路的正确性可以先在单实例下
   * 验证完，避免把「身份逻辑对不对」与「Redis 接得对不对」两个问题耦合在
   * 一起排查。
   */
  const sessions = new InMemorySessionStore();
  const counters = new InMemoryCounterStore();

  const quota = new QuotaGuard({ config: quotaConfig, store: counters, now: () => new Date() });

  const identity = new IdentityService({
    users: createUsersRepository(pool),
    sessions,
    quota,
    quotaConfig,
    now: () => new Date(),
    // 生产必须为 true；本地 http://localhost 下浏览器不会保存 Secure Cookie
    secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
  });

  const app = buildServer({
    config,
    logger,
    shutdown,
    auth: {
      identity,
      quota,
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
    },
    checkDependencies: async () => {
      try {
        const db = await checkDatabase(pool);
        return { ok: db.ok, detail: { postgres: db.ok } };
      } catch {
        return { ok: false, detail: { postgres: false } };
      }
    },
  });

  // HTTP 服务后注册 → 关闭时先停，保证连接池在还有请求在处理时不被断开
  shutdown.register('http-server', async () => {
    await app.close();
  });

  // 0.0.0.0 而非 localhost：容器内必须监听所有接口才能被外部访问
  await app.listen({ host: '0.0.0.0', port: config.port });

  logger.info(
    {
      port: config.port,
      node_env: config.nodeEnv,
      node_version: process.versions.node,
      tz: process.env['TZ'] ?? '(未设置)',
      anon_daily_quota: quotaConfig.anonymous.dailyPlans,
      registered_daily_quota: quotaConfig.registered.dailyPlans,
      ip_daily_quota: quotaConfig.ip.plansPerDay,
      session_store: 'in-memory (P1)',
    },
    'API 已启动',
  );
}

main().catch((err: unknown) => {
  // 启动失败时 logger 可能还没建好，直接写 stderr
  process.stderr.write(`API 启动失败: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
