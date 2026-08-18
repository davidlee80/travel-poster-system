import { describe, expect, it } from 'vitest';

import { StageTimer, TOTAL_STAGE } from './stage-timer.js';

/** 时钟：按给定序列返回时刻，用尽后停在最后一个 */
function clock(times: readonly number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)] ?? 0;
}

describe('StageTimer', () => {
  it('第一次 enter 不产生耗时（没有上一个阶段可结算）', () => {
    const timer = new StageTimer(1_000, clock([1_200]), '1-7');
    expect(timer.enter('NORMALIZING')).toEqual({});
  });

  it('每次 enter 结算上一个阶段的耗时', () => {
    const timer = new StageTimer(0, clock([100, 400, 1_000]), '1-7');

    timer.enter('NORMALIZING');
    expect(timer.enter('VALIDATING_REQUEST')).toEqual({ NORMALIZING: 300 });
    expect(timer.enter('GENERATING_PLAN')).toEqual({ VALIDATING_REQUEST: 600 });
  });

  it('finish 结算当前阶段并追加 total', () => {
    const timer = new StageTimer(0, clock([100, 2_100]), '1-7');

    timer.enter('GENERATING_PLAN');
    /*
     * total 从**构造时刻**算（入队时刻），因此包含第一次 enter 之前的
     * 那 100 毫秒 —— 那段是排队与读上下文的时间，它同样是用户的等待。
     */
    expect(timer.finish('ok')).toEqual({ GENERATING_PLAN: 2_000, [TOTAL_STAGE]: 2_100 });
  });

  it('finish 幂等：第二次调用不再产生耗时', () => {
    const timer = new StageTimer(0, clock([100, 500, 9_999]), '1-7');

    timer.enter('SAVING_PLAN');
    expect(timer.finish('failed')).toEqual({ SAVING_PLAN: 400, [TOTAL_STAGE]: 500 });

    /*
     * 终局有两条会汇合的路径：写终态的 UPDATE 返回 false（用户此刻取消了），
     * 调用方随即走取消分支 —— 两处都要结算。不幂等的话 `total` 会被观测两次，
     * 而 21.2 的 P95 是按样本数算的。
     */
    expect(timer.finish('cancelled')).toEqual({});
  });

  it('同一阶段被多次进入时，返回的是最后一次的耗时', () => {
    const timer = new StageTimer(0, clock([0, 100, 300, 700, 1_500]), '8-14');

    timer.enter('VALIDATING_PLAN');
    timer.enter('REPAIRING_PLAN');
    // 回边：REPAIRING_PLAN → VALIDATING_PLAN（3.2.2 的修复循环）
    expect(timer.enter('VALIDATING_PLAN')).toEqual({ REPAIRING_PLAN: 200 });
    expect(timer.enter('REPAIRING_PLAN')).toEqual({ VALIDATING_PLAN: 400 });

    /*
     * 库里存的是最后一次（SQL 侧 `||` 覆盖同名键），而指标里每一轮都有
     * 观测 —— 这个不对称是有意的，理由见 stage-timer.ts。
     */
  });
});
