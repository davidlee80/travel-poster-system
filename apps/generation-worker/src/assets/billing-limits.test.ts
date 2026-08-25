import { DEFAULT_JOB_LIMITS } from '@tps/billing';
import { describe, expect, it } from 'vitest';

import { MAX_AI_IMAGES_PER_JOB } from './ai-budget.js';
import { MAX_IMAGE_SEARCHES_PER_JOB } from './search-budget.js';

/**
 * 计费估算参数与 worker 里的真实上限必须相等。
 *
 * ## 为什么这个测试在这里
 *
 * `@tps/billing` 的 `estimateJobCost` 取的是**最坏情况上界**，而上界依赖
 * AI 图与图搜的单任务硬上限 —— 那两个常量在这个 app 里。包不能依赖 app，
 * 因此 billing 只能持有一份副本（`DEFAULT_JOB_LIMITS`）。
 *
 * 这里是仓库里**唯一**能同时 import 到两边的地方，所以守卫只能放这里。
 *
 * ## 不相等的后果
 *
 * 把 `MAX_AI_IMAGES_PER_JOB` 从 3 调到 5 而没同步 billing，估算就比真实上限低。
 * 于是预留不足，结算时 `balance_cr` 要被扣成负数 —— 而那一列有 `>= 0` 的
 * CHECK，事务会失败。表现是：**用户的计划已经生成好了，却因为结算失败而
 * 永远停在 COMPLETED 之前**。这个症状离根因（一个常量改了 2）非常远。
 *
 * 反过来（billing 的值更大）只是预留多了、结算时退还，不构成故障 ——
 * 因此断言是 `>=` 而不是 `===`：允许 billing 保守，不允许它乐观。
 */
describe('计费估算参数不低于真实硬上限', () => {
  it('AI 图张数', () => {
    expect(DEFAULT_JOB_LIMITS.maxAiImagesPerJob).toBeGreaterThanOrEqual(MAX_AI_IMAGES_PER_JOB);
  });

  it('图源搜索次数', () => {
    expect(DEFAULT_JOB_LIMITS.maxImageSearchesPerJob).toBeGreaterThanOrEqual(MAX_IMAGE_SEARCHES_PER_JOB);
  });

  it('重生成次数 —— 与 3.2.2 的上限一致（落库时有 CHECK 兜着）', () => {
    /*
     * `travel_plan_versions.regeneration_count` 的 CHECK 是 `BETWEEN 0 AND 2`，
     * 因此 2 是数据库层保证的上限，billing 不能估得比它低。
     */
    expect(DEFAULT_JOB_LIMITS.maxRegenerations).toBeGreaterThanOrEqual(2);
  });
});
