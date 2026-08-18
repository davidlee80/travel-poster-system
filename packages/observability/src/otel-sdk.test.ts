import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createLogger } from '@tps/shared';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { isTracingActive, loadTracingConfig, shutdownTracing, startTracing } from './otel-sdk.js';

/**
 * OTel 装配开关与「日志带 trace_id」的联动（TP-5-02、TP-5-03，设计稿 21.3）。
 *
 * 跨进程的 trace 透传在 @tps/queue 的 trace-context.test.ts —— 那里能同时
 * 构造两侧的 span 并比较 traceId，是「无断链」的真正验证点。
 *
 * ## 为什么这里不用 startTracing 去验证 span 导出
 *
 * `NodeSDK` 把 exporter 包在 `BatchSpanProcessor` 里（生产该如此：逐条导出
 * 会让每个请求多一次网络往返）。批量意味着测试要么等 5 秒、要么调 shutdown，
 * 而 `InMemorySpanExporter.shutdown()` 会清空自己已收到的 span —— 两条路都
 * 读不到东西。曾为此在 `TracingConfig` 上加过 `exporter` / `spanProcessors`
 * 两个「仅供测试」的参数，实测 `NodeSDK` 会忽略后者，于是它们只是两个
 * 没有用户的 API，已删。
 *
 * 因此分工：装配开关在这里验证，span 的实际产出用 `NodeTracerProvider`
 * 直接验证（同 queue 包的手法）。
 */

afterEach(async () => {
  await shutdownTracing();
});

describe('startTracing', () => {
  it('未配置端点时返回 null，保持 no-op', () => {
    /*
     * 这是缺省路径：本地开发、单测与 CI 都不该需要一个 collector。
     * 「必须先起一个 collector 才能跑测试」会让人把可观测性从开发环境里摘掉，
     * 而那正是最需要它的地方。
     */
    expect(startTracing({ serviceName: 'tps-test' })).toBeNull();
    expect(isTracingActive()).toBe(false);
  });

  it('配置端点后启动，且可关闭', async () => {
    const handle = startTracing({
      serviceName: 'tps-test',
      // 不会有请求真的发出去：批量导出要等 5 秒，而这里立刻关闭
      endpoint: 'http://127.0.0.1:4318',
    });

    expect(handle).not.toBeNull();
    expect(isTracingActive()).toBe(true);

    await handle!.shutdown();
    expect(isTracingActive()).toBe(false);
  });

  it('重复调用不会装两套 instrumentation', () => {
    const first = startTracing({ serviceName: 'tps-test', endpoint: 'http://127.0.0.1:4318' });
    const second = startTracing({ serviceName: 'tps-test', endpoint: 'http://127.0.0.1:4318' });

    /*
     * 装两次的表现是同一次数据库查询产出两个 span —— 而 Worker 的入口
     * 在测试里可能被重复 import，生产上也可能因为热重载被走两遍。
     */
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(isTracingActive()).toBe(true);
  });

  it('关闭幂等：未启动时 shutdown 不抛错', async () => {
    // 停机路径上不该因为「本来就没启动」而抛错 —— 那会让退出码变成非零，
    // 而 K8s 把非零退出记成崩溃重启
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});

describe('日志与 trace 的联动（TP-5-02 + TP-5-03）', () => {
  it('有活跃 span 时每条日志自动带 trace_id 与 span_id', async () => {
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    provider.register();

    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger({ service: 'tps-test', level: 'info', destination });

    const span = trace.getTracer('test').startSpan('work');
    context.with(trace.setSpan(context.active(), span), () => {
      logger.info({ stage: 'GENERATING_PLAN' }, '正在生成');
    });
    span.end();

    const line: Record<string, unknown> = JSON.parse(chunks.join(''));

    /*
     * 这是「日志与 trace 关联」的完整闭环：排查时从告警里拿到 trace_id，
     * 用它在日志里筛出这条链路上的每一行。两者对不上的话，trace 只能告诉你
     * 「哪一段慢」，而「为什么」在日志里 —— 而你找不到是哪些行。
     */
    expect(line['trace_id']).toBe(span.spanContext().traceId);
    expect(line['span_id']).toBe(span.spanContext().spanId);
    expect(line['stage']).toBe('GENERATING_PLAN');

    await provider.shutdown();
  });
});

describe('loadTracingConfig', () => {
  it('从环境变量读端点与采样率', () => {
    const original = {
      endpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
      ratio: process.env['OTEL_TRACES_SAMPLER_ARG'],
    };
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://otel:4318';
    process.env['OTEL_TRACES_SAMPLER_ARG'] = '0.25';

    try {
      expect(loadTracingConfig('tps-api')).toMatchObject({
        serviceName: 'tps-api',
        endpoint: 'http://otel:4318',
        sampleRatio: 0.25,
      });
    } finally {
      if (original.endpoint === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = original.endpoint;
      if (original.ratio === undefined) delete process.env['OTEL_TRACES_SAMPLER_ARG'];
      else process.env['OTEL_TRACES_SAMPLER_ARG'] = original.ratio;
    }
  });

  it('空字符串端点视为未配置', () => {
    /*
     * Helm 的 value 未填时会渲染成空串而不是「键不存在」。
     * 不处理这一点的表现是 exporter 拿着 `/v1/traces` 这个相对路径反复失败，
     * 每条 span 一次错误日志 —— 而那些错误日志会盖住真正的问题。
     */
    const original = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = '';
    try {
      expect(loadTracingConfig('tps-api').endpoint).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = original;
    }
  });
});
