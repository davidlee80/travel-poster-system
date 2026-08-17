import { IdentityService, RedisSessionStore } from '@tps/api/identity';
import { buildServer } from '@tps/api/server';
import {
  createPool,
  createUsersRepository,
  createRetrievalRepository,
  createTravelPlansRepository,
  migrate,
  migrationsDirectory,
} from '@tps/db';
import { FakeLlmClient, LocalHashingEmbeddingClient } from '@tps/llm';
import { parseRetrievalProjection, projectionToEmbeddingText } from '@tps/planning';
import {
  BullMqPlanQueue,
  GenerationJobPayloadSchema,
  PLAN_QUEUE_NAME,
  RedisCounterStore,
  RedisIdempotencyLock,
  createQueueRedis,
  createRedis,
} from '@tps/queue';
import { TravelPlanSchema, findForbiddenProjectionKeys } from '@tps/schemas';
import {
  COOKIE_NAMES,
  GracefulShutdown,
  QuotaGuard,
  createSilentLogger,
  loadQuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import { Queue } from 'bullmq';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fixturePlanFor } from './fixture-plan.js';
import { generatePlan } from './generate-plan.js';

/**
 * 端到端链路（TP-2-17 的验收点，需真实 PostgreSQL + Redis）。
 *
 * ```text
 * POST /api/v1/travel-plans/generate   （真实 Fastify + 真实 Postgres + 真实 Redis 锁）
 *   → BullMQ 入队                       （真实队列）
 *   → generatePlan 消费                  （真实校验 / 修复 / 持久化，模型用 fake）
 *   → GET /api/v1/generation-jobs/{id}   （进度按 16.2 推进）
 *   → GET /api/v1/travel-plans/{id}      （返回完整 TravelPlan）
 * ```
 *
 * ## 为什么这条测试必须存在
 *
 * 每一段都有自己的单测，但**接缝没有**：入队载荷的字段名、状态机在两个进程
 * 之间的衔接、`plan_id` 从 API 一路传到 `plan_json`。这类问题在各自的单测里
 * 都看不见 —— 双方都「按自己以为的约定」工作。
 *
 * 模型用 `LLM_MODE=fake` 的录制输出（与默认配置一致），因此**不需要凭据**。
 * 真实模型的接入由 `LLM_MODE=direct|gateway` 切换，那一步需要凭据，
 * 因此不在自动化测试里。
 *
 * 运行：`DATABASE_URL=... REDIS_URL=... pnpm test:integration`
 */

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const describeIntegration =
  databaseUrl === undefined || redisUrl === undefined ? describe.skip : describe;

const serviceConfig: ServiceConfig = {
  serviceName: 'tps-api-e2e',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

/** 队列名加后缀，避免与本地开发中的真实队列互相消费 */
const QUEUE_NAME = `${PLAN_QUEUE_NAME}-e2e`;

describeIntegration('端到端：提交 → 生成 → 读取（集成）', () => {
  let pool: Pool;
  let redis: Redis;
  let queueRedis: Redis;
  let app: ReturnType<typeof buildServer>;
  let queue: BullMqPlanQueue;
  let rawQueue: Queue;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 8,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());

    redis = createRedis(redisUrl as string);
    queueRedis = createQueueRedis(redisUrl as string);
    queue = new BullMqPlanQueue(queueRedis, QUEUE_NAME);
    rawQueue = new Queue(QUEUE_NAME, { connection: queueRedis });

    const quotaConfig = loadQuotaConfig();
    const quota = new QuotaGuard({
      config: quotaConfig,
      store: new RedisCounterStore(redis),
      now: () => new Date(),
    });

    /*
     * 身份走真实的 Redis 会话存储与真实 users 表 —— 这条链路的第一环就是
     * 「没有身份也能生成」（13.0 第 3.a 条），用假身份服务会把它测掉。
     */
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
        idempotencyLock: new RedisIdempotencyLock(redis),
        secureCookies: false,
        now: () => new Date(),
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await rawQueue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await rawQueue.close();
    await redis.quit();
    await queueRedis.quit();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    await redis.flushdb();
    await rawQueue.obliterate({ force: true }).catch(() => undefined);
  });

  /** 出发日期取「明天」，否则 N-01（出发日期不早于今天）会拒掉请求 */
  function requestBody(): Record<string, unknown> {
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 4 * 86_400_000);
    const iso = (date: Date): string => date.toISOString().slice(0, 10);

    return {
      schema_version: 'travel_request_ui_v1',
      client_request_id: `e2e-${Math.random().toString(36).slice(2)}`,
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
        dates: { start_date: iso(start), end_date: iso(end), flexibility_days: 0 },
      },
      travelers: { adults: 2, children: [{ age: 8 }], seniors: [] },
      budget: {
        currency: 'CNY',
        basis: 'PER_PERSON_PER_DAY',
        min: 100,
        max: 400,
        included_items: ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'],
      },
      pace: { level: 'RELAXED' },
      conditions: [
        { code: 'interest.history_culture', mode: 'SHOULD', value: true },
        { code: 'accessibility.low_walking', mode: 'MUST', value: true },
      ],
      custom_requirements: { raw_text: '想看运河和博物馆，晚上不要太晚。' },
      output_preferences: {
        language: 'zh-CN',
        template_id: 'travel_infographic_v1',
        generate_png: true,
        generate_pdf: true,
      },
    };
  }

  /** 从队列里取出唯一一条待处理任务的载荷 */
  async function takeQueuedPayload(): Promise<ReturnType<typeof GenerationJobPayloadSchema.parse>> {
    const waiting = await rawQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(waiting).toHaveLength(1);
    return GenerationJobPayloadSchema.parse(waiting[0]!.data);
  }

  function workerDeps() {
    const embedding = new LocalHashingEmbeddingClient();
    return {
      plans: createTravelPlansRepository(pool),
      retrieval: { repository: createRetrievalRepository(pool), embedding },
      // 与 LLM_MODE=fake 的默认行为一致：按请求构造录制输出
      llm: (normalized: Parameters<typeof fixturePlanFor>[0]) =>
        new FakeLlmClient([fixturePlanFor(normalized)]),
      embedding,
      logger: createSilentLogger(),
      llmTimeoutMs: 30_000,
    };
  }

  it('无身份提交 → 入队 → 生成 → 计划可读', async () => {
    // 1. 提交（13.0 第 3.a 条：无身份也不返回 401，现场建匿名号）
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: requestBody(),
    });

    expect(created.statusCode).toBe(201);
    const handles = created.json<{
      request_id: string;
      plan_id: string;
      job_id: string;
      status: string;
    }>();
    expect(handles.status).toBe('QUEUED');

    const cookieHeader = created.headers['set-cookie'];
    const cookies = Array.isArray(cookieHeader) ? cookieHeader.map(String) : [String(cookieHeader)];
    const anon = cookies.find((entry) => entry.startsWith(`${COOKIE_NAMES.anonymous}=`))!;
    const cookie = `${COOKIE_NAMES.anonymous}=${anon.slice(COOKIE_NAMES.anonymous.length + 1).split(';')[0]!}`;

    // 2. 队列里确实有这条任务，且载荷只含标识符
    const payload = await takeQueuedPayload();
    expect(payload).toEqual({
      jobId: handles.job_id,
      requestId: handles.request_id,
      planId: handles.plan_id,
      userId: expect.any(String),
    });

    // 3. 生成前：计划还读不到（尚无 current_version_id）
    const tooEarly = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${handles.plan_id}`,
      headers: { cookie },
    });
    expect(tooEarly.statusCode).toBe(404);

    // 4. Worker 消费
    const outcome = await generatePlan(workerDeps(), payload);
    expect(outcome).toMatchObject({ outcome: 'saved' });

    // 5. 任务状态推进到 SAVING_PLAN（P2 的边界，见 generate-plan.ts）
    const job = await app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${handles.job_id}`,
      headers: { cookie },
    });
    expect(job.statusCode).toBe(200);
    expect(job.json()).toMatchObject({ status: 'SAVING_PLAN', progress: 60 });

    // 6. 计划可读，且是一份合法的 TravelPlan
    const plan = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${handles.plan_id}`,
      headers: { cookie },
    });
    expect(plan.statusCode).toBe(200);

    const parsed = TravelPlanSchema.safeParse(plan.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // ID 由程序注入（6.3），且与 API 返回的一致
    expect(parsed.data.plan_id).toBe(handles.plan_id);
    expect(parsed.data.request_id).toBe(handles.request_id);
    // 天数与目的地跟随请求
    expect(parsed.data.days).toHaveLength(5);
    expect(parsed.data.destination.name).toBe('杭州');
    expect(parsed.data.days.every((day) => day.city === '杭州')).toBe(true);

    // 7. 列表端点能看到它
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans',
      headers: { cookie },
    });
    expect(list.json<{ items: { plan_id: string }[] }>().items.map((item) => item.plan_id)).toEqual(
      [handles.plan_id],
    );
  });

  it('落库的版本带脱敏投影与向量，且能被同城的相似计划检索到（门禁 #26）', async () => {
    /*
     * 这里用**投影侧**的向量去查，而不是用请求侧的查询向量。
     *
     * 原因是 V1 的本地哈希向量器只表达词汇重合度（见 @tps/llm 的 embedding.ts）：
     * 请求文本（「杭州 / 5 天 / 想看运河和博物馆」）与投影文本
     * （「拱宸桥｜大运河博物馆｜片儿川」）的共同词很少，余弦通常低于
     * 3.2.4 的 0.75 阈值。也就是说 fake / 本地模式下，请求驱动的检索
     * **多半报「无历史参考」** —— 这是延后接入语义向量模型的直接后果，
     * 不是链路缺陷。接上语义模型后同一段代码就能命中，接口不变。
     *
     * 因此这条用例验证的是「落库的行确实可被检索发现」：
     * 投影、向量、七个可读列、跨用户可见性都在，只差一个更好的向量器。
     */
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: requestBody(),
    });
    expect(first.statusCode).toBe(201);
    const saved = await generatePlan(workerDeps(), await takeQueuedPayload());
    expect(saved.outcome).toBe('saved');

    const stored = await pool.query<{
      retrieval_projection: unknown;
      has_embedding: boolean;
      status: string;
      plan_id: string;
    }>(
      `SELECT retrieval_projection, plan_embedding IS NOT NULL AS has_embedding, status, plan_id
         FROM travel_plan_versions`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.has_embedding).toBe(true);
    /*
     * `REPAIRED` 而不是 `READY`：fake 模式的录制输出只把**硬约束**写进
     * satisfied，软约束（这里是 interest.history_culture）满足率为 0，
     * V-32 因此报 ADVISORY 并记入 assumptions —— 按 3.2.2 那就是 REPAIRED。
     * 两者都进入检索（3.2.4 的过滤条件是 `status IN ('READY','REPAIRED')`）。
     */
    expect(['READY', 'REPAIRED']).toContain(stored.rows[0]!.status);

    // 投影里不该有金额、日期、人员构成（3.2.4）
    const projectionJson = JSON.stringify(stored.rows[0]!.retrieval_projection);
    for (const forbidden of ['daily_budget', 'estimated_cost', 'traveler_count', 'start_date']) {
      expect(projectionJson, `投影里出现了 ${forbidden}`).not.toContain(forbidden);
    }
    expect(findForbiddenProjectionKeys(stored.rows[0]!.retrieval_projection)).toEqual([]);

    /*
     * 用「另一份同主题计划会产生的向量」去检索 —— 也就是站在
     * 「第二个用户提交了很相似的需求」这个位置上。命中即证明：
     * 跨用户（另一个匿名身份的行）、跨表列级 GRANT、HNSW 索引、
     * 相似度阈值这一整条链路是通的。
     */
    const projection = parseRetrievalProjection(stored.rows[0]!.retrieval_projection);
    expect(projection).not.toBeNull();
    const embedding = new LocalHashingEmbeddingClient();
    const [queryVector] = await embedding.embed([projectionToEmbeddingText(projection!)]);

    const candidates = await createRetrievalRepository(pool).findSimilar({
      embedding: queryVector!,
      destinationPlaceId: 'cn-hangzhou',
      totalDays: 5,
      minSimilarity: 0.75,
      limit: 5,
      dayTolerance: 3,
      timeoutMs: 1_500,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.planId).toBe(stored.rows[0]!.plan_id);
    // 检索结果里没有 plan_json 的内容
    expect(JSON.stringify(candidates)).not.toContain('daily_budget');
  });

  it('重复提交同一需求命中幂等，不产生第二个计划', async () => {
    const body = requestBody();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body,
    });
    expect(first.statusCode).toBe(201);

    const cookieHeader = first.headers['set-cookie'];
    const cookies = Array.isArray(cookieHeader) ? cookieHeader.map(String) : [String(cookieHeader)];
    const anon = cookies.find((entry) => entry.startsWith(`${COOKIE_NAMES.anonymous}=`))!;
    const cookie = `${COOKIE_NAMES.anonymous}=${anon.slice(COOKIE_NAMES.anonymous.length + 1).split(';')[0]!}`;

    // 同一身份、同一 client_request_id、同一内容 → 任务仍在进行中 → 409
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('JOB_ALREADY_RUNNING');

    const count = await pool.query<{ count: string }>('SELECT count(*) FROM travel_plans');
    expect(count.rows[0]!.count).toBe('1');
  });
});
