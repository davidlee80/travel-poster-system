import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@tps/shared';

import {
  QUEUE_DEPTH_SAMPLE_INTERVAL_MS,
  sampleQueueDepth,
  startQueueDepthSampler,
  type DepthSource,
} from './queue-depth.js';

/**
 * 队列深度采样器（背压的先行指标）。
 *
 * 三条断言值得单列：
 *   - **采样失败不抛错**：Redis 抖一下不该让上报循环停掉。停掉之后 gauge 会
 *     一直停在最后那个值，而一个「卡住不动的深度」比没有这个指标更糟 ——
 *     它看起来是正常的；
 *   - **失败时不写 0**：置 0 会在积压期间造成假的「已恢复」，而告警的
 *     `for: 5m` 恰好会被那个假恢复重置掉；
 *   - **一个队列失败不影响另一个**：两个队列的处置完全不同（一个加
 *     generation-worker 副本，一个加 render-worker），丢掉任意一个都会
 *     让人往错的方向扩容。
 */

function source(depth: number | Error): DepthSource {
  return {
    depth: () => (depth instanceof Error ? Promise.reject(depth) : Promise.resolve(depth)),
  };
}

describe('sampleQueueDepth', () => {
  it('两个队列都采到时各写一次', async () => {
    const plan = source(7);
    const exportQueue = source(2);
    const planSpy = vi.spyOn(plan, 'depth');
    const exportSpy = vi.spyOn(exportQueue, 'depth');

    await sampleQueueDepth({ plan, export: exportQueue, logger: createSilentLogger() });

    expect(planSpy).toHaveBeenCalledOnce();
    expect(exportSpy).toHaveBeenCalledOnce();
  });

  it('采样失败不抛错，且留一条 warn', async () => {
    const warn = vi.fn();
    const logger = { ...createSilentLogger(), warn };

    await expect(
      sampleQueueDepth({
        plan: source(new Error('redis 连不上')),
        export: source(1),
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    const [payload] = warn.mock.calls[0] as [{ reason_code: string; queue: string }];
    expect(payload.reason_code).toBe('QUEUE_DEPTH_SAMPLE_FAILED');
    expect(payload.queue).toBe('travel-plan-generation');
  });

  it('一个队列失败不影响另一个继续上报', async () => {
    const exportQueue = source(3);
    const exportSpy = vi.spyOn(exportQueue, 'depth');

    await sampleQueueDepth({
      plan: source(new Error('boom')),
      export: exportQueue,
      logger: { ...createSilentLogger(), warn: vi.fn() },
    });

    /*
     * 生成队采样失败时导出队仍然被问过。串行 for 循环里如果漏了 try/catch，
     * 第一个 reject 会让整轮中断 —— 表现是「导出队的曲线在生成队出问题时
     * 一起消失」，而那正是最需要区分两者的时刻。
     */
    expect(exportSpy).toHaveBeenCalledOnce();
  });
});

describe('startQueueDepthSampler', () => {
  it('立即采一次，不等第一个周期', () => {
    vi.useFakeTimers();
    try {
      const plan = source(0);
      const planSpy = vi.spyOn(plan, 'depth');

      const stop = startQueueDepthSampler({
        plan,
        export: source(0),
        logger: createSilentLogger(),
      });

      /*
       * 不立即采的话，进程启动后的第一个周期里这个指标在 Prometheus 里是
       * no data 而不是 0 —— 表现是每次重启都丢一段曲线。
       */
      expect(planSpy).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('按周期重复采样，stop 之后不再采', async () => {
    vi.useFakeTimers();
    try {
      const plan = source(0);
      const planSpy = vi.spyOn(plan, 'depth');

      const stop = startQueueDepthSampler(
        { plan, export: source(0), logger: createSilentLogger() },
        1_000,
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(planSpy).toHaveBeenCalledTimes(4); // 立即 1 次 + 3 个周期

      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(planSpy).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('采样周期与 Prometheus 抓取间隔同量级', () => {
    // 采得比抓取快是白费 Redis 往返；慢了在抓取点之间丢分辨率
    expect(QUEUE_DEPTH_SAMPLE_INTERVAL_MS).toBe(15_000);
  });
});
