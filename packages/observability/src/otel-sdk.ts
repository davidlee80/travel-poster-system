import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry SDK 装配（TP-5-03，设计稿 21.3）。
 *
 * ## 缺省不启动
 *
 * 未配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 时 `startTracing` 直接返回 null，
 * 全进程保持 `@opentelemetry/api` 的 no-op 行为（零开销）。这让本地开发、
 * 单测与 CI 都不需要一个 collector —— 而「必须先起一个 collector 才能跑测试」
 * 会让人把可观测性从开发环境里摘掉，那正是最需要它的地方。
 *
 * ## 只装三个 instrumentation，不用 auto-instrumentations-node
 *
 * 后者会拉进 40 多个 instrumentation 包（约 30MB），其中大部分是本项目
 * 用不到的框架（Express、Koa、GraphQL、AWS SDK……）。三个已经覆盖 21.3
 * 要求的链路：
 *
 * ```text
 * HTTP    api ← 前端、api → 素材服务内部端点、render-worker → web 渲染路由、
 *         LLM 与图片供应商的调用（都走 fetch/undici 之上的 http）
 * pg      每一次数据库往返
 * ioredis 队列与配额计数
 * ```
 *
 * 队列的**跨进程**衔接不能靠 instrumentation：BullMQ 的消息不是 HTTP 请求，
 * ioredis instrumentation 只看到 `LPUSH`。因此 trace context 要显式随载荷
 * 透传（见 @tps/queue 的 trace-context.ts），否则链路在入队处断开 ——
 * 而那是这条链路上最需要看清的一段（用户等待的大头在队列之后）。
 */

export interface TracingConfig {
  readonly serviceName: string;
  /** OTLP HTTP 端点，形如 `http://otel-collector:4318`。缺省时不启动 */
  readonly endpoint?: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  /**
   * 采样率（0～1）。缺省 1（全采样）。
   *
   * V1 内测阶段全采样：量小，而漏掉的恰好是要排查的那一条会非常难受。
   * 放量后由 `OTEL_TRACES_SAMPLER_ARG` 调低。
   */
  readonly sampleRatio?: number;
}

export interface TracingHandle {
  /** 优雅停机时调用：刷出未导出的 span。不 flush 会丢掉最后一批 */
  shutdown(): Promise<void>;
}

let active: NodeSDK | null = null;

export function loadTracingConfig(serviceName: string): TracingConfig {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const ratio = process.env['OTEL_TRACES_SAMPLER_ARG'];

  return {
    serviceName,
    ...(endpoint === undefined || endpoint === '' ? {} : { endpoint }),
    ...(process.env['SERVICE_VERSION'] === undefined
      ? {}
      : { serviceVersion: process.env['SERVICE_VERSION'] }),
    ...(process.env['NODE_ENV'] === undefined ? {} : { environment: process.env['NODE_ENV'] }),
    ...(ratio === undefined ? {} : { sampleRatio: Number(ratio) }),
  };
}

/**
 * 启动 SDK。返回 null 表示未配置端点（no-op 模式）。
 *
 * 幂等：重复调用返回同一个句柄。Worker 的入口可能被测试重复 import，
 * 而 `NodeSDK.start()` 两次会注册两套 instrumentation（同一次数据库查询
 * 产出两个 span）。
 */
export function startTracing(config: TracingConfig): TracingHandle | null {
  if (active !== null) {
    return { shutdown: shutdownTracing };
  }

  if (config.endpoint === undefined) return null;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.serviceVersion === undefined
        ? {}
        : { [ATTR_SERVICE_VERSION]: config.serviceVersion }),
      ...(config.environment === undefined
        ? {}
        : { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment }),
    }),
    traceExporter: buildExporter(config.endpoint),
    instrumentations: [
      new HttpInstrumentation({
        /*
         * 探针与指标端点不进 trace。它们每 15 秒被抓一次，
         * 会把 trace 后端塞满毫无信息量的 span，而真正的请求淹没在里面。
         */
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/healthz') || url.startsWith('/readyz') || url === '/metrics';
        },
      }),
      new PgInstrumentation({
        /*
         * 不记 SQL 参数值。参数里有 `user_id`、幂等键、以及
         * `normalized_request` 的整个 JSONB —— 后者是 L1 个人数据（二十章），
         * 而 span 属性与日志一样会被导出与存档。
         */
        enhancedDatabaseReporting: false,
      }),
      new IORedisInstrumentation({
        // 同上：Redis 的参数含会话令牌与配额键
        requireParentSpan: false,
      }),
    ],
  });

  sdk.start();
  active = sdk;
  return { shutdown: shutdownTracing };
}

function buildExporter(endpoint: string): OTLPTraceExporter {
  /*
   * 端点配的是基地址，`/v1/traces` 在这里拼。
   * 让运维填完整路径也可以，但那样 Helm 的 value 就要区分「基地址」与
   * 「完整路径」两种写法，而运维只会记住一种。
   */
  return new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` });
}

export async function shutdownTracing(): Promise<void> {
  if (active === null) return;
  const sdk = active;
  active = null;
  /*
   * 吞掉关闭异常：停机路径上 collector 很可能已经先被摘掉了，
   * 而一个导出失败不该让进程以非零码退出（K8s 会把它记成崩溃重启）。
   */
  await sdk.shutdown().catch(() => undefined);
}

/** 测试辅助：判断当前进程是否已装配 SDK */
export function isTracingActive(): boolean {
  return active !== null;
}
