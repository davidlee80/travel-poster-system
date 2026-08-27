import type { Redis } from 'ioredis';

/**
 * 素材缓存键的并发去重锁（TP-4-06，设计稿 13.8、19.5）。
 *
 * ## 它防的是什么
 *
 * 13.8：「素材解析对同一缓存键取 `lock:asset:{cache_key}`，避免 N 天同主题
 * Hero 并发重复生成 —— **这一项对成本影响最大**」。
 *
 * 具体场景：14 天的行程归入 3 个主题桶，因此只有 3 个不同的 Hero 缓存键。
 * 但 21.2 的并发模型是「天级 8」—— 8 天同时开始解析，其中可能有 5 天落在
 * 同一个桶里。没有这把锁的话，5 天各自发现「缓存里没有」，于是 5 次
 * AI 调用（5 × 成本、5 × 20 秒），最后 4 次的产物在
 * `assets_cache_key_uk` 上冲突被丢弃 —— 钱已经花掉了。
 *
 * ## 为什么不能只靠数据库唯一索引
 *
 * 唯一索引是**写入时**的去重，而 AI 生成的成本发生在写入**之前**。
 * 它能保证库里只有一行，保证不了只调用一次。
 *
 * ## 未拿到锁的一方要等结果，不是直接降级
 *
 * TP-4-06 的验证条目是「同键 10 并发只 1 次生成，**其余等待结果**」。
 * 直接降级到占位图的话，14 天里只有 1 天有 Hero，其余 13 天是渐变背景 ——
 * 而缓存明明在几秒后就有了。等待的实现（轮询 `findByCacheKey`）在
 * resolver 里，因为它需要仓储；这里只提供锁语义。
 */

export interface AssetLock {
  /** 返回 true 表示由本次调用负责生成。TTL 缺省为 `ASSET_LOCK_TTL_SECONDS` */
  acquire(cacheKey: string, ttlSeconds?: number): Promise<boolean>;
  release(cacheKey: string): Promise<void>;
}

/**
 * TTL 默认 60 秒。
 *
 * 必须**长于单候选图片超时**（`AI_IMAGE_TIMEOUT_MS`，当前 40 秒）：锁要活过
 * 整个生成 + 后处理 + 上传 + 落库的过程。取得太短的表现是「锁在生成完成前
 * 过期，第二个调用方开始重复生成」—— 也就是这把锁没起作用，而且不会报错。
 *
 * 上限也不能太长：持锁进程崩溃后，等待方要靠 TTL 过期才能接手。
 *
 * > **R-82：这个值曾经是 30 秒，而当时的理由写的是「比 AI 生成超时（20 秒）
 * > 多 10 秒」。那句话在写下时是对的，但多模型故障转移那轮把单候选超时从
 * > 20 秒放宽到 40 秒（见 `image.ts` 里「原先 IMAGE_TIMEOUT_MS > 20000 即硬拒」
 * > 那段），**TTL 没跟着调** —— 于是锁反而比它保护的操作短 10 秒，上面那句
 * > 「取得太短的表现」正好描述了当时的实际状态。
 * >
 * > 后果是双倍 AI 成本加一个孤儿对象，而两者都不报错。
 * > 现已由 `asset-lock-ttl.test.ts` 的跨包断言钉住两者的大小关系。
 */
export const ASSET_LOCK_TTL_SECONDS = 60;

export class RedisAssetLock implements AssetLock {
  constructor(private readonly redis: Redis) {}

  private key(cacheKey: string): string {
    return `lock:asset:${cacheKey}`;
  }

  async acquire(cacheKey: string, ttlSeconds = ASSET_LOCK_TTL_SECONDS): Promise<boolean> {
    // 与 RedisIdempotencyLock 同一处理：SET NX EX 一条命令，不用 SETNX + EXPIRE
    const result = await this.redis.set(this.key(cacheKey), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async release(cacheKey: string): Promise<void> {
    await this.redis.del(this.key(cacheKey));
  }
}

/**
 * 进程内实现：单测与无 Redis 的本地开发用。
 *
 * **单进程内有效，多实例部署下无效** —— 与 P1 的进程内会话存储同一处境。
 * 装配它的进程必须清楚这一点：多副本 Worker 用它等于没有锁，
 * 表现是 AI 调用量与副本数成正比。
 */
export class InMemoryAssetLock implements AssetLock {
  private readonly held = new Set<string>();

  acquire(cacheKey: string): Promise<boolean> {
    if (this.held.has(cacheKey)) return Promise.resolve(false);
    this.held.add(cacheKey);
    return Promise.resolve(true);
  }

  release(cacheKey: string): Promise<void> {
    this.held.delete(cacheKey);
    return Promise.resolve();
  }
}
