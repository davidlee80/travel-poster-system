import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ASSET_CACHE_TTL_SECONDS, RedisAssetCacheIndex } from './asset-cache.js';
import { createRedis } from './redis.js';

/**
 * 素材缓存的 Redis 快路径（TP-3-13，需真实 Redis）。
 *
 * 只验证 Redis 侧的行为：TTL 真的被设上、命中会续期、失效会删除。
 * 这几条用进程内实现测等于测自己写的 Map。
 *
 * 运行：`REDIS_URL=redis://localhost:6379 pnpm test:integration`
 */

const redisUrl = process.env['REDIS_URL'];
const describeIntegration = redisUrl === undefined ? describe.skip : describe;

const KEY = 'hero:v1:cn-hangzhou:canal_culture:chinese_travel_editorial:16x6';
const ASSET_ID = '4d1b8c2e-0000-4000-8000-000000000001';

describeIntegration('素材缓存索引（集成，需 Redis）', () => {
  let redis: Redis;
  let index: RedisAssetCacheIndex;

  beforeAll(() => {
    redis = createRedis(redisUrl as string);
    index = new RedisAssetCacheIndex(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('写入后可读回，且带 30 天 TTL（19.3）', async () => {
    await index.set(KEY, ASSET_ID);

    expect(await index.get(KEY)).toBe(ASSET_ID);

    const ttl = await redis.ttl(`asset:key:${KEY}`);
    expect(ttl).toBeGreaterThan(ASSET_CACHE_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(ASSET_CACHE_TTL_SECONDS);
  });

  it('未命中返回 null，且不写任何标记（不做负缓存）', async () => {
    expect(await index.get('hero:v1:nope:general:x:1x1')).toBeNull();

    /*
     * 负缓存能省下重复的数据库查询，但代价是「刚生成好的素材在 N 分钟内
     * 查不到」—— 而生成一张 Hero 要 10～40 秒。白生成一次远比多查一次索引贵。
     */
    const keys = await redis.keys('asset:key:*');
    expect(keys).toEqual([]);
  });

  it('重复写入会续期（热键常驻）', async () => {
    const shortLived = new RedisAssetCacheIndex(redis, 100);
    await shortLived.set(KEY, ASSET_ID);
    const first = await redis.ttl(`asset:key:${KEY}`);

    const longer = new RedisAssetCacheIndex(redis, 500);
    await longer.set(KEY, ASSET_ID);
    const second = await redis.ttl(`asset:key:${KEY}`);

    expect(first).toBeLessThanOrEqual(100);
    expect(second).toBeGreaterThan(100);
  });

  it('失效后不再命中（素材下架 / 键版本递增）', async () => {
    await index.set(KEY, ASSET_ID);
    await index.invalidate(KEY);
    expect(await index.get(KEY)).toBeNull();
  });

  it('值只有素材 ID —— 不含 URL、评分或任何素材内容（19.3）', async () => {
    await index.set(KEY, ASSET_ID);
    const raw = await redis.get(`asset:key:${KEY}`);

    /*
     * 缓存素材内容的问题是「下架后 Redis 里还有一份可用的旧数据」，
     * 而下架的原因通常是版权。只存 ID 意味着每次命中都会回表读现状。
     */
    expect(raw).toBe(ASSET_ID);
    expect(raw).not.toContain('http');
  });
});
