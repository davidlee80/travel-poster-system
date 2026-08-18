import { IdentityService, RedisSessionStore } from '@tps/api/identity';
import { buildServer } from '@tps/api/server';
import {
  createPool,
  createPresentationsRepository,
  createRetrievalRepository,
  createUsersRepository,
  createTravelPlansRepository,
  migrate,
  migrationsDirectory,
} from '@tps/db';
import { LocalHashingEmbeddingClient } from '@tps/llm';
import { metricsText } from '@tps/observability';
import { GenerationMetadataSchema, TravelPosterViewModelSchema } from '@tps/schemas';
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

import { MAX_AI_IMAGES_PER_JOB } from './assets/ai-budget.js';
import { createE2eWorkerDeps } from './e2e-harness.js';
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
        presentations: createPresentationsRepository(pool),
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
    // 绑定引用素材且是 RESTRICT，顺序不能反
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
    await redis.flushdb();
    await rawQueue.obliterate({ force: true }).catch(() => undefined);
  });

  /**
   * 从 Set-Cookie 里取出匿名令牌。
   *
   * 必须按前缀找到那一条再截到第一个 `;` —— 直接 join 再解析会把
   * `Expires=Thu, 01 Jan ...` 里的逗号与分号一起卷进来，得到一个被截断的令牌。
   */
  function anonymousCookie(header: string | string[] | undefined): string {
    const cookies = Array.isArray(header) ? header.map(String) : [String(header)];
    const anon = cookies.find((entry) => entry.startsWith(`${COOKIE_NAMES.anonymous}=`))!;
    const value = anon.slice(COOKIE_NAMES.anonymous.length + 1).split(';')[0]!;
    return `${COOKIE_NAMES.anonymous}=${value}`;
  }

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

  // 依赖装配见 e2e-harness.ts（与 acceptance.integration.test.ts 共用）
  const workerDeps = () => createE2eWorkerDeps(pool);

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

    const cookie = anonymousCookie(created.headers['set-cookie']);

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

    /*
     * 5. 任务推进到 COMPLETED（16.1，TP-4-08）。
     *
     * P4 起 RENDERING_HTML → COMPLETED 也走完了：渲染路由是实时从库里取
     * ViewModel 渲染的，页面在展示数据落库那一刻就可访问（见 R-35）。
     * `warnings` 里是非阻断的素材降级码（TP-4-09）—— 本地素材库是空的，
     * 因此必然有 ASSET_LIBRARY_MISS。
     */
    const job = await app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${handles.job_id}`,
      headers: { cookie },
    });
    expect(job.statusCode).toBe(200);
    expect(job.json()).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(job.json<{ warnings: string[] }>().warnings).toContain('ASSET_LIBRARY_MISS');

    // T1/T2 里程碑都已写入（21.2 措施一，TP-4-14）
    const milestones = await pool.query<{ t1_at: Date | null; t2_at: Date | null }>(
      'SELECT t1_at, t2_at FROM generation_jobs WHERE id = $1',
      [handles.job_id],
    );
    expect(milestones.rows[0]!.t1_at).not.toBeNull();
    expect(milestones.rows[0]!.t2_at).not.toBeNull();
    // T1 不晚于 T2：文字版计划先可读，带图页面后可看
    expect(milestones.rows[0]!.t1_at!.getTime()).toBeLessThanOrEqual(
      milestones.rows[0]!.t2_at!.getTime(),
    );

    /*
     * `stage_timings` 逐阶段落库，且含 `total`（TP-5-01）。
     *
     * 十五章说这一列是「二十一章性能目标的唯一度量来源」，而它在 P4 结束时
     * 从未被写入过 —— 空的 `{}` 与「任务很快」在库里看起来一样。
     * `total` 只有随最后一次 UPDATE 才能写进去（之后行已是终态），
     * 因此它的存在同时证明了那条路径是通的。
     */
    const timings = await pool.query<{ stage_timings: Record<string, number> }>(
      'SELECT stage_timings FROM generation_jobs WHERE id = $1',
      [handles.job_id],
    );
    const recorded = timings.rows[0]!.stage_timings;
    expect(Object.keys(recorded)).toEqual(
      expect.arrayContaining([
        'NORMALIZING',
        'GENERATING_PLAN',
        'SAVING_PLAN',
        'RESOLVING_ASSETS',
        'RENDERING_HTML',
        'total',
      ]),
    );
    // total 不小于任何单个阶段 —— 它是从入队时刻算的
    const stages = Object.entries(recorded).filter(([key]) => key !== 'total');
    for (const [stage, ms] of stages) {
      expect(ms, `${stage} 的耗时应不超过总耗时`).toBeLessThanOrEqual(recorded['total']!);
    }

    /*
     * 21.3 的三个新指标真的有样本（TP-5-01 的验证方式：「/metrics 全部指标
     * 有数据」）。断言样本行而不是仅断言指标名 —— prom-client 对已注册但
     * 从未 inc 的带标签指标只输出 HELP/TYPE 两行，而那正是 P5 之前
     * `travel_llm_tokens_total` 的状态（连注册都没有）。
     */
    const scraped = await metricsText();
    expect(scraped).toMatch(/travel_job_total\{[^}]*status="COMPLETED"/);
    expect(scraped).toMatch(/travel_job_duration_seconds_bucket\{[^}]*stage="total"/);
    expect(scraped).toMatch(/travel_llm_duration_seconds_bucket\{[^}]*purpose="plan"/);

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

  it('展示数据可读：每日 ViewModel + 完整页 + 路线图（TP-3-16、P3 门禁）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: requestBody(),
    });
    expect(created.statusCode).toBe(201);
    const handles = created.json<{ plan_id: string; job_id: string }>();
    const cookie = anonymousCookie(created.headers['set-cookie']);

    const outcome = await generatePlan(workerDeps(), await takeQueuedPayload());
    expect(outcome).toMatchObject({ outcome: 'saved' });

    // N+1 页（5 天 + 完整页）
    const rows = await pool.query<{ count: string }>(
      'SELECT count(*) FROM plan_presentations WHERE plan_id = $1',
      [handles.plan_id],
    );
    expect(rows.rows[0]!.count).toBe('6');

    // 13.4：按天取
    for (const day of [1, 3, 5]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/travel-plans/${handles.plan_id}/presentations/${day}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        page_type: string;
        day_number: number;
        validation_status: string;
        view_model: unknown;
      }>();
      expect(body.page_type).toBe('DAILY_POSTER');
      expect(body.day_number).toBe(day);

      // ViewModel 必须能被契约解析 —— 前端就是按它渲染的
      const parsed = TravelPosterViewModelSchema.safeParse(body.view_model);
      expect(parsed.success, `第 ${day} 天的 ViewModel 不合法`).toBe(true);
      if (!parsed.success) continue;

      // 路线图：SVG 已生成并上传，因此 svg_url 有值（9.2，不是文字降级）
      expect(parsed.data.route_map.svg_url).toContain('.svg');
      expect(parsed.data.route_map.nodes.length).toBeGreaterThan(0);
      // 图标 8 个键齐全（12.2）
      expect(Object.keys(parsed.data.icons)).toHaveLength(8);
    }

    // 13.4：完整页一次请求返回全部天数（R-04 补充）
    const full = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${handles.plan_id}/presentations/full`,
      headers: { cookie },
    });
    expect(full.statusCode).toBe(200);
    const fullBody = full.json<{
      page_type: string;
      day_number: number | null;
      view_model: { days: unknown[]; overview: { total_days: number } };
    }>();
    expect(fullBody.page_type).toBe('FULL_PLAN');
    expect(fullBody.day_number).toBeNull();
    expect(fullBody.view_model.days).toHaveLength(5);
    expect(fullBody.view_model.overview.total_days).toBe(5);

    // 越界天号 404（13.0：不存在的页面与不属于你的页面同一个码）
    const outOfRange = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${handles.plan_id}/presentations/9`,
      headers: { cookie },
    });
    expect(outOfRange.statusCode).toBe(404);
  });

  it('素材绑定落库且来源可追溯（TP-3-15、二十章）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: requestBody(),
    });
    const handles = created.json<{ plan_id: string }>();
    const cookie = anonymousCookie(created.headers['set-cookie']);

    await generatePlan(workerDeps(), await takeQueuedPayload());

    /*
     * 本地素材库是空的（没有灌种子素材，也没灌占位图）。P3 时这意味着
     * 只有路线图产出素材；P4 接入 AI 兜底后，景点与美食槽位也有产物 ——
     * 而 21.4 的单任务上限（3 张）决定了它们不会全部有。
     *
     * 每一条绑定都要能回答「这张图从哪来」（二十章的可追溯性）。
     */
    const bindings = await pool.query<{
      role: string;
      resolution_strategy: string;
      source_type: string;
      representation_type: string;
      generation_metadata: unknown;
    }>(
      `SELECT b.role, b.resolution_strategy, a.source_type, a.representation_type,
              a.generation_metadata
         FROM plan_asset_bindings b
         JOIN assets a ON a.id = b.asset_id
        WHERE b.plan_id = $1
        ORDER BY b.day_number`,
      [handles.plan_id],
    );

    // 5 天的路线图 + 若干 AI 兜底图
    expect(bindings.rows.length).toBeGreaterThan(5);

    for (const row of bindings.rows) {
      if (row.role === 'ROUTE_MAP') {
        expect(row.source_type).toBe('GENERATED_SVG');
        // 示意图不是照片（9.4 的同一条原则）
        expect(row.representation_type).toBe('ILLUSTRATIVE');
        continue;
      }
      // 库是空的，因此非路线槽位只可能来自 AI（十八章第 1 级）
      expect(row.source_type).toBe('AI_GENERATED');
      // 11.3 第五条：AI 图不得标成真实照片
      expect(row.representation_type).toBe('ILLUSTRATIVE');
      // 二十章：AI 生成物的 generation_metadata 必须非空且可解析
      expect(GenerationMetadataSchema.safeParse(row.generation_metadata).success).toBe(true);
    }

    /*
     * TP-4-17：匿名身份的 AI Hero 额度为 0。
     *
     * 这条用例走的是无身份提交（13.0 第 3.a 条现场建匿名号），因此
     * **一张 Hero 都不该被生成**，而计划仍然可读、页面仍然可渲染
     * （模板对 `hero_asset: null` 有渐变背景分支）。
     */
    expect(bindings.rows.some((row) => row.role === 'HERO_BACKGROUND')).toBe(false);

    /*
     * 21.4：单任务 AI 图上限 3 张。绑定数可以多于 3
     * （19.5 的跨天复用让多个槽位指向同一张），但**素材行**不能。
     */
    const aiAssets = await pool.query<{ count: string }>(
      `SELECT count(*) FROM assets WHERE source_type = 'AI_GENERATED'`,
    );
    expect(Number(aiAssets.rows[0]!.count)).toBeLessThanOrEqual(MAX_AI_IMAGES_PER_JOB);

    // 仍有槽位未解析（占位图也没灌）→ DEGRADED 而不是 VALID（十五章）
    const presentation = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${handles.plan_id}/presentations/1`,
      headers: { cookie },
    });
    expect(presentation.json<{ validation_status: string }>().validation_status).toBe('DEGRADED');
  });

  it('同一任务重复投递被终态挡住（13.8 的 Worker 侧并发保护）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: requestBody(),
    });
    const cookie = anonymousCookie(created.headers['set-cookie']);
    const payload = await takeQueuedPayload();

    const first = await generatePlan(workerDeps(), payload);
    expect(first.outcome).toBe('saved');

    /*
     * P4 起任务会推进到 COMPLETED，因此第二次消费被终态挡住 ——
     * 这正是 13.8 要的行为（重复投递不双执行）。
     *
     * ## R-36：V1 没有「重新生成」入口，多版本机制因此不可达
     *
     * `travel_plan_versions` 的版本号、`current_version_id`、13.4 的
     * `?plan_version_id=` 参数、13.7 的 `EXPORT_PLAN_VERSION_MISMATCH`
     * （「计划已产生新版本」）—— 这一整套多版本机制在十三章里**没有任何
     * 端点能触发**：13.1 的每次提交都建一个新的 `travel_plans` 行。
     *
     * P3 时期这条测试能造出两个版本，靠的是「任务停在非终态所以能重复消费」
     * —— 那是交付边界的副作用，不是设计的入口。P4 把状态机走完之后，
     * 多版本只能由数据修复或将来的重生成端点产生。
     * 因此这里改为断言重复投递的正确行为，版本隔离的断言下移到
     * `presentations` 仓储的集成测试（它直接构造两个版本）。
     */
    const second = await generatePlan(workerDeps(), payload);
    expect(second).toEqual({ outcome: 'skipped', reason: 'already_terminal' });

    if (first.outcome !== 'saved') return;

    // 只有一个版本，且它有完整的 5 天 + 完整页
    const perVersion = await pool.query<{ plan_version_id: string; count: string }>(
      `SELECT plan_version_id, count(*) AS count
         FROM plan_presentations WHERE plan_version_id = $1
        GROUP BY plan_version_id`,
      [first.versionId],
    );
    expect(perVersion.rows).toHaveLength(1);
    expect(perVersion.rows[0]!.count).toBe('6');

    // 13.4 默认返回当前版本，且显式指定同一版本得到同样的结果
    const current = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${payload.planId}/presentations/1`,
      headers: { cookie },
    });
    expect(current.json<{ plan_version_id: string }>().plan_version_id).toBe(first.versionId);

    const explicit = await app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans/${payload.planId}/presentations/1?plan_version_id=${first.versionId}`,
      headers: { cookie },
    });
    expect(explicit.json<{ plan_version_id: string }>().plan_version_id).toBe(first.versionId);

    /*
     * 19.5 的内容寻址复用（跨天）：fixture 的每一天走的是同一批地点，
     * 因此 5 个路线槽位的 `route_node_hash` 相同，库里只落了**一张** SVG。
     * 这条断言是「重复编排不重复花钱」的直接证据 ——
     * 数字从 5 降到 1 全靠 assets_cache_key_uk 与内容寻址的哈希。
     */
    const svgCount = await pool.query<{ count: string }>(
      `SELECT count(*) FROM assets WHERE source_type = 'GENERATED_SVG'`,
    );
    expect(svgCount.rows[0]!.count).toBe('1');

    /*
     * 21.4：单任务 AI 图上限 3 张。绑定数可以多于 3（19.5 的跨天复用让多个
     * 槽位指向同一张），但**素材行**不能 —— 这与槽位数（14 天可达 84 个）无关。
     */
    const aiAssets = await pool.query<{ count: string }>(
      `SELECT count(*) FROM assets WHERE source_type = 'AI_GENERATED'`,
    );
    expect(Number(aiAssets.rows[0]!.count)).toBeLessThanOrEqual(MAX_AI_IMAGES_PER_JOB);

    // 绑定按版本记（`UNIQUE(plan_version_id, template_id, slot_id)`），至少 5 条路线图
    const bindings = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM plan_asset_bindings WHERE plan_version_id = $1',
      [first.versionId],
    );
    expect(Number(bindings.rows[0]!.count)).toBeGreaterThanOrEqual(5);
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

    const cookie = anonymousCookie(first.headers['set-cookie']);

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
