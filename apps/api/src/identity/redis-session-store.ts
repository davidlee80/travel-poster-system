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

  async create(userId: string): Promise<CreatedSession> {
    const token = issueOpaqueToken();
    await this.redis.set(this.key(token.hash), userId, 'EX', this.ttlSeconds);
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
  async touch(token: string): Promise<void> {
    await this.redis.expire(this.key(hashToken(token)), this.ttlSeconds);
  }

  async revoke(token: string): Promise<void> {
    await this.redis.del(this.key(hashToken(token)));
  }
}
