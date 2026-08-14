import { createCounter } from '@tps/observability';

/**
 * 身份链路指标（TP-1-41，设计稿 21.3）。
 *
 * 标签只用 `event` / `outcome` / `user_type` —— 全部是有界小集合。
 * **禁止 user_id**：它是无界的，会打爆 Prometheus（该约束由
 * @tps/observability 的类型系统强制，此处传 user_id 是编译错误）。
 */
export const identityTotal = createCounter({
  name: 'travel_identity_total',
  help: '身份事件计数（匿名创建、注册、升级、登录、归并）',
  labelNames: ['event', 'outcome'],
});

export const identityByType = createCounter({
  name: 'travel_identity_by_type_total',
  help: '按身份类型统计的请求数',
  labelNames: ['user_type'],
});

export type IdentityEvent = 'anon_created' | 'register' | 'upgrade' | 'login' | 'logout' | 'merge';

export type IdentityOutcome = 'succeeded' | 'rejected' | 'rate_limited' | 'failed';

export function recordIdentityEvent(event: IdentityEvent, outcome: IdentityOutcome): void {
  identityTotal.inc({ event, outcome });
}

export function recordIdentityType(userType: 'ANONYMOUS' | 'REGISTERED'): void {
  identityByType.inc({ user_type: userType });
}
