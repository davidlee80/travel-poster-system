import { hashToken, issueOpaqueToken } from '@tps/shared';

/**
 * 会话存储（设计稿 13.0）。
 *
 * 会话是**不透明 ID → user_id** 的映射，30 天滑动过期。存 Redis 而不落表：
 * 它是可重建的运行期状态，不是系统真相（丢失只需用户重新登录）。
 * 相比之下 `anon_token_hash` 落表是因为它同时是**身份标识**而非纯会话 ——
 * 丢了就找不回那个匿名用户的数据了。
 *
 * 不用 JWT：V1 无跨服务鉴权需求，而不透明会话可即时吊销。
 */

export interface CreatedSession {
  /** 交给客户端的原文 */
  readonly token: string;
  readonly ttlSeconds: number;
}

export interface SessionStore {
  create(userId: string): Promise<CreatedSession>;
  /** 返回 user_id，无效或过期返回 null */
  get(token: string): Promise<string | null>;
  /**
   * 滑动续期。
   *
   * `userId` 由调用方传入而不是现查 —— 调用方刚从 `get()` 拿到它（见
   * `IdentityService.resolve` 分支 1），而 Redis 实现需要它把
   * `revokeAllForUser` 的反向索引一起续期。索引先于会话过期的后果是那些
   * 会话再也吊销不掉：改口令时它们会活下来，而改口令的全部意义就是
   * 让别人手上那个会话失效。
   */
  touch(token: string, userId: string): Promise<void>;
  revoke(token: string): Promise<void>;
  /**
   * 吊销该用户的**全部**会话（改口令）。
   *
   * 不做这件事等于改口令无效：用户改口令通常正是因为怀疑口令外泄，
   * 而对方手上那个会话不受口令影响 —— 30 天滑动过期意味着只要他还在用，
   * 就永远不过期。调用方在此之后应重新 `create()` 一个，
   * 让当前这台设备留在登录态。
   */
  revokeAllForUser(userId: string): Promise<void>;
}

export const SESSION_TTL_SECONDS = 30 * 86_400;

/**
 * 进程内实现。用于单测与单实例本地开发；**不可用于多实例生产**
 * （每个实例各持一份会话，负载均衡会导致随机登出）。
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlSeconds: number = SESSION_TTL_SECONDS,
  ) {}

  async create(userId: string): Promise<CreatedSession> {
    const token = issueOpaqueToken();
    this.sessions.set(token.hash, {
      userId,
      expiresAt: this.now() + this.ttlSeconds * 1000,
    });
    return Promise.resolve({ token: token.value, ttlSeconds: this.ttlSeconds });
  }

  async get(token: string): Promise<string | null> {
    const entry = this.read(token);
    return Promise.resolve(entry?.userId ?? null);
  }

  /** `_userId` 只有 Redis 实现需要（续期反向索引），进程内实现自己就有归属 */
  async touch(token: string, _userId: string): Promise<void> {
    const hash = hashToken(token);
    const entry = this.read(token);
    if (entry) {
      this.sessions.set(hash, {
        userId: entry.userId,
        expiresAt: this.now() + this.ttlSeconds * 1000,
      });
    }
    return Promise.resolve();
  }

  async revoke(token: string): Promise<void> {
    this.sessions.delete(hashToken(token));
    return Promise.resolve();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    // 遍历中删除 Map 的键是安全的（迭代器按插入序推进，删掉的键不会被再访问）
    for (const [hash, entry] of this.sessions) {
      if (entry.userId === userId) this.sessions.delete(hash);
    }
    return Promise.resolve();
  }

  private read(token: string): { userId: string; expiresAt: number } | undefined {
    const hash = hashToken(token);
    const entry = this.sessions.get(hash);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(hash);
      return undefined;
    }
    return entry;
  }
}
