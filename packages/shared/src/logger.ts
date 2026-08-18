import { createRequire } from 'node:module';

import { trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';

/**
 * 结构化日志（设计稿 21.3、二十章）。
 *
 * 硬性约束：
 *   - 每条日志携带 request_id / trace_id / job_id / user_id / user_type / stage（有则带）；
 *   - 禁止记录 raw_request 全文、模型输出全文、素材二进制、会话凭据、email；
 *   - created_ip 只允许进安全审计日志（独立 logger 实例，见 auditLogger）。
 *
 * 禁记字段由 redact 在序列化层强制剥离 —— 依赖调用方自觉迟早会漏。
 */

/** 禁记字段名（设计稿二十章「日志与遥测的身份字段」） */
const FORBIDDEN_KEYS = [
  // 凭据
  'password',
  'password_hash',
  'passwordHash',
  'tp_session',
  'tp_anon',
  'anon_token_hash',
  'authorization',
  'cookie',
  // 个人可识别信息
  'email',
  'created_ip',
  'createdIp',
  // 体量与敏感度都不适合进日志的整体载荷
  'raw_request',
  'rawRequest',
  'raw_text',
  'plan_json',
  'planJson',
  'normalized_request',
  'constraint_report',
  /*
   * L2 脱敏投影（二十章、3.2.4）。它虽然已去掉个人参数，但仍是**别人的**
   * 行程内容，而日志会被导出、被存档、被更多人看到。
   * 检索路径每次命中都会带回最多 5 份投影，落日志等于把它们复制到
   * 一个不受 15.1 保留策略管辖的地方。
   */
  'retrieval_projection',
  'retrievalProjection',
  'projection',
] as const;

/**
 * pino 的 redact 路径。
 *
 * ## 为什么必须同时列出裸键名与带前缀的形式
 *
 * pino 的 `*` **只匹配一层**，`'*.email'` 的含义是「某个顶层键下面的
 * `email`」—— 它**不覆盖顶层的 `email`**。而最自然的调用方式恰恰是顶层：
 * `logger.info({ email, user_id }, '登录失败')`。P0 的清单只写了 `*.email`
 * 这一种形式，因此那种写法的 email 会原样落盘。
 *
 * 因此为每个禁记键生成三层路径：顶层、一层嵌套、两层嵌套。
 * 两层足以覆盖 `req.headers.cookie`（Fastify 的请求序列化）与
 * `{ context: { user: { email } } }` 这类结构。
 */
const REDACT_PATHS = FORBIDDEN_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
  /** 生产环境为 false；本地开发可开启彩色输出 */
  readonly pretty?: boolean;
  /**
   * 输出目标。缺省为 stdout。
   *
   * 存在这个参数的唯一理由是**让脱敏本身可测**：二十章的禁记字段清单只有
   * 在能读到实际输出时才能验证，而「相信 redact 配好了」是这类约束最常见的
   * 失效方式。生产代码不传它。
   */
  readonly destination?: pino.DestinationStream;
}

/**
 * 每条日志自动附加的 trace 关联字段（TP-5-02，21.3）。
 *
 * ## 为什么内置而不是让调用方传
 *
 * 21.3 要求「每条日志携带 trace_id」。让每个服务在建 logger 时自己接上，
 * 等于把这条要求变成一份需要人记得的约定 —— 而漏掉的表现是「那条链路的
 * 日志查不到」，只在出事时才会发现。
 *
 * `@opentelemetry/api` 在没有装配 SDK 时是零开销的 no-op：`getActiveSpan()`
 * 返回 undefined，这个 mixin 返回空对象。因此本地开发与单测不受影响，
 * 而生产一旦装上 SDK（TP-5-03）日志就自动带上关联字段，不用改任何代码。
 *
 * 只带 `trace_id` 与 `span_id`：`request_id` 由 Fastify 的请求级子 logger
 * 提供（见 api 的 buildServer），`job_id` / `user_id` 由 Worker 的
 * `logger.child()` 提供 —— 两者都有明确的作用域，而 trace 是唯一没有
 * 天然宿主的那一个。
 */
function traceMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};

  const context = span.spanContext();
  // 全零 trace id 表示无效上下文（no-op span），带上它只是噪声
  if (context.traceId === '00000000000000000000000000000000') return {};

  return { trace_id: context.traceId, span_id: context.spanId };
}

/**
 * `pino-pretty` 的传输配置，未安装时返回 undefined。
 *
 * ## 为什么要探测而不是直接配上
 *
 * `pretty: true` 是 `NODE_ENV` 未设时的默认（见各服务的入口），而
 * `pino-pretty` 是 devDependency —— 生产镜像用 `--prod` 装依赖，那里没有它。
 * pino 对缺失的 transport target 是**抛错**而不是降级，因此
 * 「在生产容器里手工设一次 NODE_ENV=development 排查问题」会让进程直接崩，
 * 而崩溃信息（`unable to determine transport target`）与日志毫无关联。
 *
 * 实测中这条路径此前从未工作过：`pino-pretty` 在整个仓库里没有被声明，
 * 于是任何不设 `NODE_ENV` 的本机启动都会崩在建 logger 这一步。
 *
 * 降级到 JSON 输出是安全的选择：可读性变差，但日志仍然完整。
 */
function prettyTransport(): { target: string } | undefined {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, level = process.env['LOG_LEVEL'] ?? 'info', pretty = false } = options;

  const config: pino.LoggerOptions = {
    name: service,
    level,
    // 容器内 TZ=UTC（设计稿 22.3.1），时间戳统一 ISO 8601 UTC
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: traceMixin,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    base: { service },
    ...(() => {
      if (!pretty) return {};
      const transport = prettyTransport();
      return transport === undefined ? {} : { transport };
    })(),
  };

  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}

/** 二十章的禁记字段清单。导出供测试穷举，避免「清单与实现各写一份」 */
export const LOG_REDACT_PATHS: readonly string[] = REDACT_PATHS;

/**
 * 安全审计日志（设计稿二十章）：唯一允许记录 created_ip 的通道。
 * 与业务日志分流，保留 90 天。
 */
export function createAuditLogger(service: string, destination?: pino.DestinationStream): Logger {
  const config: pino.LoggerOptions = {
    name: `${service}-audit`,
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    // 审计日志同样要能关联到 trace：安全事件的排查起点往往是一条请求链路
    mixin: traceMixin,
    redact: {
      // 审计日志保留 IP，但凭据与 email 仍然剥离
      paths: REDACT_PATHS.filter((p) => !p.endsWith('created_ip') && !p.endsWith('createdIp')),
      censor: '[REDACTED]',
      remove: false,
    },
    base: { service, channel: 'audit' },
  };

  return destination === undefined ? pino(config) : pino(config, destination);
}

/**
 * 静默 logger，供测试使用。
 *
 * 由本包提供而不是让每个包直接 import pino：logger 的所有权在这里，
 * 让消费方为了测试而各自引入 pino 会把实现细节泄漏成 10 个包的 devDependency，
 * 且 pino 版本升级时要改 10 处。
 */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

export type { Logger };
