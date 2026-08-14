import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, loadMigrations } from './migrate.js';

/**
 * 迁移加载器的单测。执行器本身需要真实 PostgreSQL，
 * 由 CI 的 L-09（pgvector/pgvector:pg17 上跑全量迁移）覆盖。
 */
describe('loadMigrations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tps-migrations-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, sql: string): Promise<void> {
    await writeFile(path.join(dir, name), sql, 'utf8');
  }

  it('按版本号升序加载', async () => {
    await write('0002_second.sql', 'SELECT 2;');
    await write('0001_first.sql', 'SELECT 1;');

    const migrations = await loadMigrations(dir);

    expect(migrations.map((m) => m.version)).toEqual([1, 2]);
    expect(migrations.map((m) => m.name)).toEqual(['first', 'second']);
  });

  it('忽略非 .sql 文件', async () => {
    await write('0001_first.sql', 'SELECT 1;');
    await write('README.md', '# 说明');

    expect(await loadMigrations(dir)).toHaveLength(1);
  });

  it('文件名不符合规范时报错', async () => {
    await write('1_bad.sql', 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('拒绝大写与连字符命名（Linux 大小写敏感，命名必须确定）', async () => {
    await write('0001_Bad-Name.sql', 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(/不符合规范/);
  });

  it('版本号重复时报错（合并冲突的典型症状）', async () => {
    await write('0001_a.sql', 'SELECT 1;');
    await write('0001_b.sql', 'SELECT 2;');
    await expect(loadMigrations(dir)).rejects.toThrow(/版本号重复/);
  });

  it('允许版本号不连续（便于并行分支各占号段）', async () => {
    await write('0001_a.sql', 'SELECT 1;');
    await write('0005_b.sql', 'SELECT 2;');

    expect((await loadMigrations(dir)).map((m) => m.version)).toEqual([1, 5]);
  });

  it('校验和对 CRLF/LF 差异不敏感（护栏失效时的第二道保险）', async () => {
    await write('0001_lf.sql', 'SELECT 1;\nSELECT 2;\n');
    const lf = (await loadMigrations(dir))[0];

    await rm(path.join(dir, '0001_lf.sql'));
    await write('0001_lf.sql', 'SELECT 1;\r\nSELECT 2;\r\n');
    const crlf = (await loadMigrations(dir))[0];

    expect(lf?.checksum).toBe(crlf?.checksum);
  });

  it('内容变化会改变校验和（漂移检测的基础）', async () => {
    await write('0001_a.sql', 'SELECT 1;');
    const before = (await loadMigrations(dir))[0];

    await write('0001_a.sql', 'SELECT 2;');
    const after = (await loadMigrations(dir))[0];

    expect(before?.checksum).not.toBe(after?.checksum);
  });
});
