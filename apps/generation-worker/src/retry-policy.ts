import { DOMAIN_ERRORS, type ErrorDefinition } from '@tps/schemas';

/**
 * 13.7 重试策略的第四层「不可重试」（TP-4-11）。
 *
 * 13.7 的四层：
 * ```text
 * 客户端       仅对 retryable: true 重试；指数退避基数 2 秒，上限 3 次
 * Worker 内部  LLM / AI 图片 / 上传：指数退避 + 抖动，基数 1 秒，最多 3 次
 * 队列级       attempts: 3、exponential delay 5000，耗尽进 dlq:*
 * 不可重试     PLAN_HARD_CONSTRAINT_UNSATISFIABLE 与全部 REQ_* 立即失败，
 *              **不占用队列重试次数**
 * ```
 *
 * ## 为什么第四层必须由代码强制
 *
 * 「不占用队列重试次数」不是优化，而是正确性：`PLAN_HARD_CONSTRAINT_UNSATISFIABLE`
 * 的含义是「用户勾的 MUST 条件互相矛盾」（V-30/V-31）。重试三次只会得到
 * 三次同样的结论，而每一次都要跑完整的模型生成 —— 用户等三倍的时间，
 * 我们付三倍的钱，结论一字不变。
 *
 * 判定依据是 13.7 的 `retryable` 字段本身，不是另写一张表：
 * 两张表会漂移，而漂移的表现是某个码在 HTTP 层标着不可重试、
 * 在队列层却重试了三次。
 */

/** BullMQ 的重试判定：true 表示这次失败不该消耗 `attempts` */
export function isUnrecoverable(errorCode: string): boolean {
  const definition = (DOMAIN_ERRORS as Record<string, ErrorDefinition | undefined>)[errorCode];
  /*
   * 未登记的码按**可重试**处理 —— 与 `isBlocking` 的默认值相反，而两者
   * 各有道理：`isBlocking` 的保守方向是「宁可明确失败」，这里的保守方向是
   * 「宁可多试一次」。把未知错误判成不可重试，会让一次我们没预料到的瞬时
   * 故障直接变成用户可见的永久失败。
   */
  return definition?.retryable === false;
}
