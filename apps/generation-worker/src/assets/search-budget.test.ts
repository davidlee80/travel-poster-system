import { describe, expect, it } from 'vitest';

import { InMemoryCounterStore } from '@tps/shared';

import {
  DEFAULT_IMAGE_SEARCH_DAILY_BUDGET,
  ImageSearchBudget,
  MAX_IMAGE_SEARCHES_PER_JOB,
  MAX_SEARCH_FAILURES_PER_JOB,
  imageSearchDailyKey,
} from './search-budget.js';

/**
 * 搜索配额与全局熔断（TP-6-06，设计稿 9.6、21.4 的 R-45）。
 *
 * 与 `ai-budget.test.ts` 结构对称，但**没有身份维度** —— 9.6 明确搜索额度
 * 匿名与注册同额，因为命中会入库为全平台共享资产。
 */

function budget(options: { dailyBudget?: number; counters?: InMemoryCounterStore } = {}) {
  const counters = options.counters ?? new InMemoryCounterStore();
  return {
    counters,
    budget: new ImageSearchBudget({
      counters,
      ...(options.dailyBudget === undefined ? {} : { dailyBudget: options.dailyBudget }),
      now: () => new Date('2026-08-19T00:00:00Z'),
    }),
  };
}

describe('9.6 的约束值', () => {
  it('单任务搜索上限 8 次', () => {
    expect(MAX_IMAGE_SEARCHES_PER_JOB).toBe(8);
  });

  it('单任务连续失败 2 次即停用', () => {
    expect(MAX_SEARCH_FAILURES_PER_JOB).toBe(2);
  });

  it('日预算默认与 @tps/llm 的配置默认值一致', () => {
    // 两处各写一个数会让「改了配置默认值但预算类还是老值」无人发现
    expect(DEFAULT_IMAGE_SEARCH_DAILY_BUDGET).toBe(2_000);
  });
});

describe('角色资格', () => {
  it('ROUTE_MAP 直接拒（9.2 的路线图是程序生成的 SVG，不外呼）', async () => {
    const { budget: b } = budget();
    expect(await b.reserve('ROUTE_MAP')).toEqual({
      allowed: false,
      reason: 'ROLE_NOT_ELIGIBLE',
    });
  });

  it('三个图片角色都可搜索（9.6：三链统一）', async () => {
    for (const role of ['HERO_BACKGROUND', 'DESTINATION_PHOTO', 'FOOD_IMAGE'] as const) {
      const { budget: b } = budget();
      expect(await b.reserve(role)).toEqual({ allowed: true });
    }
  });

  it('Hero 没有独立的更严额度（与 AI 层不同）', async () => {
    /*
     * AI 层给 Hero 单开了一个 2 次的时延上限（21.2 措施二），
     * 搜索层不需要：一次搜索 5 秒且命中即入库全平台复用，
     * 而一次 AI Hero 是 20 秒且只服务这一个任务。
     */
    const { budget: b } = budget();
    for (let i = 0; i < MAX_IMAGE_SEARCHES_PER_JOB; i += 1) {
      expect(await b.reserve('HERO_BACKGROUND')).toEqual({ allowed: true });
    }
  });
});

describe('单任务上限', () => {
  it('第 9 次被拒', async () => {
    const { budget: b } = budget();
    for (let i = 0; i < MAX_IMAGE_SEARCHES_PER_JOB; i += 1) {
      expect((await b.reserve('DESTINATION_PHOTO')).allowed).toBe(true);
    }
    expect(await b.reserve('DESTINATION_PHOTO')).toEqual({
      allowed: false,
      reason: 'JOB_SEARCH_LIMIT',
    });
  });

  it('used 反映已用次数', async () => {
    const { budget: b } = budget();
    await b.reserve('FOOD_IMAGE');
    await b.reserve('FOOD_IMAGE');
    expect(b.used).toEqual({ searches: 2, failures: 0 });
  });
});

describe('连续失败停用', () => {
  it('连续两次失败后本任务不再搜索', async () => {
    const { budget: b } = budget();

    await b.reserve('DESTINATION_PHOTO');
    b.recordFailure();
    await b.reserve('DESTINATION_PHOTO');
    b.recordFailure();

    expect(await b.reserve('DESTINATION_PHOTO')).toEqual({
      allowed: false,
      reason: 'PROVIDER_FAILING',
    });
  });

  it('成功一次即清零连续失败计数', async () => {
    /*
     * 「连续」失败而不是「累计」失败：一个 14 天任务里偶发一次超时、
     * 隔几个槽位再偶发一次，与「图源挂了」是两件事。按累计算的话，
     * 前者会在第 3 个槽位就把搜索层关掉，而它其实工作正常。
     */
    const { budget: b } = budget();

    await b.reserve('DESTINATION_PHOTO');
    b.recordFailure();
    await b.reserve('DESTINATION_PHOTO');
    b.recordSuccess();
    await b.reserve('DESTINATION_PHOTO');
    b.recordFailure();

    expect((await b.reserve('DESTINATION_PHOTO')).allowed).toBe(true);
  });

  it('recordFailure 归还任务额度（失败的调用不该占上限）', async () => {
    const { budget: b } = budget({ dailyBudget: 100 });

    for (let i = 0; i < MAX_IMAGE_SEARCHES_PER_JOB; i += 1) {
      await b.reserve('DESTINATION_PHOTO');
      b.recordSuccess();
    }
    // 8 次已用满
    expect((await b.reserve('DESTINATION_PHOTO')).allowed).toBe(false);

    // 但如果其中一次是失败的，额度归还后还能再试一次
    const fresh = budget({ dailyBudget: 100 }).budget;
    for (let i = 0; i < MAX_IMAGE_SEARCHES_PER_JOB; i += 1) {
      await fresh.reserve('DESTINATION_PHOTO');
      if (i === 0) fresh.recordFailure();
      else fresh.recordSuccess();
    }
    expect((await fresh.reserve('DESTINATION_PHOTO')).allowed).toBe(true);
  });
});

describe('全局日预算熔断', () => {
  it('达到阈值后全局拒绝', async () => {
    const counters = new InMemoryCounterStore();
    const key = imageSearchDailyKey(new Date('2026-08-19T00:00:00Z'));
    await counters.increment(key, 90_000);
    await counters.increment(key, 90_000);

    const { budget: b } = budget({ dailyBudget: 2, counters });
    expect(await b.reserve('FOOD_IMAGE')).toEqual({
      allowed: false,
      reason: 'GLOBAL_CIRCUIT_OPEN',
    });
  });

  it('阈值以下放行', async () => {
    const counters = new InMemoryCounterStore();
    await counters.increment(imageSearchDailyKey(new Date('2026-08-19T00:00:00Z')), 90_000);

    const { budget: b } = budget({ dailyBudget: 2, counters });
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
  });

  it('日键含日期，跨天自动重置', () => {
    expect(imageSearchDailyKey(new Date('2026-08-19T23:59:59Z'))).toBe(
      'search:image:daily:2026-08-19',
    );
    expect(imageSearchDailyKey(new Date('2026-08-20T00:00:00Z'))).toBe(
      'search:image:daily:2026-08-20',
    );
  });

  it('日键与 AI 图片的键不同（两个预算互不影响）', () => {
    expect(imageSearchDailyKey(new Date('2026-08-19T00:00:00Z'))).not.toContain('ai:image');
  });
});

describe('commit 与 refund 对日计数的影响', () => {
  it('commit 后日计数 +1', async () => {
    const { budget: b, counters } = budget();
    const key = imageSearchDailyKey(new Date('2026-08-19T00:00:00Z'));

    await b.reserve('FOOD_IMAGE');
    await b.commit();

    expect(await counters.peek(key)).toBe(1);
  });

  it('refund 不减日计数（它压根没加过）', async () => {
    /*
     * 与 AiImageBudget 同一处理：判定用 peek（只读），日计数只在 commit
     * 里加。因此 refund 只需要还任务内计数 —— 去减 Redis 会把别人
     * commit 的量减掉。
     */
    const { budget: b, counters } = budget();
    const key = imageSearchDailyKey(new Date('2026-08-19T00:00:00Z'));

    await b.reserve('FOOD_IMAGE');
    b.refund();

    expect(await counters.peek(key)).toBe(0);
    expect(b.used.searches).toBe(0);
  });

  it('refund 不计失败（同键去重的等待不是供应商故障）', async () => {
    const { budget: b } = budget();
    await b.reserve('FOOD_IMAGE');
    b.refund();
    await b.reserve('FOOD_IMAGE');
    b.refund();
    await b.reserve('FOOD_IMAGE');
    b.refund();

    // 三次 refund 之后仍然可以搜索
    expect((await b.reserve('FOOD_IMAGE')).allowed).toBe(true);
    expect(b.used.failures).toBe(0);
  });
});
