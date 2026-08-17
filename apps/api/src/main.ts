import {
  GracefulShutdown,
  QuotaGuard,
  createLogger,
  loadQuotaConfig,
  loadServiceConfig,
  nodeEnv,
  optionalBool,
  optionalString,
  requireString,
} from '@tps/shared';
import { registerDefaultMetrics } from '@tps/observability';
import {
  checkDatabase,
  createExportsRepository,
  createPool,
  createPresentationsRepository,
  createTravelPlansRepository,
  createUsersRepository,
  loadDbConfig,
} from '@tps/db';
import {
  BullMqExportQueue,
  BullMqPlanQueue,
  RedisCounterStore,
  RedisIdempotencyLock,
  createQueueRedis,
  createRedis,
} from '@tps/queue';
import { S3ExportStorage, loadExportsStorageConfig } from '@tps/storage';
import { IdentityService } from './identity/service.js';
import { RedisSessionStore } from './identity/redis-session-store.js';
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
   * P2：会话、配额计数、幂等锁、队列全部走 Redis。
   *
   * `REDIS_URL` 是**必填**，没有内存兜底。兜底的诱惑很大（本地少起一个容器），
   * 但它的失效方式是静默的：多实例下会话存内存 → 随机登出，
   * 计数存内存 → 配额按实例各算一份（3 个实例等于 3 倍额度），
   * 幂等锁存内存 → 同键并发落到不同实例时都能抢到锁。
   * 三者都不会报错，只会「偶尔行为不对」。启动就失败要好得多。
   */
  const redisUrl = requireString('REDIS_URL');
  const redis = createRedis(redisUrl);
  const queueRedis = createQueueRedis(redisUrl);
  shutdown.register('redis', async () => {
    await redis.quit();
    await queueRedis.quit();
  });

  const sessions = new RedisSessionStore(redis);
  const counters = new RedisCounterStore(redis);
  const queue = new BullMqPlanQueue(queueRedis);
  shutdown.register('plan-queue', async () => {
    await queue.close();
  });

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

  /*
   * 内部端点的共享密钥。未配置则不注册那些路由 ——
   * 少一个默认密钥就少一个「忘了改默认值」的事故。
   */
  const rawInternalKey = optionalString('INTERNAL_API_KEY', '');
  const internalApiKey = rawInternalKey.length === 0 ? undefined : rawInternalKey;

  const app = buildServer({
    config,
    logger,
    shutdown,
    auth: {
      identity,
      quota,
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
    },
    travelPlans: {
      identity,
      quota,
      queue,
      plans: createTravelPlansRepository(pool),
      presentations: createPresentationsRepository(pool),
      idempotencyLock: new RedisIdempotencyLock(redis),
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
      now: () => new Date(),
    },
    /*
     * 13.5/13.6 的导出端点。
     *
     * 对象存储只用于**预签名**（一次本地 HMAC 计算），因此这个进程的 S3 凭据
     * 只需要导出桶的 GetObject 权限 —— 类型上已经收窄到 `presign`
     * （见 routes/exports.ts）。
     */
    exports: {
      identity,
      quota,
      plans: createTravelPlansRepository(pool),
      exports: createExportsRepository(pool),
      queue: new BullMqExportQueue(queueRedis),
      storage: new S3ExportStorage(loadExportsStorageConfig()),
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
    },
    /*
     * 14.1/14.2 的内部端点：只在配置了共享密钥时注册。
     * 它们做 CPU 与数据库工作，挂在公网服务上必须有认证
     * （见 routes/internal-assets.ts）。
     */
    ...(internalApiKey === undefined
      ? {}
      : {
          internalAssets: { internalApiKey },
          internalPresentations: {
            internalApiKey,
            presentations: createPresentationsRepository(pool),
          },
        }),
    checkDependencies: async () => {
      const detail = { postgres: false, redis: false };
      try {
        detail.postgres = (await checkDatabase(pool)).ok;
      } catch {
        detail.postgres = false;
      }
      try {
        detail.redis = (await redis.ping()) === 'PONG';
      } catch {
        detail.redis = false;
      }
      return { ok: detail.postgres && detail.redis, detail };
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
      session_store: 'redis',
    },
    'API 已启动',
  );
}

main().catch((err: unknown) => {
  // 启动失败时 logger 可能还没建好，直接写 stderr
  process.stderr.write(`API 启动失败: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
