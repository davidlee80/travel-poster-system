import { describe, expect, it } from 'vitest';

import { resolveCandidates } from './model-pools.js';

/**
 * 候选数的解析（纯函数部分）。
 *
 * 区间匹配与两张表为空的回落需要真实 SQL，在 `model-pools.integration.test.ts`。
 * 这里只测**截断**：它是配置搬进数据库后唯一的时延防线，而它的输入
 * （运营填的 max_candidates）不受任何启动校验保护。
 */

const base = { perAttemptMs: 40_000, totalBudgetMs: 80_000 };

describe('resolveCandidates', () => {
  it('maxCandidates 为 null 时用满整个池', () => {
    const result = resolveCandidates({ ...base, models: ['a', 'b'], maxCandidates: null });

    expect(result).toEqual({ candidates: ['a', 'b'], clamped: false });
  });

  it('maxCandidates 小于池长度时只取前几个', () => {
    const result = resolveCandidates({ ...base, models: ['a', 'b', 'c'], maxCandidates: 2 });

    // 顺序即优先级，取前缀而不是任意两个
    expect(result).toEqual({ candidates: ['a', 'b'], clamped: false });
  });

  it('maxCandidates 大于池长度时以池为准，且不算截断', () => {
    /*
     * 这不是配置错误：运营可以先设一个宽松的上限，之后往池里加模型。
     * 报成截断会让告警在完全正常的配置下响。
     */
    const result = resolveCandidates({ ...base, models: ['a'], maxCandidates: 5 });

    expect(result).toEqual({ candidates: ['a'], clamped: false });
  });

  it('时延预算不够时截断，并标记 clamped', () => {
    /*
     * 运营把 max_candidates 改成 10，而 10 × 40 秒 = 400 秒会突破 300 秒的
     * 任务上限。启动校验管不到数据库里的值，只能在这里挡。
     */
    const result = resolveCandidates({
      models: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      maxCandidates: 10,
      perAttemptMs: 40_000,
      totalBudgetMs: 80_000,
    });

    expect(result.candidates).toEqual(['a', 'b']);
    /*
     * clamped 必须为真：静默截断会让运营以为配置生效了，
     * 而实际只有前两个候选在用。
     */
    expect(result.clamped).toBe(true);
  });

  it('预算比单次超时还小时仍然给一个候选', () => {
    /*
     * 一张图都不生成比只试一次更糟，而这种配置本身会被启动校验挡住
     * （IMAGE_TIMEOUT_MS 必须 ≤ IMAGE_JOB_AI_BUDGET_MS）。这里是兜底，
     * 保证不会算出 0 个候选。
     */
    const result = resolveCandidates({
      models: ['a', 'b'],
      maxCandidates: 2,
      perAttemptMs: 40_000,
      totalBudgetMs: 10_000,
    });

    expect(result.candidates).toEqual(['a']);
    expect(result.clamped).toBe(true);
  });

  it('空池返回空候选，不抛错', () => {
    /*
     * 数据库的 CHECK 不允许空池，因此走到这里只能是「过滤掉了非字符串项」
     * 之后变空。让它返回空数组而不是抛错：调用方会因此降级（图像走占位图），
     * 而抛错会让整个任务失败。
     */
    const result = resolveCandidates({ ...base, models: [], maxCandidates: null });

    expect(result.candidates).toEqual([]);
  });
});
