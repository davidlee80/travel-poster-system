import type { Redis } from 'ioredis';

/**
 * 死信队列（TP-4-11，设计稿 13.7 的重试策略表）。
 *
 * 13.7：「队列级（BullMQ）`attempts: 3`，`backoff: exponential, delay 5000`，
 * **耗尽进入死信队列 `dlq:*`**」。
 *
 * ## 为什么不用 BullMQ 的 failed 集合当死信队列
 *
 * BullMQ 有 failed 集合，但它按 `removeOnFail: { age: 86_400 }` 过期
 * （见 plan-queue.ts）—— 一天后记录就没了。而死信的用途恰恰是「事后回捞」：
 * 上游故障持续一小时，那批任务要在故障修复后重放，而运维发现问题往往
 * 已经过了一天。
 *
 * 因此单独存一份不过期的列表。它只存标识符与失败原因，不存请求体
 * （与队列载荷同一处理：Redis 里不留 L1 个人数据的副本，见 plan-queue.ts）。
 *
 * ## 为什么是 LIST 而不是 STREAM
 *
 * 回捞是人工触发的一次性操作（读出来 → 决定重放哪些 → 重新入队），
 * 不需要消费组、不需要 ack。LIST 的 `LRANGE` + `LTRIM` 就够，
 * 而 STREAM 会引入「谁消费到哪」这个需要维护的状态。
 */

export const DLQ_KEY_PREFIX = 'dlq:';

/**
 * 死信条目。
 *
 * `failedAt` 由调用方传入而不是在这里取当前时间：Worker 与 Redis 的时钟
 * 可能不同，而回捞时要按「任务什么时候失败的」筛选 —— 用哪个时钟必须明确。
 */
export interface DeadLetterEntry {
  readonly jobId: string;
  readonly requestId: string;
  readonly planId: string;
  readonly userId: string;
  /** 13.7 的错误码，或 BullMQ 侧的失败原因 */
  readonly errorCode: string;
  readonly attemptsMade: number;
  readonly failedAt: string;
}

/**
 * 单个队列最多保留的死信条目数。
 *
 * 上限而不是无限：Redis 是内存存储，一次持续的上游故障可能产生上万条。
 * 超出后**丢弃最旧的**（`LTRIM` 保留最新的 N 条）—— 最新的那些才是
 * 运维正在排查的那一批，而最旧的往往已经被用户自己重试掉了。
 */
export const DLQ_MAX_ENTRIES = 10_000;

export interface DeadLetterQueue {
  push(queueName: string, entry: DeadLetterEntry): Promise<void>;
  /** 回捞：读出最新的 N 条，不移除 */
  peek(queueName: string, limit: number): Promise<readonly DeadLetterEntry[]>;
  size(queueName: string): Promise<number>;
}

export class RedisDeadLetterQueue implements DeadLetterQueue {
  constructor(private readonly redis: Redis) {}

  private key(queueName: string): string {
    return `${DLQ_KEY_PREFIX}${queueName}`;
  }

  async push(queueName: string, entry: DeadLetterEntry): Promise<void> {
    const key = this.key(queueName);
    /*
     * LPUSH + LTRIM 而不是 RPUSH：新条目在头部，`LRANGE key 0 N` 就是
     * 「最新的 N 条」。用 RPUSH 的话回捞要先知道总长度才能算出区间。
     */
    await this.redis.lpush(key, JSON.stringify(entry));
    await this.redis.ltrim(key, 0, DLQ_MAX_ENTRIES - 1);
  }

  async peek(queueName: string, limit: number): Promise<readonly DeadLetterEntry[]> {
    const raw = await this.redis.lrange(this.key(queueName), 0, Math.max(0, limit - 1));
    const entries: DeadLetterEntry[] = [];
    for (const item of raw) {
      try {
        entries.push(JSON.parse(item) as DeadLetterEntry);
      } catch {
        /*
         * 解析不了的条目跳过而不是抛错：死信队列本身不该成为故障点。
         * 一条坏数据（比如手工塞进去的）不该让整次回捞失败。
         */
        continue;
      }
    }
    return entries;
  }

  size(queueName: string): Promise<number> {
    return this.redis.llen(this.key(queueName));
  }
}

/** 进程内实现：单测与无 Redis 的本地开发用 */
export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  private readonly entries = new Map<string, DeadLetterEntry[]>();

  push(queueName: string, entry: DeadLetterEntry): Promise<void> {
    const list = this.entries.get(queueName) ?? [];
    list.unshift(entry);
    this.entries.set(queueName, list.slice(0, DLQ_MAX_ENTRIES));
    return Promise.resolve();
  }

  peek(queueName: string, limit: number): Promise<readonly DeadLetterEntry[]> {
    return Promise.resolve((this.entries.get(queueName) ?? []).slice(0, limit));
  }

  size(queueName: string): Promise<number> {
    return Promise.resolve((this.entries.get(queueName) ?? []).length);
  }
}
