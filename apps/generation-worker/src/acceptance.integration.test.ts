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
  GenerationJobPayloadSchema,
  PLAN_QUEUE_NAME,
  RedisCounterStore,
  RedisIdempotencyLock,
  createQueueRedis,
  createRedis,
} from '@tps/queue';
import {
  TravelPlanSchema,
  isBlocking,
  type ConditionCode,
  type ConstraintReport,
} from '@tps/schemas';
import {
  COOKIE_NAMES,
  GracefulShutdown,
  QuotaGuard,
  createSilentLogger,
  loadQuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createE2eWorkerDeps } from './e2e-harness.js';
import { generatePlan } from './generate-plan.js';

/**
 * 24.1 #1 的 20 个端到端用例（TP-5-05）。
 *
 * ```text
 * 通过线：20 个覆盖 1/3/7/14 天与多种约束组合的用例全绿，全程无人工介入
 * ```
 *
 * ## 这个文件与 pipeline.integration.test.ts 的分工
 *
 * 后者验证**链路的正确性**：一条请求走完每个环节，每个接缝上的字段都对得上。
 * 它需要几十条细致的断言，因此只跑一个配置。
 *
 * 这里验证**覆盖面**：同一条链路在 20 种输入下都能走完。断言少而统一，
 * 每条用例只回答「它成了吗、成得对吗」。两者都需要 —— 单配置的深度测试
 * 看不见「14 天会分段调两次模型而合并逻辑有 bug」，
 * 而 20 配置的浅测试看不见「绑定的 asset_id 指向了别人的素材」。
 *
 * ## 身份：P7 之后只有注册
 *
 * 原先 20 个用例里 10 个匿名、10 个注册按索引交替 —— 理由是 R-13 的双身份
 * 模式让每条链路都有两个版本（配额、AI Hero 额度、保留期各不相同）。
 *
 * P7 关闭匿名入口后，前端来的一切请求都必须是注册用户，因此这里全部注册，
 * 且 `anonymousEnabled: false` —— 这个文件同时成了「关闭匿名后端到端链路
 * 仍完整」的证明。
 *
 * 匿名侧仍然有效的那些能力（升级、归并、AI Hero 额度 0、保留期清理）
 * 由服务层与仓储层的测试覆盖，见 `tools/acceptance-gates.mjs` 的
 * #23/#24/#25/#29/#31 —— 它们不经 API，因此与开关状态无关。
 *
 * 运行：`DATABASE_URL=... REDIS_URL=... pnpm test:acceptance`
 */

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const describeIntegration =
  databaseUrl === undefined || redisUrl === undefined ? describe.skip : describe;

const QUEUE_NAME = `${PLAN_QUEUE_NAME}-acceptance`;

const serviceConfig: ServiceConfig = {
  serviceName: 'tps-api-acceptance',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

/** 一种约束组合。`label` 进测试名，失败时能直接看出是哪一类输入 */
interface ConstraintProfile {
  readonly label: string;
  readonly conditions: readonly { code: ConditionCode; mode: 'MUST' | 'SHOULD'; value: true }[];
  readonly pace: 'RELAXED' | 'BALANCED' | 'PACKED';
  readonly children: readonly { age: number }[];
  readonly budget: { readonly min: number; readonly max: number };
}

/**
 * 五种约束组合。挑选依据是**它们各自会触发不同的规则与降级路径**，
 * 而不是「凑够五个」：
 *
 * ```text
 * 基础          没有硬约束，V-xx 里与条件相关的规则全部不参与
 * 低步行 MUST   3.2.1 的可达性规则会检查每日步行量与交通方式
 * 素食 MUST     餐饮槽位的硬约束，违反即 BLOCKING（门禁 #3 要断言它没发生）
 * 兴趣 + 紧凑   PACKED 让每日条目数顶到上限，最容易触发 17.3 的溢出降级
 * 亲子 + 紧预算 children 影响 V-05（儿童作息）与预算分摊，两条规则同时生效
 * ```
 */
const PROFILES: readonly ConstraintProfile[] = [
  {
    label: '基础',
    conditions: [],
    pace: 'BALANCED',
    children: [],
    budget: { min: 200, max: 600 },
  },
  {
    label: '低步行MUST',
    conditions: [{ code: 'accessibility.low_walking', mode: 'MUST', value: true }],
    pace: 'RELAXED',
    children: [],
    budget: { min: 200, max: 800 },
  },
  {
    label: '素食MUST',
    conditions: [{ code: 'diet.vegetarian', mode: 'MUST', value: true }],
    pace: 'BALANCED',
    children: [],
    budget: { min: 150, max: 500 },
  },
  {
    label: '文化兴趣+紧凑',
    conditions: [
      { code: 'interest.history_culture', mode: 'SHOULD', value: true },
      { code: 'interest.art_museum', mode: 'SHOULD', value: true },
    ],
    pace: 'PACKED',
    children: [],
    budget: { min: 300, max: 1_000 },
  },
  {
    label: '亲子+紧预算',
    conditions: [
      { code: 'interest.family_kids', mode: 'SHOULD', value: true },
      { code: 'schedule.no_late_night', mode: 'MUST', value: true },
    ],
    pace: 'RELAXED',
    children: [{ age: 6 }],
    budget: { min: 100, max: 300 },
  },
];

/** 24.1 #1 点名的四个天数档。7 与 14 是 6.3 分段生成的两侧 */
const DAY_COUNTS = [1, 3, 7, 14] as const;

interface Case {
  readonly index: number;
  readonly totalDays: number;
  readonly profile: ConstraintProfile;
  readonly name: string;
}

/**
 * 20 个用例 = 4 个天数档 × 5 种约束组合。
 *
 * ## P7：身份轴已移除
 *
 * 原先这里有第三个轴（匿名 / 注册按索引交替）。P7 关闭匿名入口后，
 * 前端来的一切请求都必须是注册用户，那个轴退化成常量。
 *
 * 移除而不是保留成「全 REGISTERED」的字段：一个恒为同一个值的维度
 * 会让读用例名的人以为覆盖了两种身份。矩阵仍是 20 个 —— 身份轴本来是
 * **叠在**这 20 个上的（4 × 5 = 20），不是乘上去的。
 *
 * 匿名侧那些仍然有效的能力（升级、归并、AI Hero 额度 0、保留期清理）
 * 改由服务层与仓储层的测试覆盖，见 `tools/acceptance-gates.mjs`
 * 的 #23/#24/#25/#29/#31。
 */
const CASES: readonly Case[] = DAY_COUNTS.flatMap((totalDays, dayIndex) =>
  PROFILES.map((profile, profileIndex): Case => {
    const index = dayIndex * PROFILES.length + profileIndex;
    return {
      index,
      totalDays,
      profile,
      name: `#${String(index + 1).padStart(2, '0')} ${totalDays} 天 · ${profile.label}`,
    };
  }),
);

describeIntegration('24.1 #1：20 个端到端用例（集成）', () => {
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
      statementTimeoutMs: 30_000,
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
    const identity = new IdentityService({
      users: createUsersRepository(pool),
      sessions: new RedisSessionStore(redis),
      quota,
      quotaConfig,
      now: () => new Date(),
      secureCookies: false,
      /*
       * P7：**关闭**匿名入口。20 个验收用例已经改为直接注册（增量 1），
       * 因此这里用关闭态跑 —— 它同时成了「关闭匿名后端到端链路仍完整」
       * 的证明，而不是另找一个地方再验一遍。
       */
      anonymousEnabled: false,
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
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
    /*
     * 每个用例都清 Redis：配额计数按 IP 与身份累积，21.4 的匿名日配额是 5 个 ——
     * 不清的话第 6 个用例开始全部撞 AUTH_QUOTA_EXCEEDED，
     * 而那会被误读成「生成链路坏了」。
     */
    await redis.flushdb();
    await rawQueue.obliterate({ force: true }).catch(() => undefined);
  });

  /** 取出 Set-Cookie 里的某个 cookie（值截到第一个 `;`） */
  function cookieFrom(header: string | string[] | undefined, name: string): string {
    const list = Array.isArray(header) ? header.map(String) : [String(header)];
    const entry = list.find((item) => item.startsWith(`${name}=`));
    if (entry === undefined) throw new Error(`响应未下发 ${name}`);
    return `${name}=${entry.slice(name.length + 1).split(';')[0] ?? ''}`;
  }

  /**
   * 取一个注册用户的会话 Cookie。
   *
   * 走的是**真实的注册端点**而不是直接插一行 users：注册端点上有口令强度、
   * 邮箱唯一、配额默认值三处逻辑，绕过它插行会让那三处永远没被跑到。
   *
   * ## P7：不再先取 tp_anon
   *
   * 原先的做法是 `GET /auth/session` 拿匿名 Cookie → 带着它注册（走 13.9.2
   * 的「原地升级」分支）。关闭匿名入口后那条路走不通了，而且这里本来也
   * **不该**依赖它 —— 20 个验收用例要验的是生成链路，把它们的前置条件
   * 挂在另一个功能上，等于让一个功能的关闭连带 21 个用例一起红，
   * 而红的原因与它们要验的东西无关。
   *
   * 「携带 tp_anon 原地升级」那条分支由 `apps/api` 的 auth 用例覆盖
   * （TP-1-35 的第一场景），它在开关打开时仍然有效。
   */
  async function cookieFor(kase: Case): Promise<string> {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `case-${kase.index}@example.com`,
        password: 'a-sufficiently-long-passphrase-1',
        display_name: `用例 ${kase.index}`,
      },
    });
    expect(registered.statusCode, `注册应成功：${registered.body}`).toBe(201);
    return cookieFrom(registered.headers['set-cookie'], COOKIE_NAMES.session);
  }

  function requestBody(kase: Case): Record<string, unknown> {
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + (kase.totalDays - 1) * 86_400_000);
    const iso = (date: Date): string => date.toISOString().slice(0, 10);

    return {
      schema_version: 'travel_request_ui_v1',
      client_request_id: `acceptance-${kase.index}-${Math.random().toString(36).slice(2)}`,
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
      travelers: { adults: 2, children: [...kase.profile.children], seniors: [] },
      budget: {
        currency: 'CNY',
        basis: 'PER_PERSON_PER_DAY',
        min: kase.profile.budget.min,
        max: kase.profile.budget.max,
        included_items: ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'],
      },
      pace: { level: kase.profile.pace },
      conditions: kase.profile.conditions.map((condition) => ({ ...condition })),
      custom_requirements: { raw_text: '想看运河和博物馆。' },
      output_preferences: {
        language: 'zh-CN',
        template_id: 'travel_infographic_v1',
        generate_png: true,
        generate_pdf: true,
      },
    };
  }

  /*
   * 用 `it.each` 而不是一个 for 循环包一个 it：前者让 20 条在报告里各占一行，
   * 失败时能直接看出是「14 天全挂」还是「素食那一列全挂」——
   * 而循环里的断言失败只会显示第一个失败点，后面 19 条根本没跑。
   */
  it.each(CASES.map((kase) => [kase.name, kase] as const))(
    '%s',
    async (_name, kase) => {
      const cookie = await cookieFor(kase);

      // ── 提交（门禁 #21：匿名无需 401 也能提交）──
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/travel-plans/generate',
        headers: { cookie },
        payload: requestBody(kase),
      });
      expect(created.statusCode, `提交应成功：${created.body}`).toBe(201);
      const handles = created.json<{ plan_id: string; job_id: string; request_id: string }>();

      // ── 消费（真实队列消息，载荷由 schema 解析）──
      const waiting = await rawQueue.getJobs(['waiting', 'delayed', 'prioritized']);
      expect(waiting).toHaveLength(1);
      const payload = GenerationJobPayloadSchema.parse(waiting[0]!.data);

      const outcome = await generatePlan(createE2eWorkerDeps(pool), payload);
      expect(outcome.outcome, `生成应成功：${JSON.stringify(outcome)}`).toBe('saved');

      // ── 门禁 #1：任务走到 COMPLETED，全程无人工介入 ──
      const job = await app.inject({
        method: 'GET',
        url: `/api/v1/generation-jobs/${handles.job_id}`,
        headers: { cookie },
      });
      expect(job.statusCode).toBe(200);
      expect(job.json()).toMatchObject({ status: 'COMPLETED', progress: 100 });

      // ── 门禁 #2：版本落库且 plan_json 可被 Zod 解析 ──
      const plan = await app.inject({
        method: 'GET',
        url: `/api/v1/travel-plans/${handles.plan_id}`,
        headers: { cookie },
      });
      expect(plan.statusCode).toBe(200);
      const parsed = TravelPlanSchema.safeParse(plan.json());
      expect(parsed.success, `plan_json 应满足契约：${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
      if (!parsed.success) return;

      // 天数跟随请求（6.3 的分段生成在 7 天以上会走两次模型再合并）
      expect(parsed.data.days).toHaveLength(kase.totalDays);
      expect(parsed.data.days.map((day) => day.day_number)).toEqual(
        Array.from({ length: kase.totalDays }, (_, i) => i + 1),
      );

      // ── 门禁 #3：COMPLETED 的任务不得有 BLOCKING 违规 ──
      const report: ConstraintReport = parsed.data.constraint_report;
      const blocking = report.violated.filter((violation) => isBlocking(violation.severity));
      expect(blocking, `不应有阻断级违规：${JSON.stringify(blocking)}`).toEqual([]);

      // ── 门禁 #4：展示行数 = total_days + 1（含 FULL_PLAN）──
      const presentations = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM plan_presentations
          WHERE plan_version_id = (SELECT current_version_id FROM travel_plans WHERE id = $1)`,
        [handles.plan_id],
      );
      expect(presentations.rows[0]!.count).toBe(String(kase.totalDays + 1));

      // ── 门禁 #12：素材来源可追溯 ──
      const assets = await pool.query<{ bad: string }>(
        `SELECT count(*)::text AS bad
           FROM assets
          WHERE source_type IS NULL
             OR license_type IS NULL
             OR representation_type IS NULL
             OR (source_type = 'AI_GENERATED' AND generation_metadata IS NULL)`,
      );
      expect(assets.rows[0]!.bad).toBe('0');

      // ── 门禁 #19：单任务 AI 图片不超过 3 张、LLM 调用不超过 3 次 ──
      const cost = await pool.query<{ ai: string; regenerations: number }>(
        /*
         * `count(DISTINCT a.id)` 而不是 `count(*)`：一张 AI 图会被多个槽位
         * 绑定引用（14 天的 Hero 复用同一张缓存产物），按绑定数计会虚高 ——
         * 实测 14 天档因此算出 4 张而上限是 3。
         *
         * 而 21.4 的上限管的是**模型调用次数**，一次调用产出一张素材，
         * 因此 distinct 素材数才是它的对应量。
         */
        `SELECT (SELECT count(DISTINCT a.id)::text
                   FROM assets a
                   JOIN plan_asset_bindings b ON b.asset_id = a.id
                  WHERE b.plan_version_id = v.id AND a.source_type = 'AI_GENERATED') AS ai,
                v.regeneration_count AS regenerations
           FROM travel_plan_versions v
          WHERE v.id = (SELECT current_version_id FROM travel_plans WHERE id = $1)`,
        [handles.plan_id],
      );
      expect(Number(cost.rows[0]!.ai)).toBeLessThanOrEqual(3);
      // 1 次主生成 + 最多 2 次定向重生成（21.4）
      expect(cost.rows[0]!.regenerations).toBeLessThanOrEqual(2);

      /*
       * ── 21.4 的「匿名 AI Hero 额度为 0」不再在这里断言（P7）──
       *
       * 那条断言原本挂在匿名用例上，而 P7 之后这里没有匿名用例了。
       *
       * **能力本身仍在**（`AiImageBudget` 的 `heroQuota: 0` → 拒绝并给出
       * `HERO_QUOTA_EXHAUSTED`），且由 `assets/ai-budget.test.ts` 的
       * 「TP-4-17 匿名的 AI Hero 额度为 0」一组用例直接覆盖 ——
       * 那一组不经 API，因此与匿名入口的开关状态无关。
       *
       * 把它记在这里而不是默默删掉：这一条是 21.4 的成本上限里唯一按身份
       * 分档的规则，将来重新打开匿名入口时，它需要重新回到端到端覆盖。
       */
    },
    /*
     * 单个用例 30 秒。14 天档要跑两次模型调用、15 个展示页、
     * 以及最多 3 次图片后处理（sharp 的 WebP 编码是 CPU 密集的）。
     * vitest 默认的 5 秒会让那一档在慢机器上偶发超时，
     * 而那种红是「测试环境慢」而不是「代码坏了」。
     */
    30_000,
  );

  it('20 个用例覆盖 24.1 #1 点名的四个天数档与两种身份', () => {
    /*
     * 元断言：矩阵本身是对的。
     *
     * 有人删掉一个 profile 时上面 20 条会变成 16 条并全部通过 ——
     * 而 24.1 #1 的通过线是「20 个」。没有这条断言的话，覆盖面缩水
     * 不会有任何症状。
     */
    expect(CASES).toHaveLength(20);
    expect([...new Set(CASES.map((kase) => kase.totalDays))].sort((a, b) => a - b)).toEqual([
      1, 3, 7, 14,
    ]);
    /*
     * P7：原先这里有两条身份轴的断言（匿名 10、注册 10）。身份轴移除后
     * 换成「五种约束组合各覆盖到」—— 那是矩阵的第二个轴，
     * 也是身份轴移除后唯一还能缩水而无症状的维度。
     */
    expect([...new Set(CASES.map((kase) => kase.profile.label))]).toEqual(
      PROFILES.map((profile) => profile.label),
    );
    // 每个天数档下五种约束组合各一次
    for (const days of DAY_COUNTS) {
      const labels = CASES.filter((kase) => kase.totalDays === days).map(
        (kase) => kase.profile.label,
      );
      expect(labels).toEqual(PROFILES.map((profile) => profile.label));
    }
  });
});
