import {
  GracefulShutdown,
  QuotaGuard,
  createLogger,
  loadFeatureFlags,
  loadQuotaConfig,
  loadServiceConfig,
  nodeEnv,
  optionalBool,
  optionalString,
  requireString,
} from '@tps/shared';
import { loadTracingConfig, registerDefaultMetrics, startTracing } from '@tps/observability';
import { loadCreditConfig, loadJobLimits } from '@tps/billing';
import {
  checkDatabase,
  createCreditWalletRepository,
  createExportsRepository,
  createPool,
  createPresentationsRepository,
  createPlannerConfigRepository,
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
import {
  AliyunSmsSender,
  LocalSmsSender,
  PhoneVerificationService,
} from './identity/phone-verification.js';
import { RedisSessionStore } from './identity/redis-session-store.js';
import { CreditsService } from './credits/service.js';
import { startQueueDepthSampler } from './queue-depth.js';
import { buildServer } from './server.js';

const SERVICE_NAME = 'tps-api';

async function main(): Promise<void> {
  /*
   * Trace 装配必须在**任何被 instrument 的模块被使用之前**（TP-5-03）。
   *
   * OTel 靠改写模块导出实现自动埋点，而 `pg` / `ioredis` / `http` 在这里
   * 已经被 import（ESM 的 import 提升到模块顶部）—— 但 instrumentation 挂钩的是
   * **调用**而不是 import，因此在建连接池之前 start 就足够。
   * 未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时返回 null，全程保持 no-op。
   */
  const tracing = startTracing(loadTracingConfig(SERVICE_NAME));

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

  /*
   * 灰度开关（TP-5-10）。放量比例越界同样是拒绝启动 ——
   * 把 1000 误当千分比写进 values 的人会得到「全量放量」，那是一次静默的
   * 全量上线（见 loadFeatureFlags）。
   */
  const featureFlags = loadFeatureFlags();
  logger.info(
    {
      generation_enabled: featureFlags.generationEnabled,
      export_enabled: featureFlags.exportEnabled,
      rollout_percent: featureFlags.generationRolloutPercent,
    },
    '灰度开关已加载',
  );

  const shutdown = new GracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  }).listen();

  /*
   * 最先注册 ⇒ 最后关闭（hook 按逆序执行）。
   * 不 flush 会丢掉最后一批 span —— 而那一批恰好是停机前那几个请求，
   * 滚动更新期间的问题就出在那里。
   */
  if (tracing !== null) {
    shutdown.register('tracing', () => tracing.shutdown());
  }

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

  /*
   * 提升为具名常量（原先在 exports 那一块内联 new）：队列深度采样器也要用它，
   * 而两个独立实例会各自持一份 BullMQ 的连接与事件监听。
   */
  const exportQueue = new BullMqExportQueue(queueRedis);
  shutdown.register('export-queue', async () => {
    await exportQueue.close();
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
    /*
     * P7：与生成/导出两个开关同源（`loadFeatureFlags`），因此「一次放量只改
     * 一节配置」这条对它同样成立。默认 false —— 见 FeatureFlags 上的说明。
     */
    anonymousEnabled: featureFlags.anonymousEnabled,
  });

  const smsMode = optionalString('SMS_MODE', 'local').toLowerCase();
  const smsSender =
    smsMode === 'aliyun'
      ? new AliyunSmsSender({
          accessKeyId: requireString('ALIBABA_CLOUD_ACCESS_KEY_ID'),
          accessKeySecret: requireString('ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
          signName: requireString('ALIYUN_SMS_SIGN_NAME'),
          templateCode: requireString('ALIYUN_SMS_TEMPLATE_CODE'),
        })
      : new LocalSmsSender();
  const phoneVerification = new PhoneVerificationService(redis, smsSender, {
    pepper: optionalString('SMS_VERIFICATION_PEPPER', 'local-development-only'),
    exposeDevCode: smsMode === 'local',
  });
  const plannerConfig = createPlannerConfigRepository(pool);

  /*
   * ── CR 计费（C-3）──
   *
   * 默认**关闭**，而这不是保守而已：钱包与价目表在迁移 0013 才建立，
   * 而应用与数据库的部署不是原子的。装配了却没迁移的后果是每个生成请求、
   * 每次会话查询都撞「relation credit_wallets does not exist」——
   * 也就是全站不可用，而根因在一张不存在的表上。
   *
   * 打开顺序必须是：先 `pnpm db:migrate` 到 0013，再把这个开关置 true。
   * 关闭时 `credits` 为 undefined，三个端点不注册、生成与导出完全不计费
   * （见各路由的 `credits?` 字段）。
   */
  const billingEnabled = optionalBool('CREDIT_BILLING_ENABLED', false);
  const credits = billingEnabled
    ? new CreditsService({
        wallet: createCreditWalletRepository(pool),
        config: loadCreditConfig(),
        limits: loadJobLimits(),
        logger,
        now: () => new Date(),
      })
    : undefined;

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
      phoneVerification,
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
      ...(credits === undefined ? {} : { credits }),
    },
    travelPlans: {
      identity,
      quota,
      queue,
      plans: createTravelPlansRepository(pool),
      presentations: createPresentationsRepository(pool),
      idempotencyLock: new RedisIdempotencyLock(redis),
      featureFlags,
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
      now: () => new Date(),
      plannerConfig,
      ...(credits === undefined ? {} : { credits }),
    },
    plannerConfig: { config: plannerConfig },
    ...(credits === undefined
      ? {}
      : {
          credits: {
            identity,
            credits,
            secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
          },
        }),
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
      // 只用于校验请求里的样式套件真有展示数据（R-85）
      presentations: createPresentationsRepository(pool),
      queue: exportQueue,
      storage: new S3ExportStorage(loadExportsStorageConfig()),
      featureFlags,
      secureCookies: optionalBool('COOKIE_SECURE', config.nodeEnv === 'production'),
      ...(credits === undefined ? {} : { credits }),
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

  /*
   * 队列积压的先行指标（见 queue-depth.ts）。
   *
   * 放在 listen 之前起：它不依赖 HTTP，而先起能保证第一次抓取就能拿到值。
   */
  const stopQueueDepthSampler = startQueueDepthSampler({
    plan: queue,
    export: exportQueue,
    logger,
  });
  shutdown.register('queue-depth-sampler', () => {
    stopQueueDepthSampler();
    return Promise.resolve();
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
      /* 关闭时生成与导出完全不计费 —— 这条必须能从启动日志里一眼看到 */
      credit_billing_enabled: billingEnabled,
    },
    'API 已启动',
  );
}

main().catch((err: unknown) => {
  // 启动失败时 logger 可能还没建好，直接写 stderr
  process.stderr.write(`API 启动失败: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
