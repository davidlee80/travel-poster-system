import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * 内部端点的共享密钥认证（14.1、14.2、17.1 的展示数据端点）。
 *
 * 内部端点挂在同一个 Fastify 实例上（V1 只有一个 HTTP 服务），
 * 因此**必须**有认证 —— 否则它们就是公网可达的 CPU 与数据库接口。
 *
 * 用固定密钥而不是 17.1 的渲染令牌：那个令牌绑定
 * `plan_version_id` + `page_key`（防止令牌被挪用到其他页面），
 * 而素材渲染与具体计划无关，硬套会需要编造一个假的版本 ID。
 *
 * 未配置 `INTERNAL_API_KEY` 时**不注册**这些路由（与 auth / travelPlans
 * 同一处理）—— 少一个默认密钥就少一个「忘了改默认值」的事故。
 */

export const INTERNAL_API_KEY_HEADER = 'x-internal-key';

export interface InternalAuthDeps {
  /** 共享密钥。由 `INTERNAL_API_KEY` 注入，缺省则不注册路由 */
  readonly internalApiKey: string;
}

/**
 * 密钥比较用 `timingSafeEqual`。
 *
 * 长度不同直接返回 false，但仍做一次等长比较 —— 不做的话，
 * 「长度对不对」会通过响应时间泄漏，攻击者可以先猜出长度。
 */
export function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function authorizeInternal(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedKey: string,
): boolean {
  const provided = request.headers[INTERNAL_API_KEY_HEADER];
  if (typeof provided !== 'string' || !keyMatches(provided, expectedKey)) {
    /*
     * 404 而不是 401：内部端点的存在性本身不必对外确认。
     * 与 13.0「他人资源返回 404」同一理由。
     */
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '未找到' } });
    return false;
  }
  return true;
}
