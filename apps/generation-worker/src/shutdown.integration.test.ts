import { IdentityService, RedisSessionStore } from '@tps/api/identity';
import { buildServer } from '@tps/api/server';
import {
  createPool,
  createPresentationsRepository,
  createTravelPlansRepository,
  createUsersRepository,
  migrate,
  migrationsDirectory,
} from '@tps/db';
import {
  BullMqPlanQueue,
  PLAN_QUEUE_NAME,
  RedisCounterStore,
  RedisIdempotencyLock,
  createQueueRedis,
  createRedis,
} from '@tps/queue';
import {
  COOKIE_NAMES,
  GracefulShutdown,
  QuotaGuard,
  createSilentLogger,
  loadQuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import { Queue } from 'bullmq';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * L-10 / 门禁 #34：优雅停机的端到端验证（TP-5-13，设计稿 22.3.3）。
 *
 * ```text
 * 通过线：生成中的任务收到 SIGTERM 后不留悬挂状态，
 *         进程 30 秒内退出，重启后任务可被重新消费或明确失败
 * ```
 *
 * ## 为什么只在 Linux 上跑
 *
 * Windows 没有 POSIX 信号。Node 的 `child.kill('SIGTERM')` 在 Windows 上映射
 * 到 `TerminateProcess` —— 进程被**强杀**，`process.on('SIGTERM')` 永远不会
 * 执行。也就是说这个测试在 Windows 上要么必然失败，要么（如果放宽断言）
 * 什么都没验证到。
 *
 * 这正是 22.3.4 把 L-10 列为「CI 必须在 Linux 上验证」的原因，
 * 也是实施计划 3.1 原则四的字面含义：本地跑通不算通过。
 * 因此本机（Windows / macOS）跳过，CI 的 ubuntu-latest 上真的执行。
 *
 * ## 为什么要起真实子进程
 *
 * 进程内构造一个 `GracefulShutdown` 并调用它，验证的是那个类的逻辑 ——
 * 而那已经有单测。这里要验证的是**装配**：信号监听有没有真的挂上、
 * 关闭钩子的注册顺序对不对、BullMQ 的 `close()` 是否真的等在途任务结束。
 * 这三件事只有一个真的收到信号的真进程能回答。
 */

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

const canRun = databaseUrl !== undefined && redisUrl !== undefined && process.platform === 'linux';
const describeShutdown = canRun ? describe : describe.skip;

/** 22.3.3：从收到信号到强制退出的总预算。K8s 侧的宽限期必须大于它 */
const SHUTDOWN_BUDGET_MS = 30_000;

const workerEntry = join(dirname(fileURLToPath(import.meta.url)), '../dist/main.js');

const serviceConfig: ServiceConfig = {
  serviceName: 'tps-api-shutdown',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

describeShutdown('L-10 / 门禁 #34：优雅停机（集成，仅 Linux）', () => {
  let pool: Pool;
  let redis: Redis;
  let queueRedis: Redis;
  let app: ReturnType<typeof buildServer>;
  let queue: BullMqPlanQueue;
  let rawQueue: Queue;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 6,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());

    redis = createRedis(redisUrl as string);
    queueRedis = createQueueRedis(redisUrl as string);
    /*
     * 用**生产队列名**：子进程是真实的 main.js，它读的是 PLAN_QUEUE_NAME。
     * 因此测试前后都要清空 —— 否则本机开发中残留的消息会被这个 worker 消费。
     */
    queue = new BullMqPlanQueue(queueRedis, PLAN_QUEUE_NAME);
    rawQueue = new Queue(PLAN_QUEUE_NAME, { connection: queueRedis });
    await rawQueue.obliterate({ force: true }).catch(() => undefined);

    const quotaConfig = loadQuotaConfig();
    const quota = new QuotaGuard({
      config: quotaConfig,
      store: new RedisCounterStore(redis),
      now: () => new Date(),
    });
    const identity = new IdentityService({
      users: createUsersRepository(pool),
      sessions: new RedisSessionStore(redis),
      quota,
      quotaConfig,
      now: () => new Date(),
      secureCookies: false,
    });

    app = buildServer({
      config: serviceConfig,
      logger: createSilentLogger(),
      shutdown: new GracefulShutdown({ logger: createSilentLogger(), timeoutMs: 1_000 }),
      auth: { identity, quota, secureCookies: false },
      travelPlans: {
        identity,
        quota,
        queue,
        plans: createTravelPlansRepository(pool),
        presentations: createPresentationsRepository(pool),
        idempotencyLock: new RedisIdempotencyLock(redis),
        secureCookies: false,
        now: () => new Date(),
      },
    });
  });

  afterEach(async () => {
    if (child !== null && child.exitCode === null) {
      child.kill('SIGKILL');
      child = null;
    }
    await rawQueue.obliterate({ force: true }).catch(() => undefined);
    await pool.query('DELETE FROM users');
    await redis.flushdb();
  });

  afterAll(async () => {
    await app.close();
    await queue.close();
    await rawQueue.close();
    await redis.quit();
    await queueRedis.quit();
    await pool.end();
  });

  /** 起一个真实的 generation-worker 子进程，等到就绪探针返回 200 */
  async function startWorker(probePort: number): Promise<ChildProcess> {
    const process_ = spawn(process.execPath, [workerEntry], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        PROBE_PORT: String(probePort),
        LLM_MODE: 'fake',
        IMAGE_MODE: 'fake',
        /*
         * 假的 S3 端点：`S3ObjectStorage` 的构造只读配置，不连接。
         * 素材上传会失败，但那是**非阻断**的（16.3），任务照样能走完 ——
         * 而这个测试关心的是停机，不是素材。
         */
        S3_ENDPOINT: 'http://127.0.0.1:19000',
        S3_ACCESS_KEY_ID: 'shutdown-test',
        S3_SECRET_ACCESS_KEY: 'shutdown-test',
        S3_BUCKET_ASSETS: 'assets',
        S3_PUBLIC_BASE_URL: 'http://127.0.0.1:19000/assets',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (process_.exitCode !== null) {
        throw new Error(`Worker 启动即退出，退出码 ${process_.exitCode}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${probePort}/readyz`);
        if (response.status === 200) return process_;
      } catch {
        // 还没起来
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Worker 在 20 秒内未就绪');
  }

  /** 提交一个真实任务，返回 job_id */
  async function submit(): Promise<string> {
    const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    const raw = session.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const entry = list.find((item) => item.startsWith(`${COOKIE_NAMES.anonymous}=`))!;
    const cookie = `${COOKIE_NAMES.anonymous}=${entry.slice(COOKIE_NAMES.anonymous.length + 1).split(';')[0] ?? ''}`;

    const start = new Date(Date.now() + 86_400_000);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: {
        schema_version: 'travel_request_ui_v1',
        client_request_id: `shutdown-${Math.random().toString(36).slice(2)}`,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        trip: {
          origin: { text: '上海' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: {
            start_date: start.toISOString().slice(0, 10),
            end_date: new Date(start.getTime() + 13 * 86_400_000).toISOString().slice(0, 10),
            flexibility_days: 0,
          },
        },
        travelers: { adults: 2, children: [], seniors: [] },
        budget: {
          currency: 'CNY',
          basis: 'PER_PERSON_PER_DAY',
          min: 200,
          max: 600,
          included_items: ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'],
        },
        pace: { level: 'BALANCED' },
        conditions: [],
        custom_requirements: { raw_text: '停机测试' },
        output_preferences: {
          language: 'zh-CN',
          template_id: 'travel_infographic_v1',
          generate_png: false,
          generate_pdf: false,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<{ job_id: string }>().job_id;
  }

  function jobStatus(jobId: string): Promise<string> {
    return pool
      .query<{ status: string }>('SELECT status FROM generation_jobs WHERE id = $1', [jobId])
      .then((result) => result.rows[0]?.status ?? 'MISSING');
  }

  /** 等到状态满足条件，超时返回最后看到的状态 */
  async function waitForStatus(
    jobId: string,
    predicate: (status: string) => boolean,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = await jobStatus(jobId);
    while (Date.now() < deadline && !predicate(last)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      last = await jobStatus(jobId);
    }
    return last;
  }

  function waitForExit(process_: ChildProcess): Promise<{ code: number | null; ms: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
      process_.once('exit', (code) => resolve({ code, ms: Date.now() - started }));
    });
  }

  it('空闲 Worker 收到 SIGTERM 后在预算内以 0 退出', async () => {
    child = await startWorker(3211);

    const exited = waitForExit(child);
    child.kill('SIGTERM');
    const { code, ms } = await exited;

    /*
     * 退出码必须是 0。非零会被 K8s 记成崩溃，进而触发重启计数与
     * CrashLoopBackOff —— 而这只是一次正常的滚动更新。
     */
    expect(code).toBe(0);
    expect(ms).toBeLessThan(SHUTDOWN_BUDGET_MS);
    child = null;
  }, 60_000);

  it('生成中的任务收到 SIGTERM 后不留悬挂状态', async () => {
    child = await startWorker(3212);

    // 14 天档：分段生成 + 15 个展示页，足够让任务在信号到达时仍在处理中
    const jobId = await submit();

    /*
     * 等任务真的离开 QUEUED —— 直接发信号可能赶在消费开始之前，
     * 那样测的就是「空闲退出」而不是「生成中退出」（上一条已经覆盖了前者）。
     */
    const running = await waitForStatus(jobId, (status) => status !== 'QUEUED', 15_000);
    expect(running, '任务应已开始处理').not.toBe('QUEUED');

    const exited = waitForExit(child);
    child.kill('SIGTERM');
    const { code, ms } = await exited;

    expect(code).toBe(0);
    expect(ms).toBeLessThan(SHUTDOWN_BUDGET_MS);
    child = null;

    /*
     * ── 「不留悬挂状态」的判据 ──
     *
     * 22.3.3 的原文是「避免任务半途中断留下 RENDERING_HTML 悬挂状态」。
     * 悬挂的准确含义是：**既不是终态，也不会再被消费**。因此两种结局都合格：
     *
     *   终态             任务在停机前跑完了（BullMQ 的 close 等在途任务结束）
     *   非终态 + 消息在  重启后会被重新消费（13.8 的锁已随进程释放）
     *
     * 不合格的只有第三种：非终态、且队列里没有对应消息 —— 那条任务永远
     * 停在中间态，用户的页面一直转圈而没有任何东西会推进它。
     */
    const finalStatus = await jobStatus(jobId);
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(finalStatus);

    if (!terminal) {
      const pending = await rawQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
      const stillQueued = pending.some((job) => (job.data as { jobId?: string }).jobId === jobId);
      expect(
        stillQueued,
        `任务停在 ${finalStatus} 且队列里没有它 —— 这就是 22.3.3 要防的悬挂`,
      ).toBe(true);
    }
  }, 90_000);

  it('排空期间就绪探针返回 503（负载均衡据此摘除实例）', async () => {
    child = await startWorker(3213);

    /*
     * 探针在 SIGTERM 之后、进程退出之前必须变成 not_ready。这是优雅停机能
     * 真正「优雅」的前提：LB 还在往一个正在排空的实例上转发请求的话，
     * 那些请求会在连接被关时失败。
     *
     * 这里只在信号后立刻查一次 —— 空闲 worker 退出很快，查不到 503 也可能
     * 是因为它已经退出了，因此两种结果都接受，只要不是 200。
     */
    child.kill('SIGTERM');

    let observed: number | 'closed' = 200;
    for (let i = 0; i < 30 && observed === 200; i += 1) {
      try {
        const response = await fetch('http://127.0.0.1:3213/readyz');
        observed = response.status;
      } catch {
        observed = 'closed';
      }
      if (observed === 200) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(observed).not.toBe(200);
    await waitForExit(child);
    child = null;
  }, 60_000);
});
