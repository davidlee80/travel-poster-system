import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * 前向单向迁移执行器（TP-0-03，设计稿 15.3、22.3.4 L-09）。
 *
 * 设计取舍：
 *   - **只前向，不写 down**。破坏性变更走 expand-backfill-contract 三步
 *     （新增列 → 回填 → 收缩），每步都是独立的前向迁移。回滚靠部署上一版
 *     应用代码，不靠反向 SQL —— 反向 SQL 在有数据的生产库上几乎总是错的。
 *   - **校验和绑定**。已应用的迁移文件若被修改，执行时报错而不是静默跳过。
 *     文件被改说明「已应用的历史」与「仓库里的历史」不一致，必须人工介入。
 *   - **每个迁移一个事务**。PostgreSQL 的 DDL 是事务性的，失败即整体回滚，
 *     不会留下半应用状态。
 *   - **咨询锁**。多个实例同时启动时（K8s 滚动更新）只有一个执行迁移。
 */

/** 任意常量，作为本仓库迁移的全局咨询锁标识 */
const ADVISORY_LOCK_KEY = 8_142_337_001;

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

export interface MigrationStatus {
  readonly applied: AppliedMigration[];
  readonly pending: Migration[];
  readonly drifted: { version: number; name: string }[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function checksum(sql: string): string {
  // 归一化换行后再哈希：Windows 检出的 CRLF 不应导致校验和漂移
  // （.gitattributes 已强制 LF，这里是第二道保险，见设计稿 22.3.3）
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const migrations: Migration[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;

    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new MigrationError(
        `迁移文件名不符合规范: "${entry.name}"。要求 NNNN_snake_case_name.sql（四位数字版本号）。`,
      );
    }

    const versionText = match[1];
    const name = match[2];
    if (versionText === undefined || name === undefined) {
      throw new MigrationError(`无法解析迁移文件名: "${entry.name}"`);
    }

    const sql = await readFile(path.join(dir, entry.name), 'utf8');
    migrations.push({
      version: Number(versionText),
      name,
      filename: entry.name,
      sql,
      checksum: checksum(sql),
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  // 版本号必须唯一；允许不连续（便于并行分支各占一段号），但重复一定是合并冲突
  const seen = new Map<number, string>();
  for (const m of migrations) {
    const existing = seen.get(m.version);
    if (existing !== undefined) {
      throw new MigrationError(
        `迁移版本号重复: ${m.version} 同时出现在 "${existing}" 与 "${m.filename}"。合并时请重新编号。`,
      );
    }
    seen.set(m.version, m.filename);
  }

  return migrations;
}

async function ensureRegistry(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version      INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      checksum     CHAR(64) NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms  INTEGER NOT NULL
    )
  `);
}

async function readApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
  }>(
    `SELECT version, name, checksum, applied_at, duration_ms FROM schema_migration ORDER BY version`,
  );

  return result.rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
    durationMs: r.duration_ms,
  }));
}

export async function status(pool: Pool, dir: string): Promise<MigrationStatus> {
  const all = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureRegistry(client);
    const applied = await readApplied(client);
    const appliedByVersion = new Map(applied.map((a) => [a.version, a]));

    const pending: Migration[] = [];
    const drifted: { version: number; name: string }[] = [];

    for (const m of all) {
      const found = appliedByVersion.get(m.version);
      if (!found) {
        pending.push(m);
      } else if (found.checksum !== m.checksum) {
        drifted.push({ version: m.version, name: m.filename });
      }
    }

    return { applied, pending, drifted };
  } finally {
    client.release();
  }
}

export interface MigrateResult {
  readonly applied: { version: number; name: string; durationMs: number }[];
  readonly alreadyUpToDate: boolean;
}

export async function migrate(
  pool: Pool,
  dir: string,
  log: (message: string) => void = () => {},
): Promise<MigrateResult> {
  const all = await loadMigrations(dir);
  const client = await pool.connect();

  try {
    // 咨询锁：并发实例只有一个执行迁移，其余等待。锁随会话结束自动释放。
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await ensureRegistry(client);
    const applied = await readApplied(client);
    const appliedByVersion = new Map(applied.map((a) => [a.version, a]));

    // 漂移检测必须在应用任何新迁移之前完成 —— 历史不一致时不能继续往前走
    for (const m of all) {
      const found = appliedByVersion.get(m.version);
      if (found && found.checksum !== m.checksum) {
        throw new MigrationError(
          `迁移 ${m.filename} 的内容已变更，但该版本已于 ${found.appliedAt.toISOString()} 应用。\n` +
            `迁移是不可变的历史记录。如需修正，请新增一个前向迁移，不要修改已应用的文件。`,
        );
      }
    }

    const pending = all.filter((m) => !appliedByVersion.has(m.version));
    if (pending.length === 0) {
      log('数据库已是最新版本，无待应用迁移。');
      return { applied: [], alreadyUpToDate: true };
    }

    const results: { version: number; name: string; durationMs: number }[] = [];

    for (const m of pending) {
      const startedAt = process.hrtime.bigint();
      log(`应用 ${m.filename} ...`);

      // 每个迁移独立事务：PostgreSQL DDL 是事务性的，失败整体回滚
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
        await client.query(
          `INSERT INTO schema_migration (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [m.version, m.name, m.checksum, durationMs],
        );
        await client.query('COMMIT');

        log(`  完成（${durationMs} ms）`);
        results.push({ version: m.version, name: m.filename, durationMs });
      } catch (err) {
        await client.query('ROLLBACK');
        throw new MigrationError(
          `迁移 ${m.filename} 执行失败并已回滚: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { applied: results, alreadyUpToDate: false };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
