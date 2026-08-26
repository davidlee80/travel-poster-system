import { createCounter } from '@tps/observability';

/**
 * CR 闸门的指标（C-7，21.3 的补充项）。
 *
 * ## 它回答的问题只有一个：有多少人撞在了余额上
 *
 * 而那个问题在 C-6 之前只能靠日志数 402。它是**产品信号**而不是故障信号：
 * 占位价下一次 14 天行程的预留额（10578 CR）就超过注册赠送额（9900 CR）——
 * 也就是说定价配错时的表现不是报错，是「一批用户点了生成什么也没发生」，
 * 而每一次都返回了一个语义完全正确的 402。
 *
 * 用户不会来问「为什么我不能生成」，他会走。因此这条曲线是那件事的
 * 唯一信号。
 *
 * ## 两个标签
 *
 * ```text
 * event    generate | export   —— 两者的价差三个数量级，混在一起看不出是哪边
 * outcome  allowed | insufficient | free
 * ```
 *
 * `free` 是「没有价目表、或算出 0 CR」那条降级路径（见服务端的降级表）。
 * 它必须能被看见：那条路径下**所有生成都不收费**，
 * 而除了这条曲线之外没有任何迹象。
 *
 * 六条序列，基数固定。不带 `user_id`（21.3 的标签白名单在类型层禁止它）。
 */
export const creditGateTotal = createCounter({
  name: 'travel_credit_gate_total',
  help: 'CR 闸门的判定结果（按事件与结果）',
  labelNames: ['event', 'outcome'],
});

export type CreditGateEvent = 'generate' | 'export';
export type CreditGateOutcome = 'allowed' | 'insufficient' | 'free';

/** 记一次闸门判定。包一层是为了让调用点读起来是一句话，且拼错标签值会编译失败 */
export function recordCreditGate(event: CreditGateEvent, outcome: CreditGateOutcome): void {
  creditGateTotal.inc({ event, outcome });
}
