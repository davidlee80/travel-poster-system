import { describe, expect, it } from 'vitest';

import {
  JOB_TIMEOUT_MS,
  QUEUE_TIMEOUT_MS,
  createJobDeadline,
  queueWaitExceeded,
} from './job-deadline.js';

/**
 * 16.3 的三层超时（TP-4-10）。
 *
 * 这两个数字来自 16.3 的超时表，而它们的用途是**止损**：
 * 300 秒之后继续跑下去，用户已经不在页面上了，而每一次模型调用都在花钱。
 */

describe('任务预算', () => {
  it('16.3：整个生成任务 300 秒、队列等待 600 秒', () => {
    expect(JOB_TIMEOUT_MS).toBe(300_000);
    expect(QUEUE_TIMEOUT_MS).toBe(600_000);
  });

  it('未超时前 expired 为 false，剩余递减', () => {
    let clock = 1_000;
    const deadline = createJobDeadline(clock, 10_000, () => clock);

    expect(deadline.expired()).toBe(false);
    expect(deadline.remainingMs()).toBe(10_000);

    clock += 4_000;
    expect(deadline.remainingMs()).toBe(6_000);
    expect(deadline.expired()).toBe(false);
  });

  it('超时后 expired 为 true，剩余不为负', () => {
    let clock = 0;
    const deadline = createJobDeadline(clock, 1_000, () => clock);
    clock = 5_000;

    expect(deadline.expired()).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('remainingFor 把外部调用的超时压到剩余预算内', () => {
    let clock = 0;
    const deadline = createJobDeadline(clock, 300_000, () => clock);

    // 预算充足时用偏好值
    expect(deadline.remainingFor(30_000)).toBe(30_000);

    // 只剩 8 秒时不会再发一个 30 秒超时的请求
    clock = 292_000;
    expect(deadline.remainingFor(30_000)).toBe(8_000);

    clock = 300_001;
    expect(deadline.remainingFor(30_000)).toBe(0);
  });
});

describe('队列等待', () => {
  it('600 秒以内放行', () => {
    expect(queueWaitExceeded(599_000)).toBe(false);
  });

  it('超过 600 秒判超时', () => {
    expect(queueWaitExceeded(601_000)).toBe(true);
  });

  it('恰好 600 秒不算超时（边界取「超过」）', () => {
    expect(queueWaitExceeded(QUEUE_TIMEOUT_MS)).toBe(false);
  });

  it('参数是已排队时长，不是入队时刻（R-40）', () => {
    /*
     * 这条断言钉住的是签名本身。改回「入队时刻 + 现在」的形式就意味着
     * 又在拿数据库时钟减进程时钟 —— 而那个减法在 stage_timings 上
     * 已经算出过负数。
     */
    expect(queueWaitExceeded(0)).toBe(false);
    expect(queueWaitExceeded(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
