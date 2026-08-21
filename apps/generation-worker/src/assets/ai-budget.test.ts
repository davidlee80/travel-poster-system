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

/** 测试用的任务级 AI 耗时预算。取整便于算边界 */
const JOB_AI_BUDGET_MS = 80_000;

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
}) {
  return {
    userType: overrides.userType ?? ('REGISTERED' as const),
    heroQuota: overrides.heroQuota ?? 2,
    dailyBudget: overrides.dailyBudget ?? DEFAULT_AI_IMAGE_DAILY_BUDGET,
    jobAiBudgetMs: overrides.jobAiBudgetMs ?? JOB_AI_BUDGET_MS,
    now: () => NOW,
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

describe('任务级 AI 累计耗时预算', () => {
  /*
   * ## 为什么次数管不住时延了
   *
   * 21.4 的「3 张」与 21.2 的「Hero 2 次」都是**用次数近似时延**，而那个近似
   * 的前提是「一次生成最多 20 秒」这个常量。超时改成可配 + 候选池之后，
   * 同样的「2 次」可以是 80 秒也可以是 400 秒 —— 次数只剩成本含义。
   *
   * 因此时延要有自己的预算，与次数**先到先停**。
   */

  it('累计耗时达上限后拒绝，理由是 JOB_AI_TIME_EXHAUSTED', async () => {
    const { budget: b } = budget({ jobAiBudgetMs: 80_000 });

    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
    b.recordElapsed(80_000);

    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'JOB_AI_TIME_EXHAUSTED',
    });
  });

  it('恰好用满才拒，差 1 毫秒仍然放行（边界不多不少）', async () => {
    const { budget: b } = budget({ jobAiBudgetMs: 80_000 });
    b.recordElapsed(79_999);
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
  });

  it('耗时与张数是两个独立的闸：张数没到 3 也能被耗时拦住', async () => {
    const { budget: b } = budget({ jobAiBudgetMs: 40_000 });

    await b.reserve('FOOD_IMAGE');
    b.recordElapsed(40_000);

    expect(b.used.images).toBe(1);
    // 成本闸（3 张）还剩 2 张，时延闸已经关了
    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'JOB_AI_TIME_EXHAUSTED',
    });
  });

  it('耗时累加，且负值不会把已花掉的时间还回来', () => {
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
