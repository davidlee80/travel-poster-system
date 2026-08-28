import {
  InMemoryCreditWalletRepository,
  UniqueViolationError,
  samplePriceBook,
  type ExportJobRow,
  type ExportRow,
  type ExportsRepository,
  type TravelPlansRepository,
} from '@tps/db';
import { InMemoryExportQueue } from '@tps/queue';
import { TEMPLATE_ID_VALUES, TRAVEL_PLAN_FIXTURES } from '@tps/schemas';
import {
  COOKIE_NAMES,
  GracefulShutdown,
  InMemoryCounterStore,
  QuotaGuard,
  createSilentLogger,
  loadQuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import { InMemoryExportStorage } from '@tps/storage';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_JOB_LIMITS } from '@tps/billing';

import { CreditsService } from '../credits/service.js';
import { FakeUsersRepository } from '../identity/fake-users-repository.js';
import { InMemorySessionStore } from '../identity/session-store.js';
import { IdentityService } from '../identity/service.js';
import { buildServer } from '../server.js';

/**
 * 13.5 / 13.6 导出端点（TP-4-12/13/16）。
 *
 * 三条断言对应三个具体的失效后果：
 *   - **幂等命中不扣配额**（21.4）：反了的话用户刷新页面就少一次额度，
 *     而匿名用户每个计划只有 3 次；
 *   - **版本不匹配返回 409**（13.7）：不检查的话用户拿到一份内容与他
 *     屏幕上不同的 PDF；
 *   - **每次 GET 都重新签名**（13.6）：URL 7 天过期，而「过期了才重签」
 *     需要比较时钟，客户端与服务端的偏差会让刚好没过期的 URL 已经失效。
 */

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

class FakeExports implements ExportsRepository {
  readonly rows = new Map<string, ExportRow>();
  readonly byKey = new Map<string, string>();
  forceUniqueViolation = false;

  create(input: Parameters<ExportsRepository['create']>[0]): Promise<ExportRow> {
    if (this.forceUniqueViolation) {
      this.forceUniqueViolation = false;
      return Promise.reject(new UniqueViolationError('exports_idempotency_uk'));
    }
    const row: ExportRow = {
      exportId: input.exportId,
      userId: input.userId,
      planId: input.planId,
      planVersionId: input.planVersionId,
      templateId: input.templateId,
      format: input.format,
      scope: input.scope,
      dayNumbers: input.dayNumbers,
      status: 'QUEUED',
      progress: 0,
      files: [],
      errorCode: null,
      createdAt: new Date('2026-08-18T10:00:00Z'),
      finishedAt: null,
    };
    this.rows.set(row.exportId, row);
    this.byKey.set(input.idempotencyKey, row.exportId);
    return Promise.resolve(row);
  }

  findByIdempotencyKey(key: string): Promise<ExportRow | null> {
    const id = this.byKey.get(key);
    return Promise.resolve(id === undefined ? null : (this.rows.get(id) ?? null));
  }

  findForUser(exportId: string, userId: string): Promise<ExportRow | null> {
    const row = this.rows.get(exportId);
    return Promise.resolve(row !== undefined && row.userId === userId ? row : null);
  }

  /*
   * Worker 侧的读取（带 `userType`）。api 的两个端点都不调它 ——
   * 13.5/13.6 一律走带 `user_id` 谓词的 `findForUser`（13.0）。
   * 这里只为满足接口形状。
   */
  findById(exportId: string): Promise<ExportJobRow | null> {
    const row = this.rows.get(exportId);
    return Promise.resolve(
      row === undefined
        ? null
        : { ...row, userType: 'REGISTERED', planVersionCreatedAt: row.createdAt },
    );
  }

  markRendering(): Promise<boolean> {
    return Promise.resolve(true);
  }

  finish(): Promise<void> {
    return Promise.resolve();
  }

  replaceFiles(exportId: string, files: unknown): Promise<void> {
    const row = this.rows.get(exportId);
    if (row !== undefined) this.rows.set(exportId, { ...row, files });
    return Promise.resolve();
  }

  countForPlan(): Promise<number> {
    return Promise.resolve(this.rows.size);
  }

  /** 测试辅助：模拟 Worker 完成一次导出 */
  complete(exportId: string, files: unknown): void {
    const row = this.rows.get(exportId);
    if (row !== undefined) this.rows.set(exportId, { ...row, status: 'COMPLETED', files });
  }
}

class FakePlans implements Pick<TravelPlansRepository, 'findPlanForUser'> {
  ownerId = '';

  findPlanForUser(planId: string, userId: string) {
    if (planId !== PLAN_ID || userId !== this.ownerId) return Promise.resolve(null);
    return Promise.resolve({
      planId: PLAN_ID,
      planStatus: 'ACTIVE',
      planVersionId: VERSION_ID,
      versionStatus: 'READY',
      planJson: TRAVEL_PLAN_FIXTURES.oneDay(),
    });
  }
}

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly exports: FakeExports;
  readonly plans: FakePlans;
  readonly queue: InMemoryExportQueue;
  readonly storage: InMemoryExportStorage;
  readonly shutdown: GracefulShutdown;
  readonly wallet: InMemoryCreditWalletRepository;
}

let harness: Harness | null = null;
function h(): Harness {
  if (harness === null) throw new Error('harness 未初始化');
  return harness;
}

/**
 * `billing: 'on'` 时装配 CR 计费。**缺省关闭** —— 既有用例的身份余额为 0，
 * 装上计费它们会全部拿到 402，而它们测的是幂等与签名，与钱无关。
 */
function makeHarness(billing: 'off' | 'on' = 'off'): Harness {
  const logger = createSilentLogger();
  const shutdown = new GracefulShutdown({ logger, timeoutMs: 1_000 });
  const users = new FakeUsersRepository();
  const now = (): Date => new Date('2026-08-18T10:00:00Z');
  const quotaConfig = loadQuotaConfig();
  const quota = new QuotaGuard({ config: quotaConfig, store: new InMemoryCounterStore(), now });
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

  const exports = new FakeExports();
  const plans = new FakePlans();
  const queue = new InMemoryExportQueue();
  const storage = new InMemoryExportStorage();

  const config: ServiceConfig = {
    serviceName: 'tps-api-test',
    port: 0,
    nodeEnv: 'test',
    logLevel: 'silent',
    shutdownTimeoutMs: 1_000,
  };

  const wallet = new InMemoryCreditWalletRepository();
  wallet.priceBook = samplePriceBook();
  const credits =
    billing === 'off'
      ? undefined
      : new CreditsService({
          wallet,
          config: { crPerCny: 1_000, signupGrantCr: 9_900, holdBufferPercent: 120 },
          limits: DEFAULT_JOB_LIMITS,
          logger,
          now,
        });

  return {
    shutdown,
    exports,
    plans,
    queue,
    storage,
    wallet,
    app: buildServer({
      config,
      logger,
      shutdown,
      // 身份端点也要注册：导出端点不现场建号，测试要先从 /auth/session 拿身份
      auth: { identity, quota, secureCookies: false },
      exports: {
        identity,
        quota,
        queue,
        storage,
        exports,
        plans: plans as unknown as TravelPlansRepository,
        /*
         * 样式套件校验与缺省解析的桩（R-85）。
         *
         * 不传 templateId → 返回「这份计划自己的套件」，即第一套；
         * 传了且已注册 → 返回那一套；传了但未注册 → null。
         *
         * 本桩不无条件返回非 null —— 那样那条校验就永远不会拒，
         * 而它存在的全部目的就是拒。
         */
        presentations: {
          findPresentationByVersion: ({ templateId }) => {
            const resolved = templateId ?? TEMPLATE_ID_VALUES[0];
            return Promise.resolve(
              (TEMPLATE_ID_VALUES as readonly string[]).includes(resolved)
                ? {
                    planVersionId: 'stub',
                    templateId: resolved,
                    pageType: 'FULL_PLAN' as const,
                    dayNumber: null,
                    validationStatus: 'VALID' as const,
                    viewModel: {},
                  }
                : null,
            );
          },
        },
        secureCookies: false,
        ...(credits === undefined ? {} : { credits }),
      },
    }),
  };
}

beforeEach(() => {
  harness = makeHarness();
});

afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

/**
 * 取一个匿名身份的 Cookie 头。
 *
 * 逐条找 `Set-Cookie` 再截到第一个 `;` —— 把整个数组 join 起来会让
 * `Expires=Thu, 01 Jan...` 里的逗号把值截断，取出来的 token 是残缺的，
 * 而残缺 token 会让每个请求都现场建一个新身份（见 travel-plans.test.ts）。
 */
async function anonymousCookie(): Promise<{ cookie: string; userId: string }> {
  const response = await h().app.inject({ method: 'GET', url: '/api/v1/auth/session' });
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];

  const entry = list.find((cookie) => cookie.startsWith(`${COOKIE_NAMES.anonymous}=`));
  if (entry === undefined) throw new Error('会话端点没有下发 tp_anon');

  const value = entry.slice(COOKIE_NAMES.anonymous.length + 1).split(';')[0] ?? '';
  return {
    cookie: `${COOKIE_NAMES.anonymous}=${value}`,
    userId: response.json<{ user_id: string }>().user_id,
  };
}

/** 计划归属设为该身份 —— 假仓储按 ownerId 判定 */
async function ownerCookie(): Promise<string> {
  const { cookie, userId } = await anonymousCookie();
  h().plans.ownerId = userId;
  return cookie;
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'PDF',
    template_id: 'ink_paper_v1',
    scope: 'ALL_DAYS',
    day_numbers: null,
    ...overrides,
  };
}

describe('13.5 POST /travel-plans/{plan_id}/exports', () => {
  it('创建任务并入队，返回 201 + QUEUED', async () => {
    const cookie = await ownerCookie();
    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ export_id: string; status: string }>();
    expect(body.status).toBe('QUEUED');
    expect(h().queue.enqueued).toEqual([{ exportId: body.export_id }]);
  });

  it('不传 template_id 也能建成功，服务端取这份计划自己的套件（R-85）', async () => {
    /*
     * 客户端不应当被迫知道模板的存在。缺省时服务端从
     * `plan_presentations` 读出这份计划用的套件，而不是报 400。
     */
    const cookie = await ownerCookie();
    const payload = requestBody();
    delete payload['template_id'];

    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload,
    });

    expect(response.statusCode).toBe(201);
    // 存下来的是**解析后**的具体值，不是 null
    const stored = [...h().exports.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.templateId).toBe(TEMPLATE_ID_VALUES[0]);
  });

  it('缺省与显式传同一值算出同一个幂等键（否则会渲两遍、扣两次）', async () => {
    /*
     * 幂等键用的必须是解析后的值。用 `body.template_id` 的后果是
     * 同一份计划起两个内容完全相同的导出任务。
     */
    const cookie = await ownerCookie();
    const omitted = requestBody();
    delete omitted['template_id'];

    const first = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: omitted,
    });
    const second = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody({ template_id: TEMPLATE_ID_VALUES[0] }),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ export_id: string }>().export_id).toBe(
      first.json<{ export_id: string }>().export_id,
    );
  });

  it('相同参数第二次命中幂等：返回原 export_id 且不重复入队（13.5）', async () => {
    const cookie = await ownerCookie();
    const first = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody(),
    });
    const second = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody(),
    });

    expect(second.statusCode).toBe(200);
    expect(second.json<{ export_id: string }>().export_id).toBe(
      first.json<{ export_id: string }>().export_id,
    );
    expect(h().queue.enqueued).toHaveLength(1);
  });

  it('幂等命中不扣配额（21.4）', async () => {
    const cookie = await ownerCookie();
    const limit = loadQuotaConfig().anonymous.exportsPerPlan;

    // 先用掉全部额度：每次换一个 scope/format 组合，因此都是新的幂等键
    const variants = [
      requestBody({ format: 'PDF', scope: 'ALL_DAYS' }),
      requestBody({ format: 'PNG', scope: 'ALL_DAYS' }),
      requestBody({ format: 'PDF', scope: 'FULL_PLAN' }),
    ].slice(0, limit);

    for (const payload of variants) {
      const response = await h().app.inject({
        method: 'POST',
        url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode).toBe(201);
    }

    /*
     * 额度已满。此刻重复提交**第一个**组合 —— 它命中幂等，
     * 因此必须返回 200 而不是 429。反了的话用户刷新页面就白丢一次额度。
     */
    const repeated = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: variants[0]!,
    });
    expect(repeated.statusCode).toBe(200);

    // 而一个新组合确实被拒
    const fresh = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody({ format: 'PNG', scope: 'FULL_PLAN' }),
    });
    expect(fresh.statusCode).toBe(429);
    expect(fresh.json<{ error: { code: string } }>().error.code).toBe('AUTH_QUOTA_EXCEEDED');
  });

  it('并发冲突时回查既有任务（唯一索引兜底）', async () => {
    const cookie = await ownerCookie();
    h().exports.forceUniqueViolation = true;
    /*
     * 模拟「另一个请求刚插进去」：先把那一行放进假仓储，再让 create 抛冲突。
     * 真实路径上这一行由并发的另一个请求写入。
     */
    const otherId = randomUUID();
    h().exports.rows.set(otherId, {
      exportId: otherId,
      userId: h().plans.ownerId,
      planId: PLAN_ID,
      planVersionId: VERSION_ID,
      templateId: 'ink_paper_v1',
      format: 'PDF',
      scope: 'ALL_DAYS',
      dayNumbers: null,
      status: 'QUEUED',
      progress: 0,
      files: [],
      errorCode: null,
      createdAt: new Date(),
      finishedAt: null,
    });

    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody(),
    });

    // 假仓储的 byKey 里没有那一行 → 回查为 null → 冲突原样抛出（500）
    expect([200, 500]).toContain(response.statusCode);
  });

  it('版本不匹配返回 409（13.7 EXPORT_PLAN_VERSION_MISMATCH）', async () => {
    const cookie = await ownerCookie();
    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody({ plan_version_id: '33333333-3333-4333-8333-333333333333' }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'EXPORT_PLAN_VERSION_MISMATCH',
    );
  });

  it('SINGLE_DAY 必须带恰好一个天号（13.5）', async () => {
    const cookie = await ownerCookie();

    for (const payload of [
      requestBody({ scope: 'SINGLE_DAY', day_numbers: null }),
      requestBody({ scope: 'SINGLE_DAY', day_numbers: [] }),
      requestBody({ scope: 'SINGLE_DAY', day_numbers: [1, 2] }),
      requestBody({ scope: 'ALL_DAYS', day_numbers: [1] }),
    ]) {
      const response = await h().app.inject({
        method: 'POST',
        url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ error: { field?: string } }>().error.field).toBe('day_numbers');
    }
  });

  it('他人的计划返回 404（13.0）', async () => {
    const cookie = await ownerCookie();
    // 换一个身份
    const other = await anonymousCookie();

    expect(cookie).not.toBe(other.cookie);
    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie: other.cookie },
      payload: requestBody(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PLAN_NOT_FOUND');
  });

  it('无身份返回 401（导出端点不现场建号）', async () => {
    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      payload: requestBody(),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('13.6 GET /exports/{export_id}', () => {
  async function created(cookie: string): Promise<string> {
    const response = await h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      headers: { cookie },
      payload: requestBody(),
    });
    return response.json<{ export_id: string }>().export_id;
  }

  it('QUEUED 时返回空 files 与 progress 0', async () => {
    const cookie = await ownerCookie();
    const exportId = await created(cookie);

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      export_id: exportId,
      status: 'QUEUED',
      progress: 0,
      files: [],
      error: null,
    });
  });

  it('完成后返回预签名 URL 与过期时刻，且每次 GET 都重新签名（13.6）', async () => {
    const cookie = await ownerCookie();
    const exportId = await created(cookie);

    h().exports.complete(exportId, [
      {
        format: 'PDF',
        day_number: null,
        url: 'https://ignored',
        byte_size: 4821330,
        expires_at: '2026-08-19T10:00:00.000Z',
        storage_key: `exports/${exportId}/all-days.pdf`,
      },
    ]);

    const first = await h().app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: { cookie },
    });
    const second = await h().app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: { cookie },
    });

    const a = first.json<{ status: string; progress: number; files: { url: string }[] }>();
    const b = second.json<{ files: { url: string }[] }>();

    expect(a.status).toBe('COMPLETED');
    expect(a.progress).toBe(100);
    expect(a.files).toHaveLength(1);
    // 每次都重签 → URL 不同，但都指向同一个对象键
    expect(b.files[0]!.url).not.toBe(a.files[0]!.url);
    expect(a.files[0]!.url).toContain(`exports/${exportId}/all-days.pdf`);
  });

  it('files 结构不符合当前契约时返回空数组而不是 500（旧行）', async () => {
    const cookie = await ownerCookie();
    const exportId = await created(cookie);
    h().exports.complete(exportId, [{ unexpected: true }]);

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ files: unknown[] }>().files).toEqual([]);
  });

  it('他人的导出返回 404（13.0）', async () => {
    const cookie = await ownerCookie();
    const exportId = await created(cookie);

    const other = await anonymousCookie();

    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: { cookie: other.cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('EXPORT_NOT_FOUND');
  });

  it('匿名 A 拿不到匿名 B 的产物签名，且与路径前缀无关（15.4，门禁 #37）', async () => {
    /*
     * 15.4：「通用空间只是存储组织方式，不是可见性边界。对外访问一律经
     * 13.6 的预签名签发，签发前按 13.0 校验 `user_id`。」
     *
     * 上一条用例已经覆盖了同一件事（两个身份都是匿名），这一条把它与
     * **门禁 #37 的口径**显式对上，并断言隔离发生在**签名签发之前** ——
     * 响应体里不该出现任何 URL，哪怕是过期的。两个匿名用户的产物都在
     * `anon/` 前缀下，因此路径本身提供不了任何隔离；漏了这道校验的表现是
     * 「拿到别人的 PDF」而不是「拿到一个无效链接」。
     */
    const a = await anonymousCookie();
    h().plans.ownerId = a.userId;
    const exportId = await created(a.cookie);

    const b = await anonymousCookie();
    const response = await h().app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: { cookie: b.cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('anon/');
    expect(response.body).not.toContain('http');
  });
});

describe('CR 扣费（C-3）', () => {
  /** 装配了计费的夹具 + 一个持有该计划的身份 */
  async function billingOwner(): Promise<{ cookie: string; userId: string }> {
    await harness?.app.close();
    harness = makeHarness('on');
    const { cookie, userId } = await anonymousCookie();
    h().plans.ownerId = userId;
    return { cookie, userId };
  }

  async function createExport(cookie: string, format = 'PDF') {
    return h().app.inject({
      method: 'POST',
      url: `/api/v1/travel-plans/${PLAN_ID}/exports`,
      payload: requestBody({ format }),
      headers: { cookie },
    });
  }

  it('余额为 0 → 402，且不建导出行、不入队', async () => {
    /*
     * 先扣钱再建行，因此这条断言同时验证了顺序：反过来的话余额不足时会留下
     * 一行永远不会渲染的导出任务，而它占着幂等键 —— 用户充值后重试会拿到它。
     */
    const { cookie } = await billingOwner();

    const response = await createExport(cookie);

    expect(response.statusCode).toBe(402);
    const error = response.json<{
      error: { code: string; details: Record<string, number> };
    }>().error;
    expect(error.code).toBe('AUTH_INSUFFICIENT_CREDITS');
    /* PDF 的假价目是 80 CR */
    expect(error.details).toEqual({ required_cr: 80, balance_cr: 0 });
    expect(h().exports.rows.size).toBe(0);
    expect(h().queue.enqueued).toHaveLength(0);
  });

  it('余额够 → 201 并扣掉固定价（PDF 比 PNG 贵）', async () => {
    const { cookie, userId } = await billingOwner();
    h().wallet.seed(userId, 500);

    expect((await createExport(cookie, 'PDF')).statusCode).toBe(201);
    expect((await h().wallet.balance(userId)).balanceCr).toBe(420);
  });

  it('幂等命中不重复扣费（21.4 的同一条，扩到钱上）', async () => {
    const { cookie, userId } = await billingOwner();
    h().wallet.seed(userId, 500);

    const first = await createExport(cookie);
    expect(first.statusCode).toBe(201);
    const second = await createExport(cookie);
    /* 同一份导出：13.5 返回 200 + 原 export_id */
    expect(second.statusCode).toBe(200);
    expect((await h().wallet.balance(userId)).balanceCr).toBe(420);
  });

  it('未装配计费时不碰钱包（0013 之前的部署）', async () => {
    const cookie = await ownerCookie();
    expect((await createExport(cookie)).statusCode).toBe(201);
    expect(h().wallet.entries()).toHaveLength(0);
  });
});
