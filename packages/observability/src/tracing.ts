import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Trace 辅助（设计稿 21.3）。
 *
 * P0 只依赖 @opentelemetry/api（纯接口，无 SDK）。真正的 SDK 装配、
 * OTLP 导出器与队列跨进程 trace context 透传属于 TP-5-03；在此之前
 * 所有 span 走 no-op 实现，代码里的埋点不会因为 SDK 未装配而报错。
 *
 * 之所以现在就引入 api 而不是等到 P5：埋点分散在各处，事后补要改遍全部
 * 业务代码；而 api 包在无 SDK 时是零开销的 no-op。
 */

const TRACER_NAME = 'travel-poster-system';

export function tracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(TRACER_NAME);
}

/**
 * 在 span 内执行一段异步逻辑，自动记录异常与状态。
 *
 * 注意：不要把个人数据写进 span 属性（设计稿二十章）。span 属性与指标标签
 * 同样面向后端存储，`user_id` 可以（trace 是按请求查询的，不做聚合），
 * 但 `email`、凭据、`raw_text` 一律禁止。
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Readonly<Record<string, string | number | boolean>> = {},
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** 当前 trace id，供结构化日志关联（设计稿 21.3） */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  return ctx.traceId === '00000000000000000000000000000000' ? undefined : ctx.traceId;
}

export { SpanStatusCode, type Span };
