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

export function createLogger(options: LoggerOptions): Logger {
  const { service, level = process.env['LOG_LEVEL'] ?? 'info', pretty = false } = options;

  const config: pino.LoggerOptions = {
    name: service,
    level,
    // 容器内 TZ=UTC（设计稿 22.3.1），时间戳统一 ISO 8601 UTC
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    base: { service },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
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
