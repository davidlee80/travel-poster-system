import { InMemoryPlanQueue } from '@tps/queue';
import { makeValidRequest } from '@tps/planning';
import {
  FORBIDDEN_PROJECTION_KEYS,
  TRAVEL_PLAN_FIXTURES,
  findForbiddenProjectionKeys,
} from '@tps/schemas';
import { Writable } from 'node:stream';
import {
  COOKIE_NAMES,
  GracefulShutdown,
  InMemoryCounterStore,
  InMemoryIdempotencyLock,
  QuotaGuard,
  createLogger,
  createSilentLogger,
  type FeatureFlags,
  type IdempotencyLock,
  type QuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import {
  InMemoryCreditWalletRepository,
  UniqueViolationError,
  samplePriceBook,
  type CancelJobResult,
  type PresentationDetail,
  type PresentationsRepository,
  type TravelPlansRepository,
} from '@tps/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_JOB_LIMITS } from '@tps/billing';

import { CreditsService } from '../credits/service.js';
import { FakeUsersRepository } from '../identity/fake-users-repository.js';
import { InMemorySessionStore } from '../identity/session-store.js';
import { IdentityService } from '../identity/service.js';
import { buildServer } from '../server.js';

/**
 * 计划端点（TP-2-06、TP-2-09、TP-2-15、TP-2-28、TP-2-30）。
 *
 * 仓储用假实现：SQL 行为由 `@tps/db` 的集成测试覆盖，这里测的是
 * **HTTP 契约与幂等编排** —— 状态码、错误体形态、扣配额的时机、
 * 幂等三条路径（既有命中 / 锁占用 / 唯一索引兜底）。
 */

const config: ServiceConfig = {
  serviceName: 'tps-api-test',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

const quotaConfig: QuotaConfig = {
  anonymous: { perMinute: 10, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 0 },
  registered: { perMinute: 10, dailyPlans: 5, monthlyPlans: 20, exportsPerPlan: 10, aiHero: 2 },
  ip: { anonCreatePerHour: 100, anonCreatePerDay: 200, plansPerDay: 100, loginFailuresPerHour: 10 },
  emailLoginFailuresPerHour: 5,
  /*
   * 少了这一项，`anonTtlSeconds()` 会算出 NaN，匿名令牌的过期时间成为
   * Invalid Date，于是每次请求都解析不出身份、现场重新建号。
   * 症状是「幂等完全没生效」，而根因在测试夹具里。
   */
  anonTokenTtlDays: 30,
};

/**
 * 假展示仓储（13.4）。
 *
 * 按 `(plan_id, page_type, day_number)` 存 ViewModel，**不按 user_id**：
 * 归属过滤与 REJECTED 过滤都是真实仓储的 SQL 谓词，
 * 由 `presentations.integration.test.ts` 覆盖。在假实现里再写一遍
 * 只会测到我对那条 SQL 的理解，而不是那条 SQL。
 *
 * 这里要覆盖的是端点自己的行为：路由匹配、天号校验、404 与 401 的分界。
 */
class FakePresentationsRepository implements PresentationsRepository {
  readonly rows = new Map<string, PresentationDetail>();

  private key(planId: string, pageType: string, dayNumber?: number): string {
    return [planId, pageType, dayNumber ?? 'full'].join('|');
  }

  put(input: {
    planId: string;
    pageType: 'DAILY_POSTER' | 'FULL_PLAN';
    dayNumber?: number;
    detail: PresentationDetail;
  }): void {
    this.rows.set(this.key(input.planId, input.pageType, input.dayNumber), input.detail);
  }

  savePresentations(): Promise<void> {
    return Promise.resolve();
  }

  findPresentation(input: {
    planId: string;
    pageType: 'DAILY_POSTER' | 'FULL_PLAN';
    dayNumber?: number;
  }): Promise<PresentationDetail | null> {
    return Promise.resolve(
      this.rows.get(this.key(input.planId, input.pageType, input.dayNumber)) ?? null,
    );
  }

  findPresentationByVersion(): Promise<PresentationDetail | null> {
    throw new Error('API 端点不应调用 findPresentationByVersion（那是渲染路由的入口）');
  }

  listDayNumbers(): Promise<never[]> {
    // 13.4 端点不会调用它 —— 它是导出链路（TP-4-12）用来枚举要渲染的天号的
    return Promise.resolve([]);
  }

  saveBindings(): Promise<void> {
    return Promise.resolve();
  }

  listBindings(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

/**
 * 假仓储。
 *
 * 只保留幂等判定真正需要的状态（按 key 索引的一行 + 任务状态），
 * 不模拟 SQL。模拟 SQL 的假实现会让测试通过而真实查询失败 ——
 * 那正是 `travel-plans.integration.test.ts` 的职责。
 */
class FakePlansRepository implements TravelPlansRepository {
  private sequence = 0;
  readonly byKey = new Map<
    string,
    {
      requestId: string;
      planId: string;
      jobId: string;
      jobStatus: string;
      createdAt: Date;
      userId: string;
    }
  >();
  readonly plans = new Map<string, { userId: string; planJson: unknown }>();
  readonly jobs = new Map<
    string,
    {
      userId: string;
      planId: string | null;
      status: string;
      progress: number;
      message: string | null;
      errorCode: string | null;
    }
  >();
  readonly listByUser = new Map<string, { planId: string; createdAt: Date }[]>();
  /** 置为 true 时下一次 createGeneration 抛唯一约束冲突（模拟 Redis 失效后的兜底） */
  forceUniqueViolation = false;

  createGeneration(input: {
    userId: string;
    idempotencyKey: string;
  }): Promise<{ requestId: string; planId: string; jobId: string }> {
    if (this.forceUniqueViolation) {
      this.forceUniqueViolation = false;
      return Promise.reject(new UniqueViolationError('travel_requests_idempotency_uk'));
    }

    this.sequence += 1;
    const handles = {
      requestId: `request-${this.sequence}`,
      planId: `plan-${this.sequence}`,
      jobId: `job-${this.sequence}`,
    };
    this.byKey.set(input.idempotencyKey, {
      ...handles,
      jobStatus: 'QUEUED',
      createdAt: new Date('2026-04-01T00:00:00Z'),
      userId: input.userId,
    });
    this.jobs.set(handles.jobId, {
      userId: input.userId,
      planId: handles.planId,
      status: 'QUEUED',
      progress: 0,
      message: '已加入队列，正在等待处理',
      errorCode: null,
    });
    return Promise.resolve(handles);
  }

  findByIdempotencyKey(userId: string, key: string) {
    const row = this.byKey.get(key);
    if (row === undefined || row.userId !== userId) return Promise.resolve(null);
    return Promise.resolve({
      requestId: row.requestId,
      planId: row.planId,
      jobId: row.jobId,
      jobStatus: row.jobStatus,
      createdAt: row.createdAt,
    });
  }

  findPlanForUser(planId: string, userId: string) {
    const plan = this.plans.get(planId);
    // 13.0：他人资源与不存在的资源返回同一结果
    if (plan === undefined || plan.userId !== userId) return Promise.resolve(null);
    return Promise.resolve({
      planId,
      planStatus: 'READY',
      planVersionId: 'version-1',
      versionStatus: 'READY',
      planJson: plan.planJson,
    });
  }

  findJobForUser(jobId: string, userId: string) {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.userId !== userId) return Promise.resolve(null);
    return Promise.resolve({
      jobId,
      planId: job.planId,
      status: job.status,
      progress: job.progress,
      message: job.message,
      errorCode: job.errorCode,
      warnings: [],
      /*
       * 里程碑按状态推断（21.2）：真实实现里它们是两个由 Worker 写入的时刻，
       * 而假仓储没有 Worker —— 用状态映射出等价的结果。
       * `SAVING_PLAN` 及之后计划可读、`RESOLVING_ASSETS` 之后页面可看。
       */
      t1At: T1_REACHED.has(job.status) ? new Date('2026-04-01T10:00:30Z') : null,
      t2At: T2_REACHED.has(job.status) ? new Date('2026-04-01T10:01:20Z') : null,
    });
  }

  /*
   * Worker 侧的三个方法在 API 测试里不该被调用 —— 它们属于生成链路。
   * 抛错而不是返回空值：真被调用了说明端点越界碰了 Worker 的职责，
   * 而返回空值会让那种越界静默通过。
   */
  findJobContext(): never {
    throw new Error('API 端点不应调用 findJobContext');
  }
  cancelJob(jobId: string, userId: string): Promise<CancelJobResult> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.userId !== userId) return Promise.resolve('not_found');
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      return Promise.resolve('already_terminal');
    }
    this.jobs.set(jobId, { ...job, status: 'CANCELLED', message: '已取消生成' });
    return Promise.resolve('cancelled');
  }

  markMilestone(): never {
    throw new Error('API 端点不应调用 markMilestone（里程碑由 Worker 写入）');
  }
  appendJobWarnings(): never {
    throw new Error('API 端点不应调用 appendJobWarnings（告警由 Worker 写入）');
  }
  findJobQueueTiming(): never {
    throw new Error('API 端点不应调用 findJobQueueTiming（队列超时判定在 Worker 侧）');
  }
  updateJobState(): never {
    throw new Error('API 端点不应调用 updateJobState');
  }
  savePlanVersion(): never {
    throw new Error('API 端点不应调用 savePlanVersion');
  }

  listPlansForUser(input: { userId: string; limit: number; cursor?: string }) {
    const all = this.listByUser.get(input.userId) ?? [];
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const slice = all.slice(start, start + input.limit);
    const hasMore = start + input.limit < all.length;
    return Promise.resolve({
      items: slice.map((entry) => ({
        planId: entry.planId,
        title: '杭州五日文化慢游计划',
        destinationName: '杭州',
        startDate: '2026-04-10',
        totalDays: 5,
        status: 'READY',
        // TP-3-15 的封面：假仓储不产生绑定，因此恒为 null
        coverUrl: null,
        createdAt: entry.createdAt,
      })),
      hasMore,
      nextCursor: hasMore ? String(start + input.limit) : null,
    });
  }
}

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly repository: FakePlansRepository;
  readonly presentations: FakePresentationsRepository;
  readonly queue: InMemoryPlanQueue;
  readonly users: FakeUsersRepository;
  readonly wallet: InMemoryCreditWalletRepository;
}

let harness: Harness | null = null;

/**
 * 固定的「现在」。
 *
 * 请求 fixture 的出发日期是 2026-04-10，N-01 要求它不早于今天，
 * 因此测试必须把时钟钉在那之前。**假仓储必须用同一个时钟** ——
 * 用真实时钟的话，匿名令牌的 30 天有效期从 2026-04-01 起算，
 * 对真实的「今天」而言早已过期，于是每个请求都解析不出身份、现场重新建号，
 * 幂等测试全部得到 201。那种失败看起来像「幂等没实现」。
 */
const NOW = new Date('2026-04-01T10:00:00Z');
const now = (): Date => NOW;

/** T1 达成后的状态（21.2：`SAVING_PLAN` 完成即 13.3 可读） */
const T1_REACHED = new Set([
  'SAVING_PLAN',
  'BUILDING_PRESENTATION',
  'RESOLVING_ASSETS',
  'GENERATING_ASSETS',
  'RENDERING_HTML',
  'COMPLETED',
]);

/** T2 达成后的状态（13.4 可读） */
const T2_REACHED = new Set(['RENDERING_HTML', 'COMPLETED']);

function build(
  lock: IdempotencyLock = new InMemoryIdempotencyLock(),
  featureFlags?: FeatureFlags,
  /** 装配 CR 计费。缺省不装 —— 既有用例测的是幂等编排，与钱无关 */
  billing: 'off' | 'on' = 'off',
): Harness {
  const users = new FakeUsersRepository(now);
  const sessions = new InMemorySessionStore();
  const quota = new QuotaGuard({
    config: quotaConfig,
    store: new InMemoryCounterStore(),
    now,
  });
  const identity = new IdentityService({
    users,
    sessions,
    quota,
    quotaConfig,
    now,
    secureCookies: false,
    // P7：这些用例验的是 R-13 的双模式行为，因此显式打开匿名入口
    anonymousEnabled: true,
  });

  const repository = new FakePlansRepository();
  const presentations = new FakePresentationsRepository();
  const queue = new InMemoryPlanQueue();

  const wallet = new InMemoryCreditWalletRepository();
  wallet.priceBook = samplePriceBook();
  const credits =
    billing === 'off'
      ? undefined
      : new CreditsService({
          wallet,
          config: { crPerCny: 1_000, signupGrantCr: 9_900, holdBufferPercent: 120 },
          limits: DEFAULT_JOB_LIMITS,
          logger: createSilentLogger(),
          now,
        });

  const app = buildServer({
    config,
    logger: createSilentLogger(),
    shutdown: new GracefulShutdown({ logger: createSilentLogger(), timeoutMs: 1_000 }),
    auth: { identity, quota, secureCookies: false },
    travelPlans: {
      identity,
      quota,
      queue,
      plans: repository,
      presentations,
      idempotencyLock: lock,
      ...(featureFlags === undefined ? {} : { featureFlags }),
      secureCookies: false,
      // N-01 需要「今天」；请求 fixture 的出发日期是 2026-04-10
      now,
      ...(credits === undefined ? {} : { credits }),
    },
  });

  return { app, repository, presentations, queue, users, wallet };
}

beforeEach(() => {
  harness = build();
});

afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

function h(): Harness {
  if (harness === null) throw new Error('harness 未初始化');
  return harness;
}

/**
 * 取一个匿名身份的 Cookie 头。
 *
 * 逐条找 `Set-Cookie` 再截到第一个 `;`，不能把整个数组 join 起来交给
 * `parseCookies` —— 后者会把 `Path`、`Max-Age` 也当成 Cookie，而
 * `Expires=Thu, 01 Jan...` 里的逗号与分号会把值截断，取出来的 token 是残缺的。
 * 残缺 token 解析不出身份，于是每个请求都现场建一个新匿名用户，
 * 幂等测试全部得到 201 —— 一个看起来像「幂等没实现」的假象。
 */
async function anonymousCookie(): Promise<string> {
  const response = await h().app.inject({ method: 'GET', url: '/api/v1/auth/session' });
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];

  const entry = list.find((cookie) => cookie.startsWith(`${COOKIE_NAMES.anonymous}=`));
  if (entry === undefined) throw new Error('会话端点没有下发 tp_anon');

  const value = entry.slice(COOKIE_NAMES.anonymous.length + 1).split(';')[0] ?? '';
  return `${COOKIE_NAMES.anonymous}=${value}`;
}

const body = () => makeValidRequest();

describe('13.1 POST /travel-plans/generate', () => {
  it('无任何身份也能生成：现场建号并返回 201', async () => {
    // 13.0 第 3.a 条：生成端点永不因为缺少身份而返回 401
    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      request_id: 'request-1',
      plan_id: 'plan-1',
      job_id: 'job-1',
      status: 'QUEUED',
    });
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('入队载荷只含标识符，不含请求体', async () => {
    /*
     * 载荷里带请求体会在 Redis 里留下一份 L1 个人数据副本，
     * 而它不受 15.1 的保留策略管辖 —— 用户删了账号，那份还在。
     */
    await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
    });

    expect(h().queue.enqueued).toEqual([
      { jobId: 'job-1', requestId: 'request-1', planId: 'plan-1', userId: expect.any(String) },
    ]);
    expect(JSON.stringify(h().queue.enqueued)).not.toContain('杭州');
  });

  it('结构非法返回 400 REQ_SCHEMA_INVALID 且带 field', async () => {
    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: { schema_version: 'travel_request_ui_v1' },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<{ error: { code: string; field?: string } }>().error;
    expect(error.code).toBe('REQ_SCHEMA_INVALID');
    expect(error.field).toBeDefined();
  });

  it('业务冲突返回对应 N-xx 错误码与 field，且不入队', async () => {
    /*
     * 3.1.2 的检查在同步路径上执行，失败直接 4xx，不入队、不调用 LLM。
     * 一次 LLM 调用几分钱，而「出发日期在过去」在入队前就能拦住。
     */
    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: makeValidRequest({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-03-01', end_date: '2026-03-05', flexibility_days: 0 },
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string; field: string } }>().error).toMatchObject({
      code: 'REQ_START_DATE_IN_PAST',
      field: 'trip.dates.start_date',
      retryable: false,
    });
    expect(h().queue.enqueued).toEqual([]);
  });

  it('错误体六个字段齐全（13.0）', async () => {
    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: { bad: true },
    });

    const error = response.json<{ error: Record<string, unknown> }>().error;
    expect(Object.keys(error).sort()).toEqual(
      ['code', 'field', 'message', 'request_id', 'retryable', 'trace_id'].sort(),
    );
    expect(typeof error['message']).toBe('string');
    expect(typeof error['retryable']).toBe('boolean');
  });
});

describe('13.8 幂等', () => {
  it('同一身份重复提交相同需求：第二次 409 且带既有 job_id', async () => {
    const cookie = await anonymousCookie();
    const payload = body();

    const first = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload,
    });

    // 任务仍在进行中 → 409 + 既有 job_id，客户端应改为轮询
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('JOB_ALREADY_RUNNING');
    expect(second.headers['x-tps-job-id']).toBe('job-1');
  });

  it('既有任务已完成时返回 200 与同一组 ID', async () => {
    const cookie = await anonymousCookie();
    const payload = body();

    await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload,
    });

    // 把既有任务标成终态
    for (const row of h().repository.byKey.values()) {
      h().repository.byKey.set([...h().repository.byKey.keys()][0]!, {
        ...row,
        jobStatus: 'COMPLETED',
      });
    }

    const again = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload,
    });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ plan_id: 'plan-1', job_id: 'job-1' });
  });

  it('幂等命中不计入配额（21.4）', async () => {
    /*
     * 顺序写反（先扣配额再查既有）时这条会失败。真实后果是用户刷新页面
     * 重试就被扣一次额度 —— 匿名用户日配额只有 5 个，刷几次就没了。
     */
    const cookie = await anonymousCookie();
    const payload = body();

    for (let i = 0; i < 8; i += 1) {
      await h().app.inject({
        method: 'POST',
        url: '/api/v1/travel-plans/generate',
        headers: { cookie },
        payload,
      });
    }

    const session = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    const quota = session.json<{ quota: { daily_remaining: number } }>().quota;
    // 8 次提交只有第一次创建，因此只扣了 1 个额度
    expect(quota.daily_remaining).toBe(4);
  });

  it('Redis 锁不可用时靠唯一索引兜底（13.8）', async () => {
    /*
     * 「Redis 关闭后唯一索引仍生效」。这里让 `acquire` 直接抛错（等价于
     * Redis 挂了）：端点必须 fail open 继续往下走，由唯一索引冲突兜住重复，
     * 并转为返回既有任务 —— 而不是 500，也不是重复生成一份。
     */
    await harness?.app.close();
    harness = build({
      acquire: () => Promise.reject(new Error('Redis 不可用')),
    });

    const cookie = await anonymousCookie();
    const payload = body();

    const first = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload,
    });
    expect(first.statusCode).toBe(201);

    // 既有任务置为终态，模拟「上一次已经生成完了」
    const key = [...h().repository.byKey.keys()][0]!;
    const row = h().repository.byKey.get(key)!;
    h().repository.byKey.set(key, { ...row, jobStatus: 'COMPLETED' });
    h().repository.forceUniqueViolation = true;

    const second = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ job_id: 'job-1' });
  });

  it('唯一索引冲突后仍查不到既有行时返回 500，不假装成功', async () => {
    /*
     * 这个分支理论上不可达（INSERT 冲突意味着行一定存在）。
     * 返回既有 ID 的「乐观兜底」在这里是危险的：那些 ID 是编造的，
     * 客户端会拿着一个不存在的 plan_id 去轮询，永远等不到结果。
     */
    await harness?.app.close();
    harness = build({ acquire: () => Promise.resolve(true) });

    const cookie = await anonymousCookie();
    h().repository.forceUniqueViolation = true;

    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    expect(response.statusCode).toBe(500);
  });

  it('TP-2-29：两个匿名用户提交相同需求各自生成', async () => {
    const payload = body();
    const cookieA = await anonymousCookie();
    const cookieB = await anonymousCookie();
    expect(cookieA).not.toBe(cookieB);

    const a = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie: cookieA },
      payload,
    });
    const b = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie: cookieB },
      payload,
    });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json<{ plan_id: string }>().plan_id).not.toBe(b.json<{ plan_id: string }>().plan_id);
  });

  it('幂等键由 user_id + client_request_id + 标准化请求算出', async () => {
    // 与端点实际使用的键对齐：算法改了但端点没跟上时，
    // 幂等会静默失效（每次都算出新键，每次都创建）
    const cookie = await anonymousCookie();
    await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });

    const stored = [...h().repository.byKey.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('13.2 GET /generation-jobs/{job_id}', () => {
  it('返回 job_id / status / progress / message', async () => {
    const cookie = await anonymousCookie();
    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    const jobId = created.json<{ job_id: string }>().job_id;

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job_id: jobId,
      status: 'QUEUED',
      progress: 0,
      message: '已加入队列，正在等待处理',
      // TP-4-09：非阻断告警随状态一起返回，前端据此提示「部分配图使用默认样式」
      warnings: [],
    });
  });

  it('progress 取库里的值，不在读路径重算（16.2 单调不减）', async () => {
    /*
     * 读路径重算会在回边处把 54 显示成 48 —— 进度条倒退。
     * 这里把任务置成 REPAIRING_PLAN 之后的回边状态：
     * status 是 VALIDATING_PLAN（查表 48），但库里的 progress 是 54。
     */
    const cookie = await anonymousCookie();
    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    const jobId = created.json<{ job_id: string }>().job_id;

    const job = h().repository.jobs.get(jobId)!;
    h().repository.jobs.set(jobId, { ...job, status: 'VALIDATING_PLAN', progress: 54 });

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie },
    });
    expect(response.json<{ progress: number }>().progress).toBe(54);
  });

  it('FAILED 的文案取自 13.7 错误码', async () => {
    const cookie = await anonymousCookie();
    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    const jobId = created.json<{ job_id: string }>().job_id;

    const job = h().repository.jobs.get(jobId)!;
    h().repository.jobs.set(jobId, {
      ...job,
      status: 'FAILED',
      message: null,
      errorCode: 'PLAN_HARD_CONSTRAINT_UNSATISFIABLE',
    });

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie },
    });
    const payload = response.json<{ message: string; error_code: string }>();
    expect(payload.error_code).toBe('PLAN_HARD_CONSTRAINT_UNSATISFIABLE');
    expect(payload.message).toContain('放宽');
  });

  it('他人的任务返回 404 而不是 403', async () => {
    const cookieA = await anonymousCookie();
    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie: cookieA },
      payload: body(),
    });
    const jobId = created.json<{ job_id: string }>().job_id;

    const cookieB = await anonymousCookie();
    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie: cookieB },
    });

    // 403 会告诉攻击者「这个 ID 存在，只是不属于你」
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('JOB_NOT_FOUND');
  });

  it('无身份返回 401（非生成端点不现场建号）', async () => {
    const response = await h().app.inject({ method: 'GET', url: '/api/v1/generation-jobs/x' });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('AUTH_IDENTITY_REQUIRED');
  });
});

describe('取消任务（R-33、16.1，TP-4-08）', () => {
  async function createJob(cookie: string): Promise<string> {
    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    return created.json<{ job_id: string }>().job_id;
  }

  it('非终态任务被取消，状态转 CANCELLED', async () => {
    const cookie = await anonymousCookie();
    const jobId = await createJob(cookie);

    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job_id: jobId,
      status: 'CANCELLED',
      cancelled: true,
      message: '已取消生成',
    });
  });

  it('重复取消返回 200 且 cancelled 为 false（幂等，不是 409）', async () => {
    /*
     * 用户点「取消」的那一刻任务可能刚好完成。返回 409 会让前端弹一个
     * 「操作冲突」，而用户想要的结果（任务不再继续）已经达成。
     */
    const cookie = await anonymousCookie();
    const jobId = await createJob(cookie);

    await h().app.inject({
      method: 'POST',
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: { cookie },
    });
    const again = await h().app.inject({
      method: 'POST',
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: { cookie },
    });

    expect(again.statusCode).toBe(200);
    expect(again.json<{ cancelled: boolean }>().cancelled).toBe(false);
  });

  it('他人的任务返回 404（越权取消比越权读取更严重）', async () => {
    const cookie = await anonymousCookie();
    const jobId = await createJob(cookie);
    const otherCookie = await anonymousCookie();

    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: { cookie: otherCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('JOB_NOT_FOUND');
  });

  it('无身份返回 401', async () => {
    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/generation-jobs/x/cancel',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('13.3 GET /travel-plans/{plan_id}', () => {
  it('返回完整 TravelPlan', async () => {
    const cookie = await anonymousCookie();
    const session = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    const userId = session.json<{ user_id: string }>().user_id;

    const plan = TRAVEL_PLAN_FIXTURES.oneDay();
    h().repository.plans.set('plan-x', { userId, planJson: plan });

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-x',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ title: string }>().title).toBe(plan.title);
  });

  it('他人的计划返回 404 PLAN_NOT_FOUND', async () => {
    const cookie = await anonymousCookie();
    h().repository.plans.set('plan-y', { userId: 'someone-else', planJson: {} });

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-y',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PLAN_NOT_FOUND');
  });

  it('不存在的计划与他人的计划返回完全相同的响应体', async () => {
    // 两者可区分就等于给了一个枚举计划 ID 的接口
    const cookie = await anonymousCookie();
    h().repository.plans.set('plan-z', { userId: 'someone-else', planJson: {} });

    const foreign = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-z',
      headers: { cookie },
    });
    const missing = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-missing',
      headers: { cookie },
    });

    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.json<{ error: { code: string } }>().error.code).toBe(
      missing.json<{ error: { code: string } }>().error.code,
    );
  });
});

describe('13.9.5 GET /travel-plans（列表）', () => {
  async function seed(count: number): Promise<string> {
    const cookie = await anonymousCookie();
    const session = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    const userId = session.json<{ user_id: string }>().user_id;

    h().repository.listByUser.set(
      userId,
      Array.from({ length: count }, (_, i) => ({
        planId: `plan-${i}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, i)),
      })),
    );
    return cookie;
  }

  it('返回 items / next_cursor / has_more', async () => {
    const cookie = await seed(3);
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      items: { plan_id: string; cover_url: null; created_at: string }[];
      next_cursor: string | null;
      has_more: boolean;
    }>();
    expect(payload.items).toHaveLength(3);
    expect(payload.has_more).toBe(false);
    expect(payload.next_cursor).toBeNull();
    expect(payload.items[0]!.cover_url).toBeNull();
    expect(payload.items[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('超过 limit 时给出游标，翻页不重复', async () => {
    const cookie = await seed(5);
    const first = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans?limit=2',
      headers: { cookie },
    });
    const firstPage = first.json<{ items: { plan_id: string }[]; next_cursor: string }>();
    expect(firstPage.items.map((i) => i.plan_id)).toEqual(['plan-0', 'plan-1']);

    const second = await h().app.inject({
      method: 'GET',
      url: `/api/v1/travel-plans?limit=2&cursor=${firstPage.next_cursor}`,
      headers: { cookie },
    });
    const secondPage = second.json<{ items: { plan_id: string }[] }>();
    expect(secondPage.items.map((i) => i.plan_id)).toEqual(['plan-2', 'plan-3']);
  });

  it('limit 越界返回 400 而不是静默截断', async () => {
    // 静默截断会让客户端以为「只有 50 条」，而实际还有更多
    const cookie = await anonymousCookie();
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans?limit=999',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('只返回自己的计划', async () => {
    const cookieA = await seed(2);
    const cookieB = await anonymousCookie();

    const mine = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans',
      headers: { cookie: cookieA },
    });
    const theirs = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans',
      headers: { cookie: cookieB },
    });

    expect(mine.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect(theirs.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('无身份返回 401', async () => {
    const response = await h().app.inject({ method: 'GET', url: '/api/v1/travel-plans' });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * 响应里绝不允许出现的键（二十章 L2 + 内部列）。
 *
 * 注意 `plan_id` / `request_id` / `job_id` **不在**清单里：它们是 13.1 的
 * 响应契约，且是用户自己资源的标识符。清单针对的是两类东西 ——
 * 别人的行程知识（L2 投影与向量）与本不该出网的内部列（幂等键、
 * 原始请求、标准化结果、口令哈希）。
 */
const FORBIDDEN_RESPONSE_KEYS = [
  'retrieval_projection',
  'retrievalProjection',
  'projection',
  'plan_embedding',
  'planEmbedding',
  'idempotency_key',
  'idempotencyKey',
  'raw_request',
  'rawRequest',
  'normalized_request',
  'normalizedRequest',
  'password_hash',
  'anon_token_hash',
] as const;

function findForbiddenResponseKeys(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, current: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${current}[${index}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const next = current === '' ? key : `${current}.${key}`;
      if ((FORBIDDEN_RESPONSE_KEYS as readonly string[]).includes(key)) hits.push(next);
      walk(child, next);
    }
  };
  walk(value, path);
  return hits;
}

describe('TP-2-30：L2 数据不出现在任何响应里', () => {
  it('三个端点的响应都不含脱敏投影与内部列', async () => {
    /*
     * 二十章 L2 的关键约束：脱敏投影可以进 LLM 上下文，但**不能通过任何
     * 端点返回给用户** —— 否则用户可以借生成接口把别人的行程读出来，
     * 等于绕过 L1 隔离。
     *
     * 用键名扫描而不是逐个字段断言：新增响应字段时这条会自动覆盖到，
     * 而逐个断言的写法永远只检查写测试那天存在的字段。
     */
    const cookie = await anonymousCookie();
    const session = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    const userId = session.json<{ user_id: string }>().user_id;
    h().repository.listByUser.set(userId, [{ planId: 'p1', createdAt: NOW }]);
    h().repository.plans.set('p1', { userId, planJson: TRAVEL_PLAN_FIXTURES.oneDay() });

    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    const jobResponse = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${created.json<{ job_id: string }>().job_id}`,
      headers: { cookie },
    });
    const listResponse = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans',
      headers: { cookie },
    });
    const planResponse = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/p1',
      headers: { cookie },
    });

    for (const response of [created, jobResponse, listResponse, planResponse]) {
      expect(response.statusCode).toBeLessThan(400);
      const payload: unknown = response.json();
      expect(findForbiddenResponseKeys(payload)).toEqual([]);
    }
  });

  it('扫描器真的能发现漏网字段', () => {
    // 若扫描函数写错而永远返回空数组，上面那条会永远通过 —— 一个什么都不查的检查
    expect(findForbiddenResponseKeys({ items: [{ retrieval_projection: {} }] })).toEqual([
      'items[0].retrieval_projection',
    ]);
  });

  it('投影本身的禁止键清单仍然有效（写入侧）', () => {
    // 响应侧与投影侧是两道不同的防线，各有各的清单
    expect(FORBIDDEN_PROJECTION_KEYS).toContain('constraint_report');
    expect(findForbiddenProjectionKeys({ days: [{ date: '2026-04-10' }] })).toEqual([
      'days[0].date',
    ]);
  });
});

describe('TP-2-31：日志不含禁记字段', () => {
  it('端点日志里没有 email、凭据与请求原文', async () => {
    /*
     * 二十章：`email`、`tp_session` / `tp_anon` 原文、`raw_request` 全文
     * 禁止落日志。脱敏本身由 `@tps/shared` 的 logger.test.ts 逐字段覆盖；
     * 这里确认的是**接进 Fastify 之后仍然生效** —— Fastify 会自己记录
     * 请求与响应，若 `loggerInstance` 的 redact 没被沿用，
     * `req.headers.cookie` 就会原样落盘。
     */
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });

    const users = new FakeUsersRepository();
    const quota = new QuotaGuard({
      config: quotaConfig,
      store: new InMemoryCounterStore(),
      now,
    });
    const identity = new IdentityService({
      users,
      sessions: new InMemorySessionStore(),
      quota,
      quotaConfig,
      now,
      secureCookies: false,
      // P7：这些用例验的是 R-13 的双模式行为，因此显式打开匿名入口
      anonymousEnabled: true,
    });

    const app = buildServer({
      config,
      logger: createLogger({ service: 'tps-api-test', level: 'info', destination }),
      shutdown: new GracefulShutdown({ logger: createSilentLogger(), timeoutMs: 1_000 }),
      auth: { identity, quota, secureCookies: false },
      travelPlans: {
        identity,
        quota,
        queue: new InMemoryPlanQueue(),
        plans: new FakePlansRepository(),
        presentations: new FakePresentationsRepository(),
        idempotencyLock: new InMemoryIdempotencyLock(),
        secureCookies: false,
        now,
      },
    });

    try {
      app.log.info(
        {
          user_id: 'u1',
          email: 'user@example.com',
          tp_anon: 'secret-token',
          raw_request: body(),
        },
        '测试日志',
      );
      await app.inject({
        method: 'POST',
        url: '/api/v1/travel-plans/generate',
        headers: { cookie: `${COOKIE_NAMES.anonymous}=cookie-secret-value` },
        payload: body(),
      });
    } finally {
      await app.close();
    }

    const output = chunks.join('');
    // 前置条件：真的写出了日志，否则下面的断言全部空转
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('测试日志');

    expect(output).not.toContain('user@example.com');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('cookie-secret-value');
    // raw_request 里的目的地不该出现（整体被剥离）
    expect(output).not.toContain('希望安排运河');
  });
});
describe('13.4 获取展示数据', () => {
  const VIEW_MODEL = { schema_version: 'travel_poster_view_model_v1', day_number: 3 };

  function detail(overrides: Partial<PresentationDetail> = {}): PresentationDetail {
    return {
      planVersionId: '11111111-1111-4111-8111-111111111111',
      templateId: 'ink_paper_v1',
      pageType: 'DAILY_POSTER',
      dayNumber: 3,
      validationStatus: 'DEGRADED',
      viewModel: VIEW_MODEL,
      ...overrides,
    };
  }

  it('按天取到 ViewModel，并带上 validation_status', async () => {
    const cookie = await anonymousCookie();
    h().presentations.put({
      planId: 'plan-1',
      pageType: 'DAILY_POSTER',
      dayNumber: 3,
      detail: detail(),
    });

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-1/presentations/3',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plan_id: 'plan-1',
      plan_version_id: '11111111-1111-4111-8111-111111111111',
      template_id: 'ink_paper_v1',
      page_type: 'DAILY_POSTER',
      day_number: 3,
      /*
       * DEGRADED 必须返回给前端：它据此提示「部分图片暂不可用」。
       * 不返回的话，用户只会看到几个占位块而不知道原因。
       */
      validation_status: 'DEGRADED',
      view_model: VIEW_MODEL,
    });
  });

  it('完整页走静态路由，不会被 :day_number 参数路由截走', async () => {
    const cookie = await anonymousCookie();
    h().presentations.put({
      planId: 'plan-1',
      pageType: 'FULL_PLAN',
      detail: detail({ pageType: 'FULL_PLAN', dayNumber: null, validationStatus: 'VALID' }),
    });

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-1/presentations/full',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ page_type: 'FULL_PLAN', day_number: null });
  });

  it.each([['0'], ['15'], ['abc'], ['-1'], ['1.5']])(
    '天号 %s 不合法 → 404（与「不存在」同一个码）',
    async (dayNumber) => {
      const cookie = await anonymousCookie();
      const response = await h().app.inject({
        method: 'GET',
        url: `/api/v1/travel-plans/plan-1/presentations/${dayNumber}`,
        headers: { cookie },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('PLAN_NOT_FOUND');
    },
  );

  it('尚未编排 → 404（正常时序，不是错误）', async () => {
    const cookie = await anonymousCookie();
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-1/presentations/1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('无身份 → 401（13.0：只有生成端点会现场建号）', async () => {
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-1/presentations/1',
    });

    expect(response.statusCode).toBe(401);
  });

  it('plan_version_id 不是 UUID → 400（不把垃圾字符串带进 SQL）', async () => {
    const cookie = await anonymousCookie();
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/travel-plans/plan-1/presentations/1?plan_version_id=not-a-uuid',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('TP-5-10 灰度开关', () => {
  it('生成关闭时返回 503 SYS_FEATURE_DISABLED，且不入队', async () => {
    const harness = build(new InMemoryIdempotencyLock(), {
      generationEnabled: false,
      exportEnabled: true,
      generationRolloutPercent: 100,
      anonymousEnabled: false,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string; retryable: boolean } }>().error).toMatchObject({
      code: 'SYS_FEATURE_DISABLED',
      // 放量扩大或开关重开后重试会成功，客户端据此保留用户填的表单
      retryable: true,
    });

    /*
     * 一个字都没入队。这是这条开关的意义所在 —— 紧急关停要立刻停掉成本，
     * 而入队之后再拒绝的话，那些消息迟早会被消费掉（也就是钱照花）。
     */
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it('放量 0% 时同样拦下，但原因不同（进指标，不进响应）', async () => {
    const harness = build(new InMemoryIdempotencyLock(), {
      generationEnabled: true,
      exportEnabled: true,
      generationRolloutPercent: 0,
      anonymousEnabled: false,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
    });

    /*
     * 用户看到的是同一个码与同一句文案 —— 他不需要知道自己「不在这批放量里」，
     * 那是我们的运维状态而不是他的问题。区分只在指标的 reason_code 上。
     */
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('SYS_FEATURE_DISABLED');
  });

  it('放量 100% 时照常放行', async () => {
    const harness = build(new InMemoryIdempotencyLock(), {
      generationEnabled: true,
      exportEnabled: true,
      generationRolloutPercent: 100,
      anonymousEnabled: false,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
    });

    expect(response.statusCode).toBe(201);
    expect(harness.queue.enqueued).toHaveLength(1);
  });

  it('未装配开关时视为全开（不因为漏配而拒绝服务）', async () => {
    const response = await build().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('13.2 的里程碑字段（21.2 措施一）', () => {
  /** 提交一个任务，返回 cookie 与 job_id */
  async function submitted(): Promise<{ cookie: string; jobId: string }> {
    const cookie = await anonymousCookie();
    const created = await h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      headers: { cookie },
      payload: body(),
    });
    return { cookie, jobId: created.json<{ job_id: string }>().job_id };
  }

  function milestonesOf(response: { json: <T>() => T }): unknown {
    return response.json<{ milestones: unknown }>().milestones;
  }

  it('T1 未达成时两个里程碑都是 false', async () => {
    const { cookie, jobId } = await submitted();

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie },
    });

    expect(milestonesOf(response)).toEqual({ plan_readable: false, page_viewable: false });
  });

  it('SAVING_PLAN 之后 plan_readable 为真（13.3 已可读）', async () => {
    const { cookie, jobId } = await submitted();
    const job = h().repository.jobs.get(jobId)!;
    h().repository.jobs.set(jobId, { ...job, status: 'SAVING_PLAN', progress: 60 });

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie },
    });

    /*
     * 21.2 的原文是「客户端据此提前展示，而不是等 status === 'COMPLETED'」。
     * 这两个布尔就是那个「据此」的对象 —— 在 P5 之前它们只存在于数据库与
     * 指标里，客户端读不到，于是那句「据此」没有对象。
     */
    expect(milestonesOf(response)).toEqual({ plan_readable: true, page_viewable: false });
  });

  it('COMPLETED 时 page_viewable 也为真（13.4 已可读）', async () => {
    const { cookie, jobId } = await submitted();
    const job = h().repository.jobs.get(jobId)!;
    h().repository.jobs.set(jobId, { ...job, status: 'COMPLETED', progress: 100 });

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: { cookie },
    });

    expect(milestonesOf(response)).toEqual({ plan_readable: true, page_viewable: true });
  });
});

describe('CR 闸门（C-3）', () => {
  /**
   * 装配了计费的独立夹具。
   *
   * 既有用例一律不装 —— 它们测的是幂等编排，而给每个用例都塞一个钱包
   * 会让「幂等命中不扣配额」这类断言多一个与它无关的失败原因。
   */
  function billingHarness(): Harness {
    harness = build(new InMemoryIdempotencyLock(), undefined, 'on');
    return harness;
  }

  /** 匿名身份的 Cookie 与它的 user_id —— 计费按 user_id 记账 */
  async function identity(): Promise<{ cookie: string; userId: string }> {
    const cookie = await anonymousCookie();
    const session = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    return { cookie, userId: session.json<{ user_id: string }>().user_id };
  }

  async function generate(cookie: string) {
    return h().app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload: body(),
      headers: { cookie },
    });
  }

  it('余额为 0 → 402，且不建任务行、不入队', async () => {
    /*
     * 「不建任务行」是这条用例的重点。反过来的话，每次余额不足都会留下
     * 一条 QUEUED 任务与一个被占用的幂等键 —— 用户充值后拿同一份表单重试
     * 会命中那个幂等键，得到一个永远不会跑的任务。
     */
    const { repository, queue } = billingHarness();
    const { cookie } = await identity();

    const response = await generate(cookie);

    expect(response.statusCode).toBe(402);
    const error = response.json<{
      error: { code: string; retryable: boolean; details: Record<string, number> };
    }>().error;
    expect(error.code).toBe('AUTH_INSUFFICIENT_CREDITS');
    /* 恢复路径是充值而不是重试 —— retryable 为真会让客户端原地重试到死 */
    expect(error.retryable).toBe(false);
    expect(error.details.balance_cr).toBe(0);
    expect(error.details.required_cr).toBeGreaterThan(0);

    expect(repository.byKey.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('余额够 → 201，并把预留额从可用挪到冻结', async () => {
    const { wallet } = billingHarness();
    const { cookie, userId } = await identity();
    wallet.seed(userId, 100_000);

    const response = await generate(cookie);
    expect(response.statusCode).toBe(201);

    const after = await wallet.balance(userId);
    expect(after.heldCr).toBeGreaterThan(0);
    /* 钱没有凭空多也没有凭空少 */
    expect(after.balanceCr + after.heldCr).toBe(100_000);
  });

  it('重复提交不冻结第二笔（13.8 的幂等命中先于预留）', async () => {
    const { wallet } = billingHarness();
    const { cookie, userId } = await identity();
    wallet.seed(userId, 100_000);

    const first = await generate(cookie);
    expect(first.statusCode).toBe(201);
    const held = (await wallet.balance(userId)).heldCr;

    /* 任务还在 QUEUED（非终态）→ 13.8 要求 409 并带上原 job_id */
    const second = await generate(cookie);
    expect(second.statusCode).toBe(409);
    expect((await wallet.balance(userId)).heldCr).toBe(held);
  });

  it('一版价目表都没发布时照常生成（降级方向是免费放行）', async () => {
    /*
     * 反过来（503 或 402）的表现是「运营还没配价格，全站不能生成」，
     * 而价目表缺失是我们的配置问题。这条路上的滥用由次数配额挡住。
     */
    const { wallet } = billingHarness();
    wallet.priceBook = null;
    const { cookie, userId } = await identity();

    expect((await generate(cookie)).statusCode).toBe(201);
    expect(await wallet.balance(userId)).toEqual({ balanceCr: 0, heldCr: 0 });
  });

  it('未装配计费时完全不碰钱包（0013 之前的部署）', async () => {
    /* 默认夹具不装 credits：库还没迁到 0013 的部署里钱包表不存在 */
    const cookie = await anonymousCookie();
    const response = await generate(cookie);

    expect(response.statusCode).toBe(201);
    expect(h().wallet.entries()).toHaveLength(0);
  });
});
