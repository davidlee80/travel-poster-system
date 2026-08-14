import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 不透明凭据的签发与校验（TP-1-31，设计稿 3.6.5、13.0）。
 *
 * 两类凭据同构：
 *   tp_anon    匿名身份令牌，30 天固定过期
 *   tp_session 注册用户会话，30 天滑动过期
 *
 * 共同约束：
 *   - 32 字节 CSPRNG 随机值，Base64URL 编码，不含任何可推导信息；
 *   - 服务端只存 SHA-256 哈希，不存原文 —— 数据库泄漏时无法据此冒充；
 *   - 不是 JWT。V1 无跨服务鉴权需求，不透明凭据可即时吊销，
 *     而 JWT 的「无状态」在需要吊销时会变成负担。
 *
 * 为什么用 SHA-256 而不是 Argon2 存令牌哈希：令牌是 32 字节高熵随机值，
 * 不存在字典攻击面，慢哈希只会让每个请求多花几十毫秒。口令则相反 ——
 * 它是低熵人类输入，必须用 Argon2id（见 password.ts）。
 */

/** 32 字节 ≈ 256 位熵，远超暴力猜测的可行范围 */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** 交给客户端的原文，只在签发这一刻存在 */
  readonly value: string;
  /** 落库的哈希 */
  readonly hash: string;
}

export function issueOpaqueToken(): IssuedToken {
  const value = randomBytes(TOKEN_BYTES).toString('base64url');
  return { value, hash: hashToken(value) };
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 定时安全比较。
 *
 * 令牌查找走数据库的唯一索引（等值查询），本函数用于需要在内存中比对的
 * 场合（如渲染令牌的签名校验）。普通 `===` 会因提前返回而泄漏前缀匹配长度。
 */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual 要求等长；长度不同时先做一次等长比较以避免长度侧信道
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Cookie 名称。集中定义避免各处字符串拼写漂移。 */
export const COOKIE_NAMES = {
  anonymous: 'tp_anon',
  session: 'tp_session',
} as const;

export interface CookieAttributes {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

/**
 * Cookie 属性（设计稿 3.6.5）。
 *
 * `SameSite=Lax` 而非 `Strict`：用户从外部链接进入时 `Strict` 不发送 Cookie，
 * 会导致刚生成的计划「打开分享链接看不到」。`Lax` 对 GET 顶级导航发送，
 * 足以防 CSRF（写操作都是 POST）。
 *
 * `secure` 在开发环境（http://localhost）必须为 false，否则浏览器根本不存。
 */
export function cookieAttributes(ttlSeconds: number, secure: boolean): CookieAttributes {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds,
  };
}

export const DAY_SECONDS = 86_400;
