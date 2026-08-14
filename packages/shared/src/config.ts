/**
 * 环境配置读取。
 *
 * 原则：
 *   - 所有配置从环境变量读取，无默认值的项缺失即启动失败（fail fast），
 *     不允许"生产环境跑着一个悄悄用了开发默认值的配置"；
 *   - 不引入 dotenv 等运行时依赖，容器由编排层注入环境变量；
 *   - 秘密（数据库口令、签名密钥）只在进程内使用，不进日志、不进指标、不进错误消息。
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function raw(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function requireString(key: string): string {
  const value = raw(key);
  if (value === undefined) {
    throw new ConfigError(`缺少必需的环境变量 ${key}`);
  }
  return value;
}

export function optionalString(key: string, fallback: string): string {
  return raw(key) ?? fallback;
}

export function requireInt(key: string): number {
  return parseIntOrThrow(key, requireString(key));
}

export function optionalInt(key: string, fallback: number): number {
  const value = raw(key);
  return value === undefined ? fallback : parseIntOrThrow(key, value);
}

function parseIntOrThrow(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`环境变量 ${key} 必须是整数，实际为 "${value}"`);
  }
  return parsed;
}

export function optionalBool(key: string, fallback: boolean): boolean {
  const value = raw(key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new ConfigError(`环境变量 ${key} 必须是布尔值（true/false），实际为 "${value}"`);
}

export type NodeEnv = 'development' | 'test' | 'production';

export function nodeEnv(): NodeEnv {
  const value = optionalString('NODE_ENV', 'development');
  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }
  throw new ConfigError(`NODE_ENV 必须是 development/test/production，实际为 "${value}"`);
}

/** 每个服务共用的运行时配置 */
export interface ServiceConfig {
  readonly serviceName: string;
  readonly nodeEnv: NodeEnv;
  readonly logLevel: string;
  readonly port: number;
  /** 必须小于 K8s terminationGracePeriodSeconds（设计稿 22.3.3） */
  readonly shutdownTimeoutMs: number;
}

export function loadServiceConfig(serviceName: string, defaultPort: number): ServiceConfig {
  return {
    serviceName,
    nodeEnv: nodeEnv(),
    logLevel: optionalString('LOG_LEVEL', 'info'),
    port: optionalInt('PORT', defaultPort),
    shutdownTimeoutMs: optionalInt('SHUTDOWN_TIMEOUT_MS', 25_000),
  };
}
