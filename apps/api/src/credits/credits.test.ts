import { DEFAULT_JOB_LIMITS, loadCreditConfig, type CreditConfig } from '@tps/billing';
import {
  COOKIE_NAMES,
  GracefulShutdown,
  InMemoryCounterStore,
  QuotaGuard,
  createSilentLogger,
  type QuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeUsersRepository } from '../identity/fake-users-repository.js';
import { InMemorySessionStore } from '../identity/session-store.js';
import { IdentityService } from '../identity/service.js';
import { buildServer } from '../server.js';
import { FakeCreditWalletRepository, fakePriceBook } from './fake-wallet-repository.js';
import { CreditsService } from './service.js';

/**
 * CR 报价与钱包端点（C-3）。
 *
 * 钱包的原子性与幂等在 `@tps/db` 的集成测试里（真库、26 项）。这里测的是
 * **用户能看到的那一层**：402 的时机、`details` 的数值、匿名被拒、
 * 报价的结论由服务端给出。
 */

const NOW = new Date('2026-04-01T10:00:00Z');

const serviceConfig: ServiceConfig = {
  serviceName: 'tps-api-test',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

const quotaConfig: QuotaConfig = {
  anonymous: { perMinute: 99, dailyPlans: 5, monthlyPlans: 10, exportsPerPlan: 3, aiHero: 0 },
  registered: { perMinute: 99, dailyPlans: 5, monthlyPlans: 20, exportsPerPlan: 10, aiHero: 2 },
  ip: { anonCreatePerHour: 50, anonCreatePerDay: 200, plansPerDay: 100, loginFailuresPerHour: 10 },
  emailLoginFailuresPerHour: 5,
  anonTokenTtlDays: 30,
};

const creditConfig: CreditConfig = {
  crPerCny: 1_000,
  signupGrantCr: 9_900,
  holdBufferPercent: 120,
};

/** 可推进的时钟：价目表缓存的过期只能靠它验证 */
function clock(start = NOW): { now: () => Date; advance: (ms: number) => void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

function makeService(options: { readonly priceCacheMs?: number } = {}): {
  readonly service: CreditsService;
  readonly wallet: FakeCreditWalletRepository;
  readonly time: ReturnType<typeof clock>;
} {
  const wallet = new FakeCreditWalletRepository();
  wallet.priceBook = fakePriceBook();
  const time = clock();
  const service = new CreditsService({
    wallet,
    config: creditConfig,
    limits: DEFAULT_JOB_LIMITS,
    logger: createSilentLogger(),
    now: time.now,
    ...(options.priceCacheMs === undefined ? {} : { priceCacheMs: options.priceCacheMs }),
  });
  return { service, wallet, time };
}

describe('CreditsService 报价', () => {
  it('预留额 = 典型值 × buffer，且上界严格大于典型值', async () => {
    /*
     * 这两条数量关系是「预留取典型值」那个决定的全部内容（docs 第四节）：
     * 拿上界当预留额会让 9.9 元买不了一次 14 天行程。
     */
    const { service } = makeService();
    const quote = await service.quote(5);

    expect(quote.priceVersion).toBe(7);
    expect(quote.holdCr).toBe(Math.ceil((quote.typicalCr * 120) / 100));
    expect(quote.ceilingCr).toBeGreaterThan(quote.typicalCr);
  });

  it('天数越多越贵（估算真的跟着天数走）', async () => {
    const { service } = makeService();
    const short = await service.quote(3);
    const long = await service.quote(14);
    expect(long.typicalCr).toBeGreaterThan(short.typicalCr);
  });

  it('一版价目表都没发布时报价全为 0 且 price_version 为 null', async () => {
    /*
     * 降级方向必须是「免费放行」而不是 503：价目表缺失是我们的配置问题。
     * 反过来的表现是「运营还没配价格，全站不能生成」。
     */
    const { service, wallet } = makeService();
    wallet.priceBook = null;
    const quote = await service.quote(5);

    expect(quote.priceVersion).toBeNull();
    expect(quote.holdCr).toBe(0);
    expect(quote.ceilingCr).toBe(0);
  });

  it('人民币等值由服务端算（前端没有兑换比率）', () => {
    const { service } = makeService();
    expect(service.cnyText(9_900)).toBe('9.90');
  });

  it('价目表缓存 60 秒，到期后重新读', async () => {
    const { service, wallet, time } = makeService();
    const first = await service.quote(5);

    wallet.priceBook = fakePriceBook({ version: 8 });
    expect((await service.quote(5)).priceVersion).toBe(first.priceVersion);

    time.advance(60_001);
    expect((await service.quote(5)).priceVersion).toBe(8);
  });
});

describe('CreditsService.checkJob 预检', () => {
  it('余额不足时返回还差多少', async () => {
    const { service, wallet } = makeService();
    wallet.seed('u1', 10);

    const check = await service.checkJob({ userId: 'u1', totalDays: 5 });
    expect(check.kind).toBe('insufficient');
    if (check.kind !== 'insufficient') throw new Error('形态断言失败');
    expect(check.balanceCr).toBe(10);
    expect(check.requiredCr).toBeGreaterThan(10);
  });

  it('余额恰好等于预留额时通过（边界是 >=，不是 >）', async () => {
    const { service, wallet } = makeService();
    const quote = await service.quote(5);
    wallet.seed('u1', quote.holdCr);

    const check = await service.checkJob({ userId: 'u1', totalDays: 5 });
    expect(check.kind).toBe('chargeable');
  });

  it('没有价目表时不检查余额（零余额也放行）', async () => {
    const { service, wallet } = makeService();
    wallet.priceBook = null;

    expect(await service.checkJob({ userId: 'u1', totalDays: 5 })).toEqual({
      kind: 'free',
      reason: 'NO_PRICE_BOOK',
    });
  });

  it('价目表把所有项配成 0 时不预留（预留 0 会撞 amount_cr > 0 的 CHECK）', async () => {
    const { service, wallet } = makeService();
    wallet.priceBook = fakePriceBook({ items: {} });

    expect(await service.checkJob({ userId: 'u1', totalDays: 5 })).toEqual({
      kind: 'free',
      reason: 'ZERO_COST',
    });
  });
});

describe('CreditsService 导出扣费', () => {
  it('按格式扣对应的固定价', async () => {
    const { service, wallet } = makeService();
    wallet.seed('u1', 500);

    const png = await service.chargeExport({
      userId: 'u1',
      exportId: 'e1',
      format: 'PNG',
      exportIdempotencyKey: 'k1',
    });
    expect(png).toEqual({ kind: 'charged', amountCr: 50 });
    expect((await service.balance('u1')).balanceCr).toBe(450);

    const pdf = await service.chargeExport({
      userId: 'u1',
      exportId: 'e2',
      format: 'PDF',
      exportIdempotencyKey: 'k2',
    });
    expect(pdf).toEqual({ kind: 'charged', amountCr: 80 });
  });

  it('同一幂等键重复扣只扣一次', async () => {
    const { service, wallet } = makeService();
    wallet.seed('u1', 500);

    for (let i = 0; i < 3; i += 1) {
      await service.chargeExport({
        userId: 'u1',
        exportId: 'e1',
        format: 'PNG',
        exportIdempotencyKey: 'same',
      });
    }
    expect((await service.balance('u1')).balanceCr).toBe(450);
  });

  it('余额不足时拒绝且不动钱', async () => {
    const { service, wallet } = makeService();
    wallet.seed('u1', 10);

    const result = await service.chargeExport({
      userId: 'u1',
      exportId: 'e1',
      format: 'PDF',
      exportIdempotencyKey: 'k1',
    });
    expect(result).toEqual({ kind: 'insufficient', requiredCr: 80, balanceCr: 10 });
    expect((await service.balance('u1')).balanceCr).toBe(10);
  });

  it('导出的价目缺失时不收费（少收一笔好过让用户导不出来）', async () => {
    const { service, wallet } = makeService();
    wallet.priceBook = fakePriceBook({ items: {} });
    wallet.seed('u1', 500);

    expect(
      await service.chargeExport({
        userId: 'u1',
        exportId: 'e1',
        format: 'PNG',
        exportIdempotencyKey: 'k1',
      }),
    ).toEqual({ kind: 'free' });
    expect((await service.balance('u1')).balanceCr).toBe(500);
  });
});

// ── 端点 ────────────────────────────────────────────────────

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly wallet: FakeCreditWalletRepository;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

function build(): Harness {
  const wallet = new FakeCreditWalletRepository();
  wallet.priceBook = fakePriceBook();

  const users = new FakeUsersRepository(() => NOW);
  const sessions = new InMemorySessionStore(() => NOW.getTime());
  const quota = new QuotaGuard({
    config: quotaConfig,
    store: new InMemoryCounterStore(() => NOW.getTime()),
    now: () => NOW,
  });
  const identity = new IdentityService({
    users,
    sessions,
    quota,
    quotaConfig,
    now: () => NOW,
    secureCookies: false,
    /* 匿名被拒那条用例需要真的能拿到一个匿名身份 */
    anonymousEnabled: true,
  });

  const credits = new CreditsService({
    wallet,
    config: creditConfig,
    limits: DEFAULT_JOB_LIMITS,
    logger: createSilentLogger(),
    now: () => NOW,
  });

  const app = buildServer({
    config: serviceConfig,
    logger: createSilentLogger(),
    shutdown: new GracefulShutdown({ logger: createSilentLogger(), timeoutMs: 1_000 }),
    auth: { identity, quota, secureCookies: false, credits },
    credits: { identity, credits, secureCookies: false },
  });

  return { app, wallet };
}

function h(): Harness {
  if (harness === null) harness = build();
  return harness;
}

function cookieOf(headers: Record<string, unknown>, name: string): string {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  const entry = list.find((c) => c.startsWith(`${name}=`));
  if (entry === undefined) throw new Error(`响应里没有 ${name}`);
  return `${name}=${entry.slice(name.length + 1).split(';')[0] ?? ''}`;
}

/** 注册一个账号并返回它的会话 Cookie 与 user_id */
async function registered(email = 'wallet@example.com'): Promise<{
  readonly cookie: string;
  readonly userId: string;
}> {
  const response = await h().app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'Corgi-Bicycle-42!', display_name: '小明' },
  });
  if (response.statusCode !== 201) throw new Error(`注册失败: ${response.body}`);
  return {
    cookie: cookieOf(response.headers, COOKIE_NAMES.session),
    userId: response.json<{ user_id: string }>().user_id,
  };
}

async function anonymous(): Promise<string> {
  const response = await h().app.inject({ method: 'GET', url: '/api/v1/auth/session' });
  return cookieOf(response.headers, COOKIE_NAMES.anonymous);
}

describe('GET /api/v1/credits/wallet', () => {
  it('无任何身份 → 401', async () => {
    const response = await h().app.inject({ method: 'GET', url: '/api/v1/credits/wallet' });
    expect(response.statusCode).toBe(401);
  });

  it('匿名身份 → 403（匿名不进货币体系）', async () => {
    /*
     * 返回「余额 0」是另一种选择，而它更糟：前端会画出一个永远不够用的
     * 钱包，用户无从知道该去注册。
     */
    const cookie = await anonymous();
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/credits/wallet',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_ANONYMOUS_FORBIDDEN',
    );
  });

  it('注册用户：没有钱包行时余额为 0，且读取不建行', async () => {
    const { cookie } = await registered();
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/credits/wallet',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ balance_cr: 0, held_cr: 0, balance_cny: '0.00' });
  });

  it('返回余额、冻结额与人民币等值', async () => {
    const { cookie, userId } = await registered();
    h().wallet.seed(userId, 9_900);

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/credits/wallet',
      headers: { cookie },
    });
    expect(response.json()).toEqual({ balance_cr: 9_900, held_cr: 0, balance_cny: '9.90' });
  });
});

describe('POST /api/v1/credits/quote', () => {
  it('「够不够」的结论由服务端给出', async () => {
    /*
     * 前端不做这个比较（见 routes/credits.ts 文件头）：两处各算一份的表现是
     * 「按钮说够、提交被拒」，而用户看到的只有一个 402。
     */
    const { cookie, userId } = await registered();

    const poor = await h().app.inject({
      method: 'POST',
      url: '/api/v1/credits/quote',
      headers: { cookie },
      payload: { total_days: 5 },
    });
    expect(poor.statusCode).toBe(200);
    const quote = poor.json<{
      price_version: number;
      hold_cr: number;
      typical_cr: number;
      ceiling_cr: number;
      balance_cr: number;
      sufficient: boolean;
    }>();
    expect(quote.price_version).toBe(7);
    expect(quote.sufficient).toBe(false);
    expect(quote.balance_cr).toBe(0);
    expect(quote.ceiling_cr).toBeGreaterThan(quote.typical_cr);

    h().wallet.seed(userId, quote.hold_cr);
    const rich = await h().app.inject({
      method: 'POST',
      url: '/api/v1/credits/quote',
      headers: { cookie },
      payload: { total_days: 5 },
    });
    expect(rich.json<{ sufficient: boolean }>().sufficient).toBe(true);
  });

  it('天数越界 → 400 REQ_SCHEMA_INVALID', async () => {
    const { cookie } = await registered();
    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/credits/quote',
      headers: { cookie },
      payload: { total_days: 30 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('REQ_SCHEMA_INVALID');
  });

  it('没有价目表时 price_version 为 null 且判定为够（不计费）', async () => {
    const { cookie } = await registered();
    h().wallet.priceBook = null;

    const response = await h().app.inject({
      method: 'POST',
      url: '/api/v1/credits/quote',
      headers: { cookie },
      payload: { total_days: 5 },
    });

    expect(response.json()).toMatchObject({
      price_version: null,
      hold_cr: 0,
      sufficient: true,
    });
  });
});

describe('GET /api/v1/credits/ledger', () => {
  it('倒序返回，且不含 metadata（那是运营数据）', async () => {
    const { cookie, userId } = await registered();
    const wallet = h().wallet;
    await wallet.credit({ userId, amountCr: 9_900, kind: 'GRANT', idempotencyKey: 'signup' });
    await wallet.charge({
      userId,
      amountCr: 50,
      idempotencyKey: 'export:x',
      refType: 'EXPORT',
      refId: 'x',
      priceVersion: 7,
    });

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/credits/ledger',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { kind: string; amount_cr: number; metadata?: unknown }[];
      next_cursor: string | null;
    }>();
    expect(body.items.map((item) => item.kind)).toEqual(['SPEND', 'GRANT']);
    expect(body.items[0]?.amount_cr).toBe(-50);
    expect(body.items[0]).not.toHaveProperty('metadata');
    /* 只有两条、页大小 20 → 没有下一页 */
    expect(body.next_cursor).toBeNull();
  });

  it('翻满一页时给出游标', async () => {
    const { cookie, userId } = await registered();
    for (let i = 0; i < 3; i += 1) {
      await h().wallet.credit({
        userId,
        amountCr: 100,
        kind: 'GRANT',
        idempotencyKey: `g${i}`,
      });
    }

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/credits/ledger?limit=2',
      headers: { cookie },
    });
    const body = response.json<{ items: { created_at: string }[]; next_cursor: string | null }>();

    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).toBe(body.items[1]?.created_at);
  });
});

describe('会话响应里的钱包（13.9.1 扩展）', () => {
  it('注册用户带 wallet，既有的 quota 字段保持不动', async () => {
    /*
     * `quota` 不删：删它是破坏性契约变更，而 13.x 明确邀请第三方替换呈现层。
     * 产品上它只是不再展示。
     */
    const { cookie, userId } = await registered();
    h().wallet.seed(userId, 1_234);

    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });

    const body = response.json<{
      wallet: { balance_cr: number; held_cr: number; balance_cny: string };
      quota: { daily_remaining: number };
    }>();
    expect(body.wallet).toEqual({ balance_cr: 1_234, held_cr: 0, balance_cny: '1.23' });
    expect(typeof body.quota.daily_remaining).toBe('number');
  });

  it('匿名身份没有 wallet 字段', async () => {
    const cookie = await anonymous();
    const response = await h().app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });

    expect(response.json()).not.toHaveProperty('wallet');
  });
});

describe('货币配置', () => {
  it('默认 1 元 = 1000 CR、注册赠送 9900 CR、buffer 120%', () => {
    /*
     * 这三个默认值同时出现在 docs 的环境变量表与前端文案里。
     * 改了默认值而不改文档，用户看到的「充 9.9 元得多少 CR」就是错的。
     */
    expect(loadCreditConfig()).toEqual(creditConfig);
  });
});
