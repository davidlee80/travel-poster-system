import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 内部渲染路由的签名令牌（TP-1-07，设计稿 17.1）。
 *
 * ## 为什么不能只靠网络隔离
 *
 * V1.0 只写了「该路由只供内部渲染服务访问」而没有任何机制。仅靠网络隔离
 * 不够：该路由返回的是**用户私有计划内容**，任何内网服务被攻破即可遍历
 * `plan_version_id`。因此采用网络层 + 签名令牌双重保护。
 *
 * ## 令牌形态
 *
 *   payload = plan_version_id | page_key | expires_at | jti
 *   token   = base64url(payload) + "." + base64url(hmac_sha256(key, payload))
 *
 * 有效期 120 秒、一次性（jti 由调用方在 Redis 记录已用）。
 * 校验失败返回 404 而非 403 —— 403 会告诉攻击者「这个版本 ID 存在」。
 */

/** 令牌有效期。渲染在秒级完成，120 秒足够且把重放窗口压到最小。 */
export const RENDER_TOKEN_TTL_SECONDS = 120;

export interface RenderTokenPayload {
  readonly planVersionId: string;
  /** 页面标识：`day:3` 或 `full`。绑定页面防止令牌被挪用到其他页 */
  readonly pageKey: string;
  readonly expiresAtMs: number;
  /** 一次性标识，供调用方做重放检测 */
  readonly jti: string;
}

const SEPARATOR = '|';

function encodePayload(payload: RenderTokenPayload): string {
  // 各字段不允许含分隔符，否则可以通过构造字段值伪造出不同的语义
  for (const [name, value] of [
    ['planVersionId', payload.planVersionId],
    ['pageKey', payload.pageKey],
    ['jti', payload.jti],
  ] as const) {
    if (value.includes(SEPARATOR)) {
      throw new Error(`渲染令牌字段 ${name} 不得包含 "${SEPARATOR}"`);
    }
  }

  return [payload.planVersionId, payload.pageKey, String(payload.expiresAtMs), payload.jti].join(
    SEPARATOR,
  );
}

function sign(payloadText: string, key: string): string {
  return createHmac('sha256', key).update(payloadText, 'utf8').digest('base64url');
}

export function issueRenderToken(
  payload: Omit<RenderTokenPayload, 'expiresAtMs'> & { readonly expiresAtMs?: number },
  key: string,
  now: () => number = () => Date.now(),
): string {
  const full: RenderTokenPayload = {
    ...payload,
    expiresAtMs: payload.expiresAtMs ?? now() + RENDER_TOKEN_TTL_SECONDS * 1000,
  };

  const text = encodePayload(full);
  return `${Buffer.from(text, 'utf8').toString('base64url')}.${sign(text, key)}`;
}

export type RenderTokenVerification =
  | { readonly valid: true; readonly payload: RenderTokenPayload }
  | { readonly valid: false; readonly reason: RenderTokenRejection };

export type RenderTokenRejection =
  'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'PAGE_MISMATCH' | 'VERSION_MISMATCH';

export function verifyRenderToken(
  token: string,
  expected: { readonly planVersionId: string; readonly pageKey: string },
  key: string,
  now: () => number = () => Date.now(),
): RenderTokenVerification {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const encodedPayload = token.slice(0, dot);
  const providedSignature = token.slice(dot + 1);

  let text: string;
  try {
    text = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }

  // 先验签再解析：未经验证的 payload 不应参与任何逻辑判断
  const expectedSignature = sign(text, key);
  if (!safeEqual(providedSignature, expectedSignature)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  const parts = text.split(SEPARATOR);
  if (parts.length !== 4) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const [planVersionId, pageKey, expiresAtText, jti] = parts;
  if (
    planVersionId === undefined ||
    pageKey === undefined ||
    expiresAtText === undefined ||
    jti === undefined
  ) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const expiresAtMs = Number(expiresAtText);
  if (!Number.isFinite(expiresAtMs)) {
    return { valid: false, reason: 'MALFORMED' };
  }
  if (expiresAtMs <= now()) {
    return { valid: false, reason: 'EXPIRED' };
  }

  // 绑定校验：签名有效不等于这个令牌被允许用于当前页面
  if (planVersionId !== expected.planVersionId) {
    return { valid: false, reason: 'VERSION_MISMATCH' };
  }
  if (pageKey !== expected.pageKey) {
    return { valid: false, reason: 'PAGE_MISMATCH' };
  }

  return { valid: true, payload: { planVersionId, pageKey, expiresAtMs, jti } };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** 页面标识构造。与渲染路由的路径一一对应（17.1）。 */
export const RENDER_PAGE_KEYS = {
  day: (dayNumber: number) => `day:${dayNumber}`,
  full: () => 'full',
} as const;
