#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, loadDbConfig } from './pool.js';
import { MigrationError, migrate, status } from './migrate.js';

/**
 * 迁移 CLI（TP-0-03）。
 *
 * 用 Node 而不是 PowerShell 实现（设计稿 22.3.3）：任务入口必须能在
 * Linux 容器内直接执行，而生产容器里没有 pwsh。
 *
 *   pnpm db:migrate     应用全部待执行迁移
 *   pnpm db:status      显示已应用 / 待应用 / 漂移
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/cli.js → 仓库根 → infrastructure/migrations */
const DEFAULT_MIGRATIONS_DIR = path.resolve(here, '..', '..', '..', 'infrastructure', 'migrations');

function migrationsDir(): string {
  const override = process.env['MIGRATIONS_DIR']?.trim();
  return override && override.length > 0 ? path.resolve(override) : DEFAULT_MIGRATIONS_DIR;
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function runMigrate(): Promise<number> {
  const dir = migrationsDir();
  print(`迁移目录: ${dir}`);

  const pool = createPool(loadDbConfig());
  try {
    const result = await migrate(pool, dir, print);
    if (result.alreadyUpToDate) return 0;
    print(`已应用 ${result.applied.length} 个迁移。`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function runStatus(): Promise<number> {
  const dir = migrationsDir();
  const pool = createPool(loadDbConfig());
  try {
    const result = await status(pool, dir);

    print(`迁移目录: ${dir}`);
    print(`已应用: ${result.applied.length}`);
    for (const a of result.applied) {
      print(
        `  ${String(a.version).padStart(4, '0')}_${a.name}  ${a.appliedAt.toISOString()}  ${a.durationMs} ms`,
      );
    }

    print(`待应用: ${result.pending.length}`);
    for (const p of result.pending) {
      print(`  ${p.filename}`);
    }

    if (result.drifted.length > 0) {
      print(`\n校验和漂移（已应用的文件被修改）: ${result.drifted.length}`);
      for (const d of result.drifted) {
        print(`  ${d.name}`);
      }
      print('迁移是不可变的历史记录。请新增前向迁移，不要修改已应用的文件。');
      return 1;
    }

    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const command = process.argv[2];

  switch (command) {
    case 'migrate':
      return runMigrate();
    case 'status':
      return runStatus();
    case undefined:
    default:
      process.stderr.write(
        `未知命令: ${command ?? '(空)'}\n用法: tps-db <migrate|status>\n` +
          `环境变量: DATABASE_URL（必需）、MIGRATIONS_DIR（可选）\n`,
      );
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof MigrationError) {
      process.stderr.write(`\n迁移失败:\n${err.message}\n`);
    } else {
      process.stderr.write(`\n未预期错误: ${err instanceof Error ? err.stack : String(err)}\n`);
    }
    process.exitCode = 1;
  });
