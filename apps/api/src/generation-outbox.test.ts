import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@tps/shared';
import { InMemoryPlanQueue } from '@tps/queue';
import type { GenerationOutboxRepository, OutboxClaim } from '@tps/db';
import { dispatchGenerationOutbox, startGenerationOutbox } from './generation-outbox.js';

/** 测试投递编排；SQL 租约和事务由 db 集成测试验证。 */
function harness() {
  let pending = true;
  let claimed = false;
  let attempts = 0;
  let ackFailure = false;
  let release = false;
  const outbox: GenerationOutboxRepository = {
    claim() {
      if (!pending || claimed) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve([{ jobId: 'job', token: 'token', attempts: ++attempts }]);
    },
    prepare(claim) {
      return Promise.resolve(
        release
          ? { kind: 'release', jobId: claim.jobId }
          : {
              kind: 'deliver',
              payload: {
                jobId: 'job',
                requestId: 'request',
                planId: 'plan',
                userId: 'user',
              },
            },
      );
    },
    acknowledge(_claim: OutboxClaim) {
      if (ackFailure) return Promise.reject(new Error('确认落库失败'));
      pending = false;
      return Promise.resolve(true);
    },
    retry() {
      claimed = false;
      return Promise.resolve(true);
    },
    stats() {
      return Promise.resolve({ pending: pending ? 1 : 0, oldestSeconds: 1 });
    },
  };
  const queue = new InMemoryPlanQueue();
  return {
    deps: { outbox, queue, logger: createSilentLogger(), releaseFailed: async (_id: string) => {} },
    pending: () => pending,
    attempts: () => attempts,
    failAck: (value: boolean) => {
      ackFailure = value;
    },
    requireRelease: () => {
      release = true;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Outbox 投递循环', () => {
  it('Redis 故障保留持久任务，下一轮恢复后交付', async () => {
    const h = harness();
    const enqueue = h.deps.queue.enqueue.bind(h.deps.queue);
    vi.spyOn(h.deps.queue, 'enqueue')
      .mockRejectedValueOnce(new Error('Redis down'))
      .mockImplementation(enqueue);
    await dispatchGenerationOutbox(h.deps);
    expect(h.pending()).toBe(true);
    expect(h.deps.queue.enqueued).toEqual([]);
    await dispatchGenerationOutbox(h.deps);
    expect(h.pending()).toBe(false);
    expect(h.deps.queue.enqueued).toHaveLength(1);
  });
  it('入队后确认失败可重投，业务 jobId 去重', async () => {
    const h = harness();
    h.failAck(true);
    await dispatchGenerationOutbox(h.deps);
    expect(h.pending()).toBe(true);
    h.failAck(false);
    await dispatchGenerationOutbox(h.deps);
    expect(h.attempts()).toBe(2);
    expect(h.deps.queue.enqueued).toHaveLength(1);
    expect(h.pending()).toBe(false);
  });
  it('取消或超期必须等待预留释放成功，失败留待下一轮', async () => {
    const h = harness();
    h.requireRelease();
    h.deps.releaseFailed = () => Promise.reject(new Error('钱包暂不可用'));
    await dispatchGenerationOutbox(h.deps);
    expect(h.pending()).toBe(true);
    h.deps.releaseFailed = async () => {};
    await dispatchGenerationOutbox(h.deps);
    expect(h.pending()).toBe(false);
    expect(h.deps.queue.enqueued).toEqual([]);
  });
  it('单次投递 5 秒超时，不能无限占用租约', async () => {
    vi.useFakeTimers();
    const h = harness();
    const enqueue = vi
      .spyOn(h.deps.queue, 'enqueue')
      .mockImplementation(() => new Promise(() => {}));
    const batch = dispatchGenerationOutbox(h.deps);
    await vi.advanceTimersByTimeAsync(5001);
    await batch;
    expect(h.pending()).toBe(true);
    enqueue.mockResolvedValue('job');
    await dispatchGenerationOutbox(h.deps);
    expect(h.pending()).toBe(false);
  });
  it('启动立即扫描；停止等待当前批次结束，不再启动下一轮', async () => {
    vi.useFakeTimers();
    const h = harness();
    let complete!: (value: string) => void;
    vi.spyOn(h.deps.queue, 'enqueue').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const stop = startGenerationOutbox(h.deps);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);
    complete('job');
    await stopping;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.attempts()).toBe(1);
    expect(h.pending()).toBe(false);
  });
});
