import { InMemoryCounterStore } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import {
  AiImageBudget,
  DEFAULT_AI_IMAGE_DAILY_BUDGET,
  MAX_AI_FAILURES_PER_JOB,
  MAX_AI_IMAGES_PER_JOB,
  MAX_REALTIME_HERO_PER_JOB,
  aiImageDailyKey,
} from './ai-budget.js';

/** 测试用的任务级 AI 墙钟窗口。取整便于算边界 */
const JOB_AI_BUDGET_MS = 80_000;

/** 一条候选链的最坏耗时。默认取单候选（= IMAGE_TIMEOUT_MS 的默认值） */
const CHAIN_WORST_CASE_MS = 40_000;

/**
 * AI 图片预算与熔断（TP-4-03/15/17，设计稿 21.2 措施二、21.4）。
 *
 * 最重要的一条是**匿名身份一次都不生成**（TP-4-17）：21.4 把匿名的
 * AI Hero 额度定为 0，而 AI 图片是这个系统最贵的一项、匿名流量占比最高。
 * 这条断言若失效，成本会以「看起来一切正常」的方式失控。
 */

const NOW = new Date('2026-08-17T10:00:00Z');

function budget(overrides: Partial<Parameters<typeof makeDeps>[0]> = {}): {
  budget: AiImageBudget;
  counters: InMemoryCounterStore;
} {
  const counters = new InMemoryCounterStore();
  return {
    counters,
    budget: new AiImageBudget({ ...makeDeps(overrides), counters }),
  };
}

function makeDeps(overrides: {
  userType?: 'ANONYMOUS' | 'REGISTERED';
  heroQuota?: number;
  dailyBudget?: number;
  jobAiBudgetMs?: number;
  chainWorstCaseMs?: number;
  now?: () => Date;
}) {
  return {
    userType: overrides.userType ?? ('REGISTERED' as const),
    heroQuota: overrides.heroQuota ?? 2,
    dailyBudget: overrides.dailyBudget ?? DEFAULT_AI_IMAGE_DAILY_BUDGET,
    jobAiBudgetMs: overrides.jobAiBudgetMs ?? JOB_AI_BUDGET_MS,
    chainWorstCaseMs: overrides.chainWorstCaseMs ?? CHAIN_WORST_CASE_MS,
    // 覆盖得了才能测墙钟窗口：固定时钟下窗口永不流动
    now: overrides.now ?? (() => NOW),
  };
}

describe('21.4 单任务上限', () => {
  it(`AI 图总张数上限 ${MAX_AI_IMAGES_PER_JOB} 张，超出后续槽位走占位图`, async () => {
    const { budget: b } = budget();

    for (let i = 0; i < MAX_AI_IMAGES_PER_JOB; i += 1) {
      expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
    }
    const rejected = await b.reserve('FOOD_IMAGE');
    expect(rejected).toEqual({ allowed: false, reason: 'JOB_IMAGE_LIMIT' });
  });

  it(`并发 reserve 同样只放行 ${MAX_AI_IMAGES_PER_JOB} 张`, async () => {
    /*
     * 上一条是串行的，而素材解析从来不是串行的：`resolve-assets` 以
     * 天 8 × 槽 6 并发跑，同一瞬间会有多个槽位进入 `reserve`。
     *
     * 熔断判定要查 Redis，那次 `await` 是一个让出点。占位若发生在它之后，
     * 并发进来的槽位会全部读到递增前的 `images` 并全部通过 —— 张数上限
     * 就此失效，而它是 21.4 的成本上限。这条断言固定「检查与递增之间
     * 不存在让出点」这件事，串行的用例察觉不到它。
     */
    const { budget: b } = budget();

    const decisions = await Promise.all(Array.from({ length: 6 }, () => b.reserve('FOOD_IMAGE')));

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(MAX_AI_IMAGES_PER_JOB);
    expect(b.used.images).toBe(MAX_AI_IMAGES_PER_JOB);
  });

  it(`并发 reserve 同样只放行 ${MAX_REALTIME_HERO_PER_JOB} 次 Hero`, async () => {
    // Hero 计数与总张数是两个独立的闸，占位的时机问题对两者同时成立
    const { budget: b } = budget({ heroQuota: 5 });

    const decisions = await Promise.all(
      Array.from({ length: 5 }, () => b.reserve('HERO_BACKGROUND')),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(
      MAX_REALTIME_HERO_PER_JOB,
    );
    expect(b.used.heroes).toBe(MAX_REALTIME_HERO_PER_JOB);
  });

  it('熔断打开时归还占位，不占着任务额度', async () => {
    /*
     * 占位移到 `await` 之前之后，熔断这条拒绝路径就在占位之后了 ——
     * 不归还的话「熔断期间被拒的槽位」会消耗张数额度，于是熔断恢复后
     * 本该还能生成的槽位拿到 JOB_IMAGE_LIMIT。
     */
    const { budget: b, counters } = budget({ dailyBudget: 10 });
    await counters.increment(aiImageDailyKey(NOW), 90_000, 10);

    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'GLOBAL_CIRCUIT_OPEN',
    });
    expect(b.used.images).toBe(0);
  });

  it(`实时 Hero 上限 ${MAX_REALTIME_HERO_PER_JOB} 次（21.2 措施二）`, async () => {
    const { budget: b } = budget({ heroQuota: 5 });

    expect((await b.reserve('HERO_BACKGROUND')).allowed).toBe(true);
    expect((await b.reserve('HERO_BACKGROUND')).allowed).toBe(true);
    // 总张数还没到 3，但 Hero 的时延上限先到
    expect(await b.reserve('HERO_BACKGROUND')).toEqual({
      allowed: false,
      reason: 'HERO_QUOTA_EXHAUSTED',
    });
    // 非 Hero 槽位仍可用剩下的那一张
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
  });

  it('ROUTE_MAP 永不可生成（11.3 禁止 AI 绘制地图文字）', async () => {
    const { budget: b } = budget();
    expect(await b.reserve('ROUTE_MAP')).toEqual({
      allowed: false,
      reason: 'ROLE_NOT_ELIGIBLE',
    });
    // 且不消耗额度
    expect(b.used).toMatchObject({ images: 0, heroes: 0 });
  });
});

describe('TP-4-17 匿名的 AI Hero 额度为 0', () => {
  it('匿名身份的 Hero 槽位一次都不生成', async () => {
    const { budget: b } = budget({ userType: 'ANONYMOUS', heroQuota: 0 });

    expect(await b.reserve('HERO_BACKGROUND')).toEqual({
      allowed: false,
      reason: 'HERO_QUOTA_EXHAUSTED',
    });
    expect(b.used.heroes).toBe(0);
  });

  it('额度为 0 时不查 Redis —— 结果恒为拒绝，白查一次没有意义', async () => {
    const { budget: b, counters } = budget({ userType: 'ANONYMOUS', heroQuota: 0 });
    await b.reserve('HERO_BACKGROUND');
    // peek 没有被调用过：计数器里没有任何键
    expect(await counters.peek(aiImageDailyKey(NOW))).toBe(0);
  });

  it('景点与美食槽位不受 Hero 额度影响（匿名仍能拿到配图）', async () => {
    const { budget: b } = budget({ userType: 'ANONYMOUS', heroQuota: 0 });
    expect((await b.reserve('DESTINATION_PHOTO')).allowed).toBe(true);
  });
});

describe('21.4 全局熔断', () => {
  it('日调用量达阈值后一律拒绝', async () => {
    const { budget: b, counters } = budget({ dailyBudget: 2 });
    await counters.increment(aiImageDailyKey(NOW), 60);
    await counters.increment(aiImageDailyKey(NOW), 60);

    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'GLOBAL_CIRCUIT_OPEN',
    });
  });

  it('commit 才计入日预算 —— 失败的调用不占额度', async () => {
    const { budget: b, counters } = budget({ dailyBudget: 1 });

    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
    // 预留没有写入计数器
    expect(await counters.peek(aiImageDailyKey(NOW))).toBe(0);

    await b.commit();
    expect(await counters.peek(aiImageDailyKey(NOW))).toBe(1);
    // 现在熔断打开
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(false);
  });

  it('计数键含日期，跨天自动重置', () => {
    expect(aiImageDailyKey(new Date('2026-08-17T23:59:59Z'))).toBe('ai:image:daily:2026-08-17');
    expect(aiImageDailyKey(new Date('2026-08-18T00:00:01Z'))).toBe('ai:image:daily:2026-08-18');
  });
});

describe('refund', () => {
  it('归还后额度可被后续槽位使用（一次上游抖动不该让整个计划没有 AI 图）', async () => {
    const { budget: b } = budget();

    for (let i = 0; i < MAX_AI_IMAGES_PER_JOB; i += 1) {
      await b.reserve('FOOD_IMAGE');
    }
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(false);

    b.refund('FOOD_IMAGE');
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
  });

  it('Hero 的归还同时释放两个计数', async () => {
    const { budget: b } = budget();
    await b.reserve('HERO_BACKGROUND');
    b.refund('HERO_BACKGROUND');
    expect(b.used).toMatchObject({ images: 0, heroes: 0 });
  });

  it('归还次数多于预留时不会变成负数（额度不会被凭空造出来）', async () => {
    const { budget: b } = budget();
    b.refund('HERO_BACKGROUND');
    b.refund('HERO_BACKGROUND');
    expect(b.used).toMatchObject({ images: 0, heroes: 0 });

    for (let i = 0; i < MAX_AI_IMAGES_PER_JOB; i += 1) {
      expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
    }
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(false);
  });
});

describe('连续失败上限（时延保护）', () => {
  it(`连续 ${MAX_AI_FAILURES_PER_JOB} 次失败后本任务不再尝试 AI`, async () => {
    const { budget: b } = budget();

    for (let i = 0; i < MAX_AI_FAILURES_PER_JOB; i += 1) {
      expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
      b.recordFailure('FOOD_IMAGE');
    }

    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'PROVIDER_FAILING',
    });
    expect(b.used.failures).toBe(MAX_AI_FAILURES_PER_JOB);
  });

  it('同键去重的等待不算失败 —— 否则正常任务会误判供应商挂了', async () => {
    const { budget: b } = budget();

    for (let i = 0; i < 5; i += 1) {
      await b.reserve('FOOD_IMAGE');
      b.refund('FOOD_IMAGE');
    }

    expect(b.used.failures).toBe(0);
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
  });
});

describe('任务级 AI 墙钟窗口', () => {
  /*
   * ## 为什么次数管不住时延了
   *
   * 21.4 的「3 张」与 21.2 的「Hero 2 次」都是**用次数近似时延**，而那个近似
   * 的前提是「一次生成最多 20 秒」这个常量。超时改成可配 + 候选池之后，
   * 同样的「2 次」可以是 80 秒也可以是 400 秒 —— 次数只剩成本含义。
   *
   * ## 为什么闸是墙钟 + 前瞻，而不是累计耗时之和
   *
   * 素材解析并发跑（天 8 × 槽 6）。按「各链耗时之和」判定会同时犯两个错：
   * 3 条链同时花 40 秒被算成 120 秒（并发被误判成超支），而更要紧的是
   * 那个和只在调用**返回后**才更新 —— 同批并发的槽位全都在它还是 0 时
   * 通过，于是闸压根拦不住任何东西。
   *
   * 正确的判据是「现在放行的话它最晚什么时候结束」：
   * 窗口已流走的墙钟 + 这条链的最坏耗时 > 窗口总长 → 拒绝。
   */

  /** 可推进的假时钟，用来让墙钟窗口真的流动 */
  function clock(startIso = '2026-08-17T10:00:00Z') {
    let ms = new Date(startIso).getTime();
    return {
      now: () => new Date(ms),
      advance: (by: number) => {
        ms += by;
      },
    };
  }

  it('窗口装不下这条链的最坏耗时时拒绝，理由是 JOB_AI_TIME_EXHAUSTED', async () => {
    const c = clock();
    const { budget: b } = budget({
      jobAiBudgetMs: 80_000,
      chainWorstCaseMs: 40_000,
      now: c.now,
    });

    // 第一条链：窗口全新，0 + 40 秒装得下
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);

    // 窗口流走 50 秒后，再开一条 40 秒的链会跑到 90 秒 —— 超出 80 秒的窗口
    c.advance(50_000);
    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'JOB_AI_TIME_EXHAUSTED',
    });
  });

  it('恰好装得下就放行，差 1 毫秒装不下就拒（边界不多不少）', async () => {
    const c = clock();
    const { budget: b } = budget({
      jobAiBudgetMs: 80_000,
      chainWorstCaseMs: 40_000,
      now: c.now,
    });
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);

    // 已流走 40 秒 + 最坏 40 秒 = 恰好 80 秒，正好装得下
    c.advance(40_000);
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);

    // 再多 1 毫秒就装不下了
    c.advance(1);
    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'JOB_AI_TIME_EXHAUSTED',
    });
  });

  it('并发的多条链不互相挤占窗口 —— 墙钟只走一次', async () => {
    /*
     * 这一条是「和」与「墙钟」的分水岭：3 条链同时发起，各自最坏 40 秒，
     * 墙钟只会走 40 秒。按和判定会把后两条拒掉（40 × 3 = 120 > 80），
     * 而它们本来完全赶得上。
     */
    const c = clock();
    const { budget: b } = budget({
      jobAiBudgetMs: 80_000,
      chainWorstCaseMs: 40_000,
      now: c.now,
    });

    const decisions = await Promise.all(Array.from({ length: 3 }, () => b.reserve('FOOD_IMAGE')));
    expect(decisions.every((decision) => decision.allowed)).toBe(true);
  });

  it('候选池把单链最坏耗时翻倍时，窗口一开始就只装得下一条', async () => {
    /*
     * 运维手册推荐 IMAGE 的 max_candidates = 2，于是一条链最坏 2 × 40 = 80 秒
     * —— 恰好是整个窗口。第一条放行后窗口就没有余量了，这正是候选池
     * 需要前瞻的理由：等「已经花了 80 秒」才发现的话，那 80 秒已经走掉。
     */
    const c = clock();
    const { budget: b } = budget({
      jobAiBudgetMs: 80_000,
      chainWorstCaseMs: 80_000,
      now: c.now,
    });

    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
    c.advance(1);
    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'JOB_AI_TIME_EXHAUSTED',
    });
  });

  it('窗口从首次放行开始算，之前的等待不占它', async () => {
    /*
     * 一次 reserve 到实际调用之间还隔着并发锁与同键等待（最多 22 秒），
     * 而那段时间没有调用任何模型。窗口从第一次放行起算，
     * 否则「这个槽位等了多久」会被算成「AI 花了多久」。
     */
    const c = clock();
    const { budget: b } = budget({ chainWorstCaseMs: 40_000, now: c.now });

    // 尚未放行过任何调用，窗口还没开始
    c.advance(200_000);
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
  });

  it('耗时累加，且负值不会把已花掉的时间还回来', () => {
    // 不再参与判定，但仍是排查时要看的量（「实际在 AI 上花了多少」）
    const { budget: b } = budget();
    b.recordElapsed(1_000);
    b.recordElapsed(2_000);
    b.recordElapsed(-5_000);
    expect(b.used.elapsedMs).toBe(3_000);
  });

  it('refund 不退还耗时 —— 时间花掉了就是花掉了', async () => {
    /*
     * 与额度相反：额度可以还（那一张没进库，后面的槽位该能再试），
     * 但时间不能还。还了的话一次上游超时 + 归还就能让同一个任务无限重试，
     * 而 T2 的窗口是真的在流走。
     */
    const { budget: b } = budget();
    await b.reserve('FOOD_IMAGE');
    b.recordElapsed(30_000);
    b.refund('FOOD_IMAGE');

    expect(b.used).toMatchObject({ images: 0, elapsedMs: 30_000 });
  });
});

describe('日计数按发出的请求数计（本轮决策 4）', () => {
  it('一条链发出 2 个候选 → 日计数 +2，不是 +1', async () => {
    /*
     * 超时的那个候选，供应商很可能已经生成完并计了费 —— 我们只是没等到。
     * 记 1 会让 21.4 的 600 熔断比真实成本低估若干倍，而那个阈值存在的
     * 意义就是反映成本。
     */
    const { budget: b, counters } = budget();

    await b.reserve('FOOD_IMAGE');
    await b.commit(2);

    expect(await counters.peek(aiImageDailyKey(NOW))).toBe(2);
  });

  it('缺省仍是 +1（单候选路径没有行为变化）', async () => {
    const { budget: b, counters } = budget();
    await b.commit();
    expect(await counters.peek(aiImageDailyKey(NOW))).toBe(1);
  });

  it('costUnits 为 0 时不写计数 —— fake 客户端不该混进成本报表', async () => {
    const { budget: b, counters } = budget();
    await b.commit(0);
    expect(await counters.peek(aiImageDailyKey(NOW))).toBe(0);
  });
});
