import type { PlanQueue } from '@tps/queue';

/**
 * Fake 队列实现。
 *
 * 用于测试：模拟队列的入队延迟/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **延迟模拟**：`enqueueDelayMs` 模拟入队慢；
 * - **故障模拟**：`enqueueError` 模拟入队失败；
 * - **消费延迟**：`consumeDelayMs` 模拟消费慢（用于测试背压）。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/queue/src/plan-queue.ts`）会：
 * 1. 连接 Redis；
 * 2. 调用 BullMQ 的 `queue.add`；
 * 3. 管理重试与去重。
 *
 * Fake 实现**不执行**这些操作，只记录入队事实或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖 Redis 状态，不依赖网络。
 */
export interface FakeQueueBehavior {
  /** 入队延迟毫秒数 */
  readonly enqueueDelayMs?: number;
  /** 消费延迟毫秒数 */
  readonly consumeDelayMs?: number;
  /** 入队故障 */
  readonly enqueueError?: Error;
}

/**
 * 包装 `PlanQueue`，注入编排行为。
 */
export function wrapQueue(queue: PlanQueue, behavior: FakeQueueBehavior): PlanQueue {
  return {
    ...queue,
    enqueue: async (payload) => {
      if (behavior.enqueueError) {
        throw behavior.enqueueError;
      }

      if (behavior.enqueueDelayMs !== undefined && behavior.enqueueDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.enqueueDelayMs));
      }

      return queue.enqueue(payload);
    },
  };
}
