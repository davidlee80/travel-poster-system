import { Pool, type PoolConfig } from 'pg';
import { optionalInt, optionalString, requireString } from '@tps/shared';

/**
 * PostgreSQL 连接池。
 *
 * 数据库口令只从环境变量读取，且不出现在任何日志、指标、错误消息中
 * （设计稿二十章）。连接串同理 —— pg 的错误对象默认不含口令，但我们
 * 自己拼错误消息时必须小心。
 */

export interface DbConfig {
  readonly connectionString: string;
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  /** 检索路径专用的受限只读角色（设计稿 15.2）。P2 才启用。 */
  readonly retrievalConnectionString?: string;
}

export function loadDbConfig(): DbConfig {
  const retrieval = process.env['DATABASE_RETRIEVAL_URL']?.trim();
  return {
    connectionString: requireString('DATABASE_URL'),
    maxConnections: optionalInt('DATABASE_POOL_MAX', 10),
    idleTimeoutMs: optionalInt('DATABASE_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMs: optionalInt('DATABASE_CONNECT_TIMEOUT_MS', 5_000),
    statementTimeoutMs: optionalInt('DATABASE_STATEMENT_TIMEOUT_MS', 15_000),
    ...(retrieval && retrieval.length > 0 ? { retrievalConnectionString: retrieval } : {}),
  };
}

export function createPool(config: DbConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    // 防止单条慢查询占住连接直到 Worker 超时
    statement_timeout: config.statementTimeoutMs,
    application_name: optionalString('SERVICE_NAME', 'travel-poster-system'),
  };
  return new Pool(poolConfig);
}

/** 探针用：验证连接可用且扩展已装载 */
export async function checkDatabase(pool: Pool): Promise<{ ok: boolean; extensions: string[] }> {
  const result = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[]) ORDER BY extname`,
    [['vector', 'pgcrypto', 'citext']],
  );
  const extensions = result.rows.map((r) => r.extname);
  return { ok: extensions.length === 3, extensions };
}
