import { describe, expect, it } from 'vitest';

import {
  QUEUE_ADMISSION_MAX_DEPTH,
  createQueueDepthTracker,
  decideAdmission,
} from './queue-depth.js';

/**
 * 背压准入的判定（补 F1「队列深度只观测、不准入」）。
 *
 * 每条断言对应一个具体后果：
 *   - 不可判定时拒绝 → Redis 采样一挂，全站无法生成计划；
 *   - 阈值定在告警值 → 告警有意容忍的瞬时突发全变成用户可见的 503；
 *   - Retry-After 给 0/1 秒 → 客户端立刻重试，自己成为新的压源。
 */

const QUEUE = 'travel-plan-generation';

describe('背压准入', () => {
  it('从未采样过时放行（fail open）', () => {
    /*
     * 与 13.8 的 Redis 幂等锁同一条取舍。fail closed 的后果是采样一挂，
     * `depthOf` 永远返回 null，于是**所有**生成请求都被拒 ——
     * 一个观测组件的故障变成了全站不可用。
     */
    const backlog = createQueueDepthTracker();
    expect(decideAdmission(backlog, QUEUE, 40)).toEqual({ admit: true });
  });

  it('深度在阈值以内放行', () => {
    const backlog = createQueueDepthTracker();
    backlog.record(QUEUE, 40);
    expect(decideAdmission(backlog, QUEUE, 40)).toEqual({ admit: true });
  });

  it('超过阈值拒绝，并带上深度与 Retry-After', () => {
    const backlog = createQueueDepthTracker();
    backlog.record(QUEUE, 41);

    const decision = decideAdmission(backlog, QUEUE, 40);

    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.depth).toBe(41);
    /* 排空 1 条约 13 秒，但下限夹在 15 —— 见下一条 */
    expect(decision.retryAfterSeconds).toBe(15);
  });

  it('Retry-After 夹在 15～300 秒', () => {
    const backlog = createQueueDepthTracker();

    /* 刚过阈值：算出来不足 15 秒，取下限 —— 给 1 秒会让客户端变成新压源 */
    backlog.record(QUEUE, 41);
    const barely = decideAdmission(backlog, QUEUE, 40);
    expect(barely.admit === false && barely.retryAfterSeconds).toBe(15);

    /* 深度爆表：算出来上千秒，取上限 —— 给 1 小时等同于赶客 */
    backlog.record(QUEUE, 1_000);
    const flooded = decideAdmission(backlog, QUEUE, 40);
    expect(flooded.admit === false && flooded.retryAfterSeconds).toBe(300);
  });

  it('两个队列各自独立判定', () => {
    /*
     * 生成队列与导出队列的消费者是不同进程。共用一个判定的表现是
     * 生成积压时导出也被拒，而 render-worker 此刻可能完全空闲。
     */
    const backlog = createQueueDepthTracker();
    backlog.record(QUEUE, 100);
    backlog.record('travel-plan-export', 0);

    expect(decideAdmission(backlog, QUEUE, 40).admit).toBe(false);
    expect(decideAdmission(backlog, 'travel-plan-export', 40).admit).toBe(true);
  });

  it('默认阈值远高于积压告警的 8，且低于 600 秒的排队上限', () => {
    /*
     * 这条把两侧的边界一起钉住：
     *
     * 下界 —— `TravelQueueBacklogHigh` 在 > 8 时告警，那是「叫人扩容」而
     *   不是拒绝点。准入等于它的表现是告警有意容忍的五分钟突发全变 503。
     * 上界 —— 16.3 的队列等待上限 600 秒，按告警注释给的 4.5 任务/分钟
     *   折算约 45 条。超过它才拒的话，拒的已经不是「注定失败的活」，
     *   而是先收了钱再让它 JOB_QUEUE_TIMEOUT。
     */
    expect(QUEUE_ADMISSION_MAX_DEPTH).toBeGreaterThan(8);
    expect(QUEUE_ADMISSION_MAX_DEPTH).toBeLessThan(45);
  });
});
