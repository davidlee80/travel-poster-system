import { context, propagation, trace, type Context } from '@opentelemetry/api';
import { z } from 'zod';

/**
 * 队列消息的 trace context 透传（TP-5-03，设计稿 21.3）。
 *
 * ## 为什么必须显式透传
 *
 * 21.3 写明「队列跨进程时通过消息头透传 trace context，否则链路在入队处断开」。
 * HTTP 的 instrumentation 自动做这件事（`traceparent` 请求头），但队列不是
 * HTTP：BullMQ 的消息是 Redis 里的一个 JSON，ioredis 的 instrumentation
 * 只看到一次 `LPUSH`。
 *
 * 不透传的后果不是「少了一段」，而是**最重要的那一段丢了**：用户等待的大头
 * 全在入队之后（排队 + 生成 + 素材 + 渲染），而 api 侧的 span 只覆盖那几十
 * 毫秒的「收下请求并入队」。排查「为什么这个用户等了两分钟」时，
 * api 的 trace 显示 40 毫秒完成。
 *
 * ## 为什么放在载荷里
 *
 * plan-queue.ts 的原则是「载荷里只放标识符，不放请求体」，三条理由分别是
 * 个人数据副本、内存增长、快照不一致。`traceparent` 不触犯任何一条：
 * 它是 55 字节的随机关联 ID，不含个人数据，也不是任何东西的快照。
 * 而 BullMQ 没有别的通道 —— `job.data` 就是唯一的消息体。
 */

/**
 * W3C Trace Context 的载体。
 *
 * 用 `catchall` 而不是固定 `traceparent` / `tracestate` 两个字段：
 * OTel 的 propagator 是可配置的（B3、Jaeger 格式各有自己的键），
 * 写死两个键会让换 propagator 变成一次契约变更。
 */
export const TraceCarrierSchema = z.record(z.string(), z.string());

export type TraceCarrier = z.infer<typeof TraceCarrierSchema>;

/**
 * 把当前活跃 span 的 context 序列化成载荷字段。
 *
 * 没有活跃 span（未装配 SDK，或不在 span 内）时返回 undefined ——
 * 返回 `{}` 会让每条消息多一个空对象字段，而 BullMQ 的消息在 Redis 里
 * 是逐条 JSON 存储的。
 */
export function captureTraceContext(): TraceCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length === 0 ? undefined : carrier;
}

/**
 * 从载荷字段还原 context，供 Worker 侧作为 span 的 parent。
 *
 * 返回 `ROOT_CONTEXT` 之上的 context —— 不是当前 active context。
 * 用后者会把 Worker 那一侧的 span 挂到「消费循环」这个长生命周期的 span 上，
 * 于是所有任务的 span 串成一条永不结束的链。
 */
export function restoreTraceContext(carrier: TraceCarrier | undefined): Context {
  if (carrier === undefined) return context.active();
  return propagation.extract(context.active(), carrier);
}

/**
 * 在还原出的 context 里执行一段逻辑。
 *
 * 这是 Worker 消费入口的用法：
 * ```ts
 * await withRestoredTrace(payload.traceContext, async () => {
 *   await generatePlan(deps, payload);
 * });
 * ```
 * 之后这段逻辑里产生的每个 span（数据库、Redis、HTTP）都会挂在 api 侧
 * 那次请求的 trace 下，`@tps/shared` 的 logger 也会自动带上同一个 `trace_id`。
 */
export function withRestoredTrace<T>(
  carrier: TraceCarrier | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return context.with(restoreTraceContext(carrier), fn);
}

/** 载荷里的 trace id，供日志与排查用。无有效上下文时返回 undefined */
export function traceIdFromCarrier(carrier: TraceCarrier | undefined): string | undefined {
  if (carrier === undefined) return undefined;
  const extracted = propagation.extract(context.active(), carrier);
  const spanContext = trace.getSpanContext(extracted);
  if (spanContext === undefined) return undefined;
  return spanContext.traceId === '00000000000000000000000000000000'
    ? undefined
    : spanContext.traceId;
}
