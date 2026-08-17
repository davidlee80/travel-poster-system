import type { Redis } from 'ioredis';

/**
 * 素材缓存的 Redis 快路径（TP-3-13，设计稿 19.3）。
 *
 * ## Redis 侧只存 `cache_key → asset_id` 的轻量映射
 *
 * 19.3 明确：`assets.cache_key` 的唯一索引是**最终真相**，Redis 只是
 * 跳过一次数据库查询的快路径。因此这里不缓存素材内容、不缓存评分、
 * 不缓存 URL —— 那些都会在素材被人工下架（`assets.status`）后变成
 * 「Redis 里还有一份可用的旧数据」，而下架的原因通常是版权问题。
 *
 * 值只有一个 UUID，30 天 TTL。Redis 冷启动只损失一次数据库查询，
 * 不会导致重复生成（19.3 的原话）。
 *
 * ## 为什么不设「负缓存」
 *
 * 未命中不写任何标记。写负缓存能省下重复的数据库查询，但代价是
 * 「刚生成好的素材在 N 分钟内查不到」—— 而生成一张 Hero 要 10～40 秒，
 * 白生成一次的成本远高于一次索引查询。
 */

/** 19.3：Redis 键映射 30 天 */
export const ASSET_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AssetCacheIndex {
  /** 返回 `asset_id`，未命中为 null */
  get(cacheKey: string): Promise<string | null>;
  set(cacheKey: string, assetId: string): Promise<void>;
  /** 素材下架或键版本递增时清掉映射 */
  invalidate(cacheKey: string): Promise<void>;
}

function redisKey(cacheKey: string): string {
  return `asset:key:${cacheKey}`;
}

export class RedisAssetCacheIndex implements AssetCacheIndex {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = ASSET_CACHE_TTL_SECONDS,
  ) {}

  async get(cacheKey: string): Promise<string | null> {
    return this.redis.get(redisKey(cacheKey));
  }

  async set(cacheKey: string, assetId: string): Promise<void> {
    /*
     * 每次命中都续期（`EX` 而不是只在首次设置）：19.3 的意图是
     * 「热键常驻」。冷键 30 天后自然过期，而数据库里的素材仍在 ——
     * 过期只损失一次查询。
     */
    await this.redis.set(redisKey(cacheKey), assetId, 'EX', this.ttlSeconds);
  }

  async invalidate(cacheKey: string): Promise<void> {
    await this.redis.del(redisKey(cacheKey));
  }
}

/** 进程内实现，供单测与本地无 Redis 运行使用 */
export class InMemoryAssetCacheIndex implements AssetCacheIndex {
  private readonly store = new Map<string, string>();

  get(cacheKey: string): Promise<string | null> {
    return Promise.resolve(this.store.get(cacheKey) ?? null);
  }

  set(cacheKey: string, assetId: string): Promise<void> {
    this.store.set(cacheKey, assetId);
    return Promise.resolve();
  }

  invalidate(cacheKey: string): Promise<void> {
    this.store.delete(cacheKey);
    return Promise.resolve();
  }
}
