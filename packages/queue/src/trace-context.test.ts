import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GenerationJobPayloadSchema } from './plan-queue.js';
import {
  captureTraceContext,
  restoreTraceContext,
  traceIdFromCarrier,
  withRestoredTrace,
} from './trace-context.js';

/**
 * 队列 trace context 透传（TP-5-03，设计稿 21.3）。
 *
 * ## 为什么这条测试必须装一个真的 SDK
 *
 * 21.3 的要求是「单请求 trace 覆盖 API → Worker，无断链」，而「无断链」
 * 只有一种验证方式：**读实际产出的 span，比较两侧的 traceId**。
 * 断言「captureTraceContext 返回了一个包含 traceparent 的对象」证明不了
 * 任何事 —— 提取端把它解析错、或者 Worker 侧忘了用它作 parent，
 * 那个断言照样通过，而链路照样断在入队处。
 *
 * 因此这里用 `InMemorySpanExporter` 装一个进程内的 provider，
 * 模拟「api 进程开一个 span 并入队 → worker 进程消费并开自己的 span」，
 * 然后断言两个 span 在同一个 trace 里、且后者的 parent 是前者。
 */

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe('队列 trace context', () => {
  it('api 侧的 span 与 worker 侧的 span 在同一个 trace 里，且父子关系正确', async () => {
    const tracer = trace.getTracer('test');

    // ── api 进程：处理请求 → 入队 ──
    let carrier: Record<string, string> | undefined;
    const apiSpan = tracer.startSpan('POST /travel-plans/generate');
    await context.with(trace.setSpan(context.active(), apiSpan), () => {
      carrier = captureTraceContext();
      return Promise.resolve();
    });
    apiSpan.end();

    expect(carrier).toBeDefined();
    expect(carrier).toHaveProperty('traceparent');

    /*
     * ── worker 进程：消费 ──
     *
     * 这里刻意**先结束 api 的 span**：真实情况下 api 早已返回 201，
     * 而 Worker 可能几秒后才开始消费。父 span 已结束不影响子 span 的归属 ——
     * 如果实现依赖「父 span 还活着」，这条断言会失败。
     */
    const consumed = await withRestoredTrace(carrier, async () => {
      const workerSpan = tracer.startSpan('generate-plan');
      const result = await context.with(trace.setSpan(context.active(), workerSpan), () =>
        Promise.resolve(trace.getActiveSpan()!.spanContext()),
      );
      workerSpan.end();
      return result;
    });

    const spans = exporter.getFinishedSpans();
    const api = spans.find((span) => span.name === 'POST /travel-plans/generate')!;
    const worker = spans.find((span) => span.name === 'generate-plan')!;

    expect(api).toBeDefined();
    expect(worker).toBeDefined();
    // 无断链：同一个 traceId
    expect(worker.spanContext().traceId).toBe(api.spanContext().traceId);
    // 父子关系：worker 的 parent 就是 api 的那个 span
    expect(worker.parentSpanContext?.spanId).toBe(api.spanContext().spanId);
    expect(consumed.traceId).toBe(api.spanContext().traceId);
  });

  it('载荷经过 schema 往返后 trace 仍然接得上', async () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('enqueue');

    const payload = await context.with(trace.setSpan(context.active(), span), () => {
      const traceContext = captureTraceContext();
      return Promise.resolve({
        jobId: 'job-1',
        requestId: 'req-1',
        planId: 'plan-1',
        userId: 'user-1',
        ...(traceContext === undefined ? {} : { traceContext }),
      });
    });
    span.end();

    /*
     * 真实路径上载荷会被 JSON 序列化进 Redis 再被 Zod 解析回来。
     * 少一个 `.passthrough()` 或写错字段名的表现是「traceContext 被静默丢弃」
     * —— 而那不会让任何东西报错。
     */
    const parsed = GenerationJobPayloadSchema.parse(JSON.parse(JSON.stringify(payload)));

    expect(parsed.traceContext).toBeDefined();
    expect(traceIdFromCarrier(parsed.traceContext)).toBe(span.spanContext().traceId);
  });

  it('没有活跃 span 时不产生载荷字段', () => {
    /*
     * 返回 `{}` 会让每条队列消息多一个空对象。BullMQ 的消息在 Redis 里是
     * 逐条 JSON 存储的，几十万条积压时这不是零成本。
     */
    expect(captureTraceContext()).toBeUndefined();
  });

  it('载荷没有 traceContext 时消费照常进行（老消息兼容）', async () => {
    const executed = await withRestoredTrace(undefined, () => Promise.resolve('done'));
    expect(executed).toBe('done');
  });

  it('损坏的 traceparent 不抛错，只是接不上', () => {
    /*
     * 「消息里的链路 ID 坏了」不该让任务失败 —— 那是可观测性的问题，
     * 而用户要的是他的计划。propagator 对非法值静默忽略，这里钉住这个行为。
     */
    const restored = restoreTraceContext({ traceparent: '这不是一个合法的 traceparent' });
    expect(trace.getSpanContext(restored)).toBeUndefined();
    expect(traceIdFromCarrier({ traceparent: 'garbage' })).toBeUndefined();
  });

  it('用的是 W3C propagator（换 propagator 需要显式决定）', () => {
    /*
     * `traceparent` 是 W3C Trace Context 的键名。换成 B3 或 Jaeger 格式时
     * 这条会失败 —— 而那是一次跨服务的契约变更（网关、collector、
     * 以及任何已经在队列里的老消息），应当是显式决定而不是顺手改。
     */
    expect(propagation.fields()).toContain('traceparent');
  });
});
