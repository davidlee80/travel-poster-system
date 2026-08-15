import { COOKIE_NAMES, cookieAttributes } from '@tps/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { buildErrorBody, errorDefinition, type ErrorCode } from '../errors/codes.js';
import { recordIdentityEvent, recordIdentityType } from '../identity/metrics.js';
import type { CookieMutation, Identity, IdentityService } from '../identity/service.js';

/**
 * 13.0 的身份解析，供所有业务端点复用。
 *
 * ## 为什么抽出来
 *
 * 13.0 的解析顺序有四个分支（会话优先、匿名兜底、都无、都有触发归并），
 * 每个业务端点重写一遍必然出现差异 —— 而差异出在鉴权路径上。
 * 尤其是第 4 条（两种凭据都有效时触发匿名归并）：漏掉它的表现是
 * 用户登录后历史计划时有时无，取决于他访问了哪个端点。
 */

export interface IdentityContextDeps {
  readonly identity: IdentityService;
  readonly secureCookies: boolean;
}

export interface ResolvedContext {
  readonly identity: Identity;
}

/** 解析 Cookie 头。不引入 @fastify/cookie：只需读两个固定名字 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header.length === 0) return {};

  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function applyCookies(
  reply: FastifyReply,
  mutations: readonly CookieMutation[],
  secure: boolean,
): void {
  for (const mutation of mutations) {
    const attrs = cookieAttributes(mutation.maxAgeSeconds, secure);
    const segments = [
      `${mutation.name}=${mutation.value === null ? '' : encodeURIComponent(mutation.value)}`,
      `Path=${attrs.path}`,
      `Max-Age=${mutation.value === null ? 0 : attrs.maxAge}`,
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (attrs.secure) segments.push('Secure');
    if (mutation.value === null) segments.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');

    // 一次响应可能设置多个 Cookie，必须追加而非覆盖
    const existing = reply.getHeader('set-cookie');
    const next = segments.join('; ');
    if (existing === undefined) {
      reply.header('set-cookie', next);
    } else if (Array.isArray(existing)) {
      reply.header('set-cookie', [...existing, next]);
    } else {
      reply.header('set-cookie', [String(existing), next]);
    }
  }
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  retryAfterSeconds?: number | null,
): void {
  const definition = errorDefinition(code);
  if (retryAfterSeconds != null) reply.header('retry-after', String(retryAfterSeconds));
  void reply.code(definition.httpStatus).send(
    buildErrorBody(code, {
      requestId: request.id,
      traceId: 'unavailable',
    }),
  );
}

/**
 * 解析身份；失败时**已经写好响应**并返回 `null`。
 *
 * 返回 `null` 而不是抛错：Fastify 的错误处理器会把抛出的异常统一成 500，
 * 而这里需要的是 401/429 与特定错误码。调用方的写法固定为
 * `if (resolved === null) return reply;`。
 */
export async function resolveIdentity(
  deps: IdentityContextDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { readonly allowAnonymousCreation: boolean },
): Promise<ResolvedContext | null> {
  const cookies = parseCookies(request.headers.cookie);

  const result = await deps.identity.resolve({
    anonCookie: cookies[COOKIE_NAMES.anonymous],
    sessionCookie: cookies[COOKIE_NAMES.session],
    ip: request.ip.length > 0 ? request.ip : null,
    allowAnonymousCreation: options.allowAnonymousCreation,
  });

  if (result.outcome === 'anon_creation_rate_limited') {
    recordIdentityEvent('anon_created', 'rate_limited');
    sendError(request, reply, 'AUTH_ANON_CREATION_RATE_LIMITED', result.retryAfterSeconds);
    return null;
  }
  if (result.outcome === 'identity_required') {
    sendError(request, reply, 'AUTH_IDENTITY_REQUIRED');
    return null;
  }

  applyCookies(reply, result.cookies, deps.secureCookies);

  /*
   * 13.0 第 4 条：两种凭据同时有效时以 tp_session 为准，并触发匿名归并。
   *
   * 归并失败**不阻断本次请求**：它是补偿性操作，`tp_anon` 不清除，
   * 下次带着两种凭据的请求会重试。让归并失败导致 500，会把「历史计划
   * 晚几秒才出现」变成「登录后什么都打不开」。
   */
  if (result.pendingMerge !== null) {
    try {
      await deps.identity.completePendingMerge(
        result.pendingMerge.anonymousUserId,
        result.identity.userId,
      );
      recordIdentityEvent('merge', 'succeeded');
    } catch {
      recordIdentityEvent('merge', 'failed');
      request.log.warn({ stage: 'identity_merge' }, '匿名归并失败，将在下次请求重试');
    }
  }

  recordIdentityType(result.identity.userType);
  return { identity: result.identity };
}
