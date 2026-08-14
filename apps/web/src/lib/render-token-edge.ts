/**
 * 渲染令牌校验的 Edge 运行时实现（TP-1-07，设计稿 17.1）。
 *
 * ## 为什么存在第二份实现
 *
 * `@tps/shared` 的 `verifyRenderToken` 用 `node:crypto`，而 Next 中间件运行在
 * Edge 运行时，没有 `node:crypto`。因此这里用 Web Crypto 复刻同一套签名格式。
 *
 * **两份实现不一致会表现为「渲染 Worker 签的令牌，中间件不认」** ——
 * 这是最难排查的一类故障：签发与校验各自看起来都对，只有合在一起才错。
 * 因此 `render-token-edge.test.ts` 做交叉验证：用 shared 签、用这里验，
 * 并覆盖篡改、过期、绑定不匹配等全部拒绝路径。
 *
 * 签名格式（必须与 shared 严格一致）：
 *   payload = plan_version_id | page_key | expires_at | jti
 *   token   = base64url(payload) + "." + base64url(hmac_sha256(key, payload))
 */

const SEPARATOR = '|';

export interface RenderTokenExpectation {
  readonly planVersionId: string;
  readonly pageKey: string;
}

export type EdgeVerifyResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: string };

export async function verifyRenderTokenEdge(
  token: string,
  expected: RenderTokenExpectation,
  key: string,
  now: () => number = () => Date.now(),
): Promise<EdgeVerifyResult> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { valid: false, reason: 'MALFORMED' };

  const encodedPayload = token.slice(0, dot);
  const providedSignature = token.slice(dot + 1);

  let text: string;
  try {
    text = new TextDecoder().decode(base64urlToBytes(encodedPayload));
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }

  // 先验签再解析：未经验证的 payload 不参与任何逻辑判断
  const expectedSignature = await hmacBase64url(text, key);
  if (!timingSafeEqualStrings(providedSignature, expectedSignature)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  const parts = text.split(SEPARATOR);
  if (parts.length !== 4) return { valid: false, reason: 'MALFORMED' };

  const [planVersionId, pageKey, expiresAtText] = parts;
  if (planVersionId === undefined || pageKey === undefined || expiresAtText === undefined) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const expiresAtMs = Number(expiresAtText);
  if (!Number.isFinite(expiresAtMs)) return { valid: false, reason: 'MALFORMED' };
  if (expiresAtMs <= now()) return { valid: false, reason: 'EXPIRED' };

  if (planVersionId !== expected.planVersionId) {
    return { valid: false, reason: 'VERSION_MISMATCH' };
  }
  if (pageKey !== expected.pageKey) {
    return { valid: false, reason: 'PAGE_MISMATCH' };
  }

  return { valid: true };
}

async function hmacBase64url(text: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(text));
  return bytesToBase64url(new Uint8Array(signature));
}

function base64urlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '=');
  const binary = atob(padded);

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Edge 运行时无 timingSafeEqual，手工实现常量时间比较 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 从渲染路由路径解析出令牌应绑定的目标（17.1） */
export function parseRenderPath(pathname: string): RenderTokenExpectation | null {
  const dayMatch = /^\/render\/plans\/([^/]+)\/days\/(\d+)\/?$/.exec(pathname);
  if (dayMatch?.[1] !== undefined && dayMatch[2] !== undefined) {
    return {
      planVersionId: decodeURIComponent(dayMatch[1]),
      pageKey: `day:${Number(dayMatch[2])}`,
    };
  }

  const fullMatch = /^\/render\/plans\/([^/]+)\/full\/?$/.exec(pathname);
  if (fullMatch?.[1] !== undefined) {
    return { planVersionId: decodeURIComponent(fullMatch[1]), pageKey: 'full' };
  }

  return null;
}

/** 签名密钥的最小长度。过短的密钥可被暴力破解，等于没有保护。 */
export const MIN_SIGNING_KEY_LENGTH = 32;

export function isUsableSigningKey(key: string | undefined): key is string {
  return key !== undefined && key.length >= MIN_SIGNING_KEY_LENGTH;
}
