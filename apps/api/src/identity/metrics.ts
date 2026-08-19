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
  help: '身份事件计数（匿名创建、匿名被拒、注册、升级、登录、归并）',
  labelNames: ['event', 'outcome'],
});

export const identityByType = createCounter({
  name: 'travel_identity_by_type_total',
  help: '按身份类型统计的请求数',
  labelNames: ['user_type'],
});

/**
 * `anonymous_rejected`（P7）：一次被拒的匿名请求。
 *
 * 这是关闭匿名入口后**唯一**能看出「还有多少流量在带旧 `tp_anon`」的信号，
 * 而那个数字决定了什么时候可以真正移除匿名代码（那会是另一个迭代，
 * 且需要破坏性迁移）。没有它的话，「存量匿名流量已经归零」只能靠猜。
 *
 * 它与 `anon_created` 是互斥的两个事件：开关打开时只有前者、关闭时只有后者。
 * 因此两者的比值也能在灰度回切时看出开关是否真的生效了。
 */
export type IdentityEvent =
  'anon_created' | 'anonymous_rejected' | 'register' | 'upgrade' | 'login' | 'logout' | 'merge';

export type IdentityOutcome = 'succeeded' | 'rejected' | 'rate_limited' | 'failed';

export function recordIdentityEvent(event: IdentityEvent, outcome: IdentityOutcome): void {
  identityTotal.inc({ event, outcome });
}

export function recordIdentityType(userType: 'ANONYMOUS' | 'REGISTERED'): void {
  identityByType.inc({ user_type: userType });
}
