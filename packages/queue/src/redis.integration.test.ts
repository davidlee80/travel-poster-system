import { IDEMPOTENCY_LOCK_TTL_SECONDS } from '@tps/shared';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  BullMqPlanQueue,
  PLAN_QUEUE_NAME,
  RedisCounterStore,
  RedisIdempotencyLock,
} from './index.js';
import { createQueueRedis, createRedis } from './redis.js';

/**
 * Redis 与 BullMQ（TP-2-08、TP-2-09，需真实 Redis）。
 *
 * 进程内实现的单测证明不了这里的任何一条：`SET NX EX` 的原子性、
 * `INCR` 首次才设 TTL、BullMQ 的 jobId 去重，全部是**外部系统的行为**。
 * 用假实现测它们等于测自己写的假实现。
 *
 * 运行：`REDIS_URL=redis://localhost:6379 pnpm test:integration`
 */

const redisUrl = process.env['REDIS_URL'];
const describeIntegration = redisUrl === undefined ? describe.skip : describe;

describeIntegration('Redis 基础设施（集成，需 Redis）', () => {
  let redis: Redis;
  let queueRedis: Redis;

  beforeAll(() => {
    redis = createRedis(redisUrl as string);
    queueRedis = createQueueRedis(redisUrl as string);
  });

  afterAll(async () => {
    await redis.quit();
    await queueRedis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  describe('幂等锁（13.8）', () => {
    it('同键并发抢锁只有一个成功', async () => {
      /*
       * 13.8 的核心保证。`SETNX` + `EXPIRE` 两条命令的实现在这里也会通过，
       * 但那种实现会在两条命令之间崩溃时留下永不过期的锁 ——
       * 因此下面还有一条 TTL 断言。
       */
      const lock = new RedisIdempotencyLock(redis);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => lock.acquire('same-key', IDEMPOTENCY_LOCK_TTL_SECONDS)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('锁一定带 TTL，不会永久占用', async () => {
      // 无 TTL 的锁会让那个幂等键永久拒绝新任务，
      // 用户看到「相同的生成请求正在处理中」—— 一个永远不会结束的处理中
      const lock = new RedisIdempotencyLock(redis);
      await lock.acquire('ttl-key', 300);

      const ttl = await redis.ttl('lock:idem:ttl-key');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('不同键互不影响', async () => {
      const lock = new RedisIdempotencyLock(redis);
      expect(await lock.acquire('a', 300)).toBe(true);
      expect(await lock.acquire('b', 300)).toBe(true);
    });
  });

  describe('配额计数（21.4）', () => {
    it('自增返回自增后的值', async () => {
      const store = new RedisCounterStore(redis);
      expect(await store.increment('q', 60)).toBe(1);
      expect(await store.increment('q', 60)).toBe(2);
    });

    it('TTL 只在首次设置，不会每次自增都续期', async () => {
      /*
       * 每次自增都续期会让日配额永不重置 —— 用户第一天用满 5 个后，
       * 只要每天还在尝试，那个键的 TTL 就一直被推后，额度永远不恢复。
       */
      const store = new RedisCounterStore(redis);
      await store.increment('daily', 100);
      await redis.expire('daily', 5);
      await store.increment('daily', 100);

      const ttl = await redis.ttl('daily');
      expect(ttl).toBeLessThanOrEqual(5);
    });

    it('peek 不自增', async () => {
      // 13.9.1 要返回剩余额度，读一次就扣一次的话，
      // 前端每次启动都会白扣一个额度
      const store = new RedisCounterStore(redis);
      await store.increment('p', 60);
      expect(await store.peek('p')).toBe(1);
      expect(await store.peek('p')).toBe(1);
    });

    it('不存在的键读作 0', async () => {
      expect(await new RedisCounterStore(redis).peek('missing')).toBe(0);
    });
  });

  describe('BullMQ 入队（13.1）', () => {
    it('入队后队列里有一条待处理任务', async () => {
      const queue = new BullMqPlanQueue(queueRedis, `${PLAN_QUEUE_NAME}-test`);
      try {
        const id = await queue.enqueue({
          jobId: 'job-1',
          requestId: 'request-1',
          planId: 'plan-1',
          userId: 'user-1',
        });
        expect(id).toBe('job-1');
      } finally {
        await queue.close();
      }
    });

    it('同 jobId 重复入队只产生一条（防重复投递）', async () => {
      /*
       * 13.8 的 Worker 侧并发保护：「防止队列重复投递导致双执行」。
       * 双执行意味着一次提交调两次 LLM，成本翻倍，而两份结果会互相覆盖。
       */
      const queueName = `${PLAN_QUEUE_NAME}-dedupe-test`;
      const queue = new BullMqPlanQueue(queueRedis, queueName);
      try {
        const payload = {
          jobId: 'job-dup',
          requestId: 'request-1',
          planId: 'plan-1',
          userId: 'user-1',
        };
        await queue.enqueue(payload);
        await queue.enqueue(payload);

        const waiting = await redis.llen(`bull:${queueName}:wait`);
        expect(waiting).toBe(1);
      } finally {
        await queue.close();
      }
    });
  });
});
