import { Redis, type RedisOptions } from 'ioredis';
import type { CounterStore, IdempotencyLock } from '@tps/shared';

/**
 * Redis 基础设施（设计稿 13.8、21.4）。
 *
 * P1 用进程内实现跑通了身份链路（多实例不安全，见 apps/api/src/main.ts 的
 * 说明）。P2 换成 Redis：幂等锁（13.8）、配额计数（21.4）、队列（BullMQ）
 * 三者都需要它。
 */

/**
 * 队列与业务用的连接分开建。
 *
 * BullMQ 要求 `maxRetriesPerRequest: null`（它自己管重试，且阻塞命令
 * 不能被 ioredis 的重试打断）。而业务侧的幂等锁与配额计数**必须**有
 * 重试上限：Redis 抖动时它们应当尽快失败并走降级路径（唯一索引兜底 /
 * 拒绝请求），无限重试会把 HTTP 请求挂在那里直到客户端超时。
 */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    ...options,
  });
}

export function createQueueRedis(url: string): Redis {
  return new Redis(url, {
    // BullMQ 的硬性要求，不是调优选项
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * 13.8 的幂等快路径锁：`SETNX lock:idem:{key}`，TTL 300 秒。
 *
 * 用 `SET key value NX EX ttl` 而不是 `SETNX` + `EXPIRE` 两条命令：
 * 两条命令之间进程崩溃会留下一个**永不过期**的锁，那个幂等键从此
 * 永久拒绝新任务，而用户看到的是「相同的生成请求正在处理中」——
 * 一个永远不会结束的处理中。
 */
export class RedisIdempotencyLock implements IdempotencyLock {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(`lock:idem:${key}`, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
}

/**
 * 21.4 的配额计数。
 *
 * `INCR` 返回自增后的值，天然原子；TTL 只在首次出现时设置
 * （`INCR` 返回 1 即首次），否则每次自增都续期会让日配额永不重置。
 */
export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.redis.incr(key);
    if (value === 1) await this.redis.expire(key, ttlSeconds);
    return value;
  }

  async peek(key: string): Promise<number> {
    const raw = await this.redis.get(key);
    return raw === null ? 0 : Number(raw);
  }
}
