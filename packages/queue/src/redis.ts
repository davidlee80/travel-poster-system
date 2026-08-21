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
 * 13.8 的 Worker 侧并发保护：`lock:job:{job_id}`，TTL 600 秒。
 *
 * BullMQ 的 jobId 去重只防「同一队列里入两条」，防不住**同一条消息被两个
 * Worker 实例同时消费**（消息可见性超时、实例重启后的重投递都会造成）。
 * 双执行意味着一次提交调两次 LLM：成本翻倍，而两份结果会互相覆盖 ——
 * 后写入的那份版本号更大，用户看到的是其中随机一份。
 *
 * 处理完成后主动释放：600 秒的 TTL 是给「进程崩了」兜底的，
 * 正常路径下不该让下一次重试等 10 分钟。
 */
export class RedisJobLock {
  constructor(private readonly redis: Redis) {}

  private key(jobId: string): string {
    return `lock:job:${jobId}`;
  }

  async acquire(jobId: string, ttlSeconds = 600): Promise<boolean> {
    const result = await this.redis.set(this.key(jobId), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async release(jobId: string): Promise<void> {
    await this.redis.del(this.key(jobId));
  }
}

/**
 * 21.4 的配额计数。
 *
 * `INCRBY` 返回自增后的值，天然原子；TTL 只在首次出现时设置
 * （返回值等于本次增量即首次），否则每次自增都续期会让日配额永不重置。
 */
export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttlSeconds: number, amount = 1): Promise<number> {
    const value = await this.redis.incrby(key, amount);
    /*
     * 判「首次」用 `value === amount` 而不是 `value === 1`：一次加 2 的
     * 首次调用会得到 2，按旧判据就不会设 TTL —— 那个键从此永不过期，
     * 于是日熔断在第一次多候选调用之后再也不会重置。
     */
    if (value === amount) await this.redis.expire(key, ttlSeconds);
    return value;
  }

  async peek(key: string): Promise<number> {
    const raw = await this.redis.get(key);
    return raw === null ? 0 : Number(raw);
  }
}
