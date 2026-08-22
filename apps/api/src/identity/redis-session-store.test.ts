import { describe, expect, it } from 'vitest';
import { hashToken } from '@tps/shared';
import type { Redis } from '@tps/queue';

import { RedisSessionStore } from './redis-session-store.js';

/**
 * `RedisSessionStore` 的反向索引（`user-sessions:<id>`）。
 *
 * ## 为什么这一个类值得单测
 *
 * `revokeAllForUser` 是改口令的安全保证：改完之后别人手上那个会话必须失效。
 * 而 Redis 里会话是 `hash → user_id` 的单向映射，"按值查键" 不存在，
 * 于是这个保证完全落在一个**手工维护的索引**上。它出错的方式全都是安静的：
 *
 *   - 索引先于会话过期  → 那些会话再也吊销不掉，改口令悄悄失效
 *   - 集合为空时 `DEL`  → Redis 的 DEL 不接受零参数，改口令直接 500
 *
 * 两者都不会在本地开发中出现（一个要等 30 天，一个要恰好没有会话），
 * 因此用一个只实现六个命令的假 Redis 把它们钉住。
 */

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * 只实现 `RedisSessionStore` 用到的六个命令。
 *
 * 记录调用序列 —— 有些断言只能在命令层表达（"touch 是否对索引发过 EXPIRE"
 * 在数据层看不出来，因为这个假实现不真的让键过期）。
 */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly calls: Call[] = [];

  async set(key: string, value: string, _mode: string, _ttl: number): Promise<'OK'> {
    this.calls.push({ cmd: 'set', args: [key] });
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  async get(key: string): Promise<string | null> {
    this.calls.push({ cmd: 'get', args: [key] });
    return Promise.resolve(this.values.get(key) ?? null);
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.calls.push({ cmd: 'expire', args: [key, String(ttl)] });
    // 与 Redis 一致：对不存在的键无操作
    return Promise.resolve(this.values.has(key) || this.sets.has(key) ? 1 : 0);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      // 真实 Redis 的行为：ERR wrong number of arguments for 'del' command
      throw new Error('DEL 被调用时没有传任何键');
    }
    this.calls.push({ cmd: 'del', args: keys });
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key) || this.sets.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  async sadd(key: string, member: string): Promise<number> {
    this.calls.push({ cmd: 'sadd', args: [key, member] });
    const set = this.sets.get(key) ?? new Set<string>();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return Promise.resolve(had ? 0 : 1);
  }

  async smembers(key: string): Promise<string[]> {
    this.calls.push({ cmd: 'smembers', args: [key] });
    return Promise.resolve([...(this.sets.get(key) ?? [])]);
  }

  /** 测试辅助：某个命令作用在某个键上的次数 */
  countCalls(cmd: string, key: string): number {
    return this.calls.filter((c) => c.cmd === cmd && c.args[0] === key).length;
  }
}

function makeStore(): { store: RedisSessionStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { store: new RedisSessionStore(redis as unknown as Redis), redis };
}

describe('RedisSessionStore', () => {
  it('create 写入会话键并把哈希记进用户索引', async () => {
    const { store, redis } = makeStore();
    const created = await store.create('user-1');

    expect(await store.get(created.token)).toBe('user-1');
    expect(redis.sets.get('user-sessions:user-1')).toEqual(new Set([hashToken(created.token)]));
  });

  it('revokeAllForUser 删掉该用户的全部会话', async () => {
    const { store } = makeStore();
    const a = await store.create('user-1');
    const b = await store.create('user-1');
    const other = await store.create('user-2');

    await store.revokeAllForUser('user-1');

    expect(await store.get(a.token)).toBeNull();
    expect(await store.get(b.token)).toBeNull();
    // 别人的会话不受影响
    expect(await store.get(other.token)).toBe('user-2');
  });

  it('revokeAllForUser 在该用户没有会话时不发空参数 DEL', async () => {
    /*
     * `DEL` 不接受零个键（ERR wrong number of arguments）。少了长度判断，
     * 一个从没登录过、或索引已自然过期的用户改口令时会拿到 500 ——
     * 而口令**已经改成功了**（吊销发生在更新哈希之后），
     * 于是用户看到「服务器错误」却发现旧口令不能用了。
     */
    const { store } = makeStore();
    await expect(store.revokeAllForUser('nobody')).resolves.toBeUndefined();
  });

  it('touch 同时续期索引 —— 否则长期活跃的会话会失去索引', async () => {
    /*
     * 索引的 TTL 只在 `create` 时设过一次。会话靠 `touch` 的 EXPIRE 滑动续期，
     * 索引不跟着续的话，第 30 天之后索引先消失，此后 `revokeAllForUser`
     * 找不到这个会话 —— 改口令时它会活下来。
     *
     * 这是一个只在账号连续活跃满 30 天后才出现的安全漏洞，
     * 不可能靠手工测试或本地开发发现，所以在命令层钉死。
     */
    const { store, redis } = makeStore();
    const created = await store.create('user-1');

    await store.touch(created.token, 'user-1');

    expect(redis.countCalls('expire', `session:${hashToken(created.token)}`)).toBe(1);
    expect(redis.countCalls('expire', 'user-sessions:user-1')).toBeGreaterThanOrEqual(2);
  });

  it('单个 revoke 不动索引（残留成员无害，省一次 GET 往返）', async () => {
    const { store, redis } = makeStore();
    const created = await store.create('user-1');

    await store.revoke(created.token);

    expect(await store.get(created.token)).toBeNull();
    // 索引里还留着这个哈希
    expect(redis.sets.get('user-sessions:user-1')?.has(hashToken(created.token))).toBe(true);
    // 而它不妨碍后续吊销：对已经不存在的键 DEL 是空操作
    await expect(store.revokeAllForUser('user-1')).resolves.toBeUndefined();
  });
});
