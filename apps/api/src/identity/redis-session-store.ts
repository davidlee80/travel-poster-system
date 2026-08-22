import { hashToken, issueOpaqueToken } from '@tps/shared';
import type { Redis } from '@tps/queue';

import { SESSION_TTL_SECONDS, type CreatedSession, type SessionStore } from './session-store.js';

/**
 * Redis 会话存储（设计稿 13.0）。
 *
 * P1 用 `InMemorySessionStore` 跑通了身份链路，并在 main.ts 里记下
 * 「Redis 实现在 P2 随队列一起接入」—— 这就是那一步。进程内实现的具体故障是
 * **负载均衡下随机登出**：用户在实例 A 登录，下一个请求落到实例 B，
 * B 的 Map 里没有这个会话，于是当成未登录。表现为「时不时被踢出去」，
 * 而单实例本地开发永远复现不出来。
 *
 * 存的是 token 的**哈希**，与 `users.anon_token_hash` 同一原则：
 * Redis 快照或内存转储泄漏时，拿到的不是可直接使用的凭据。
 */
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = SESSION_TTL_SECONDS,
  ) {}

  private key(hash: string): string {
    return `session:${hash}`;
  }

  /**
   * 反向索引：user_id → 该用户的会话哈希集合。
   *
   * 会话本身是 `hash → user_id` 的单向映射，没有它就无法实现
   * `revokeAllForUser`（Redis 里没有「按值查键」）。
   *
   * **集合里可能有已经自然过期的成员** —— 会话键到期时 Redis 不会通知集合。
   * 这是无害的：吊销时对不存在的键 `DEL` 是空操作。反过来（成员漏了）才有害，
   * 因此 `create` 与 `touch` 都要维护它的 TTL。
   */
  private userKey(userId: string): string {
    return `user-sessions:${userId}`;
  }

  async create(userId: string): Promise<CreatedSession> {
    const token = issueOpaqueToken();
    await this.redis.set(this.key(token.hash), userId, 'EX', this.ttlSeconds);
    await this.redis.sadd(this.userKey(userId), token.hash);
    await this.redis.expire(this.userKey(userId), this.ttlSeconds);
    return { token: token.value, ttlSeconds: this.ttlSeconds };
  }

  async get(token: string): Promise<string | null> {
    return this.redis.get(this.key(hashToken(token)));
  }

  /**
   * 滑动续期。
   *
   * 用 `EXPIRE` 而不是重新 `SET`：`SET` 需要先读出 user_id，两次往返之间
   * 若会话被吊销（另一个标签页登出），`SET` 会把它**复活**。
   * `EXPIRE` 对不存在的键无操作，天然安全。
   */
  async touch(token: string, userId: string): Promise<void> {
    await this.redis.expire(this.key(hashToken(token)), this.ttlSeconds);
    /*
     * 索引跟着一起续期。少了这一行，长期活跃的会话会在第 30 天之后
     * **失去索引**（会话被 EXPIRE 续期、索引没有），此后
     * `revokeAllForUser` 找不到它 —— 改口令时它会活下来。
     * 那是一个只在账号用满 30 天之后才出现的安全漏洞，不可能靠手工测试发现。
     */
    await this.redis.expire(this.userKey(userId), this.ttlSeconds);
  }

  /**
   * 单个会话吊销（登出）。
   *
   * **不从索引里 SREM** —— 那需要先 `GET` 出 user_id，多一次往返，
   * 而残留成员是无害的（见 `userKey` 的说明）。
   */
  async revoke(token: string): Promise<void> {
    await this.redis.del(this.key(hashToken(token)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const hashes = await this.redis.smembers(this.userKey(userId));
    if (hashes.length > 0) {
      await this.redis.del(...hashes.map((hash) => this.key(hash)));
    }
    await this.redis.del(this.userKey(userId));
  }
}
