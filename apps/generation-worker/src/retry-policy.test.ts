import { describe, expect, it } from 'vitest';

import { isUnrecoverable } from './retry-policy.js';

/**
 * 13.7 重试策略的第四层（TP-4-11）。
 *
 * 「不占用队列重试次数」不是优化而是正确性：
 * `PLAN_HARD_CONSTRAINT_UNSATISFIABLE` 的含义是「用户勾的 MUST 条件互相
 * 矛盾」，重试三次只会得到三次同样的结论，而每次都要跑完整的模型生成 ——
 * 用户等三倍时间，我们付三倍的钱，结论一字不变。
 */

describe('不可重试的码', () => {
  it('PLAN_HARD_CONSTRAINT_UNSATISFIABLE 不重试（13.7 点名的那一个）', () => {
    expect(isUnrecoverable('PLAN_HARD_CONSTRAINT_UNSATISFIABLE')).toBe(true);
  });

  it.each([
    'REQ_SCHEMA_INVALID',
    'REQ_START_DATE_IN_PAST',
    'REQ_BUDGET_INFEASIBLE',
    'REQ_DESTINATION_UNKNOWN',
  ])('全部 REQ_* 不重试：%s', (code) => {
    expect(isUnrecoverable(code)).toBe(true);
  });

  it('PLAN_NOT_FOUND 与 JOB_NOT_FOUND 不重试', () => {
    expect(isUnrecoverable('PLAN_NOT_FOUND')).toBe(true);
    expect(isUnrecoverable('JOB_NOT_FOUND')).toBe(true);
  });
});

describe('可重试的码', () => {
  it.each([
    'PLAN_LLM_TIMEOUT',
    'PLAN_LLM_UNAVAILABLE',
    'PLAN_SCHEMA_INVALID',
    'PLAN_REPAIR_EXHAUSTED',
    'PLAN_PERSIST_FAILED',
    'JOB_TIMEOUT',
    'JOB_QUEUE_TIMEOUT',
    'SYS_INTERNAL_ERROR',
    'SYS_DEPENDENCY_UNAVAILABLE',
  ])('%s 交给队列退避重试', (code) => {
    expect(isUnrecoverable(code)).toBe(false);
  });

  it('未登记的码按可重试处理', () => {
    /*
     * 与 isBlocking 的默认值相反，而两者各有道理：
     * isBlocking 的保守方向是「宁可明确失败」，这里是「宁可多试一次」。
     * 把未知错误判成不可重试，会让一次没预料到的瞬时故障直接变成
     * 用户可见的永久失败。
     */
    expect(isUnrecoverable('SOMETHING_NEW')).toBe(false);
  });

  it('判定与 13.7 的 retryable 字段同源（两张表会漂移）', () => {
    // PLAN_SCHEMA_INVALID 在 13.7 里是 retryable: true —— 它计入重生成次数
    expect(isUnrecoverable('PLAN_SCHEMA_INVALID')).toBe(false);
  });
});
