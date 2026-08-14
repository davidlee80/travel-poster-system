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

/** 无论出现在对象树的哪一层都会被剥离的字段（设计稿二十章「日志与遥测的身份字段」） */
const REDACT_PATHS = [
  // 凭据
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.tp_session',
  '*.tp_anon',
  '*.anon_token_hash',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  // 个人可识别信息
  '*.email',
  '*.created_ip',
  '*.createdIp',
  // 体量与敏感度都不适合进日志的整体载荷
  '*.raw_request',
  '*.rawRequest',
  '*.raw_text',
  '*.plan_json',
  '*.planJson',
  '*.normalized_request',
  '*.constraint_report',
];

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
  /** 生产环境为 false；本地开发可开启彩色输出 */
  readonly pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, level = process.env['LOG_LEVEL'] ?? 'info', pretty = false } = options;

  return pino({
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
  });
}

/**
 * 安全审计日志（设计稿二十章）：唯一允许记录 created_ip 的通道。
 * 与业务日志分流，保留 90 天。
 */
export function createAuditLogger(service: string): Logger {
  return pino({
    name: `${service}-audit`,
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // 审计日志保留 IP，但凭据与 email 仍然剥离
      paths: REDACT_PATHS.filter((p) => !p.endsWith('.created_ip') && !p.endsWith('.createdIp')),
      censor: '[REDACTED]',
      remove: false,
    },
    base: { service, channel: 'audit' },
  });
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
