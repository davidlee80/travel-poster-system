import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createModelPoolsRepository, type ModelPoolsRepository } from './model-pools.js';
import { createPool } from './pool.js';
import { createTierAdminRepository, type TierAdminRepository } from './tier-admin.js';
import { createUsersRepository, type UsersRepository } from './users.js';

/**
 * 分层与池的写侧（集成，迁移 0009）。
 *
 * 这一组断言存在的理由是**写侧与读侧必须对得上**：CLI 写进去的东西，
 * Worker 的 `select` 要能按同样的语义读回来。两侧各自单测都通过而语义
 * 不一致（比如写的时候 kind 大写、读的时候小写）是最容易发生也最难发现的
 * 一类缺陷 —— 表现是「配了池但一直走 env 单模型」。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('分层与池的写侧（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let admin: TierAdminRepository;
  let pools: ModelPoolsRepository;
  let users: UsersRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 6,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    admin = createTierAdminRepository(pool);
    // TTL 0：每次都查库，避免缓存掩盖「写进去读不回来」
    pools = createModelPoolsRepository(pool, { cacheTtlMs: 0 });
    users = createUsersRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tier_model_pools');
    await pool.query('DELETE FROM model_pools');
    await pool.query('DELETE FROM users');
  });

  async function registered(email: string): Promise<string> {
    const row = await users.createRegistered({
      email,
      passwordHash: 'argon2-placeholder',
      displayName: null,
      dailyQuota: 5,
      monthlyQuota: 20,
    });
    return row.id;
  }

  describe('用户等级', () => {
    it('新建用户的等级是 0', async () => {
      await registered('t0@example.com');
      expect(await admin.findUserByEmail('t0@example.com')).toMatchObject({ tierLevel: 0 });
    });

    it('设置后读回新值', async () => {
      await registered('set@example.com');
      const updated = await admin.setTierByEmail('set@example.com', 10);

      expect(updated).toMatchObject({ tierLevel: 10, email: 'set@example.com' });
      expect(await admin.findUserByEmail('set@example.com')).toMatchObject({ tierLevel: 10 });
    });

    it('邮箱不存在时返回 null（CLI 据此给非 0 退出码）', async () => {
      expect(await admin.setTierByEmail('nobody@example.com', 5)).toBeNull();
      expect(await admin.findUserByEmail('nobody@example.com')).toBeNull();
    });

    it('负数被数据库拒（CLI 之外还有一道）', async () => {
      await registered('neg@example.com');
      await expect(admin.setTierByEmail('neg@example.com', -1)).rejects.toThrow();
    });

    it('按档列出只含 ACTIVE 用户', async () => {
      const kept = await registered('active@example.com');
      const gone = await registered('deleted@example.com');
      await admin.setTierByEmail('active@example.com', 10);
      await admin.setTierByEmail('deleted@example.com', 10);
      await pool.query(`UPDATE users SET status = 'DELETED' WHERE id = $1`, [gone]);

      const rows = await admin.listUsersByTier(10, 20);
      expect(rows.map((row) => row.userId)).toEqual([kept]);
    });
  });

  describe('池与映射', () => {
    it('写入的池能被 select 按同样的语义读回来', async () => {
      await admin.upsertPool({ name: 'paid', kind: 'IMAGE', models: ['flux-pro', 'dalle-3'] });
      await admin.upsertMapping({
        kind: 'IMAGE',
        minTierLevel: 10,
        poolName: 'paid',
        maxCandidates: 2,
      });

      const selection = await pools.select('IMAGE', 10);
      expect(selection).toEqual({
        poolName: 'paid',
        models: ['flux-pro', 'dalle-3'],
        maxCandidates: 2,
        minTierLevel: 10,
      });
    });

    it('重复写同名池是覆盖而不是报错（运营会反复调模型列表）', async () => {
      await admin.upsertPool({ name: 'paid', kind: 'LLM', models: ['a'] });
      await admin.upsertPool({ name: 'paid', kind: 'LLM', models: ['b', 'c'], note: '换了' });

      const rows = await admin.listPools();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ models: ['b', 'c'], note: '换了' });
    });

    it('同名池在 LLM 与 IMAGE 下各自独立（复合唯一键）', async () => {
      await admin.upsertPool({ name: 'paid', kind: 'LLM', models: ['gpt-4o'] });
      await admin.upsertPool({ name: 'paid', kind: 'IMAGE', models: ['flux-pro'] });

      expect(await admin.listPools()).toHaveLength(2);
    });

    it('重复写同一档映射是覆盖', async () => {
      await admin.upsertPool({ name: 'a', kind: 'LLM', models: ['m'] });
      await admin.upsertPool({ name: 'b', kind: 'LLM', models: ['n'] });
      await admin.upsertMapping({
        kind: 'LLM',
        minTierLevel: 0,
        poolName: 'a',
        maxCandidates: 1,
      });
      await admin.upsertMapping({
        kind: 'LLM',
        minTierLevel: 0,
        poolName: 'b',
        maxCandidates: null,
      });

      const rows = await admin.listMappings();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ poolName: 'b', maxCandidates: null });
    });

    it('映射指向不存在的池被外键拒（CLI 不必自己查）', async () => {
      await expect(
        admin.upsertMapping({
          kind: 'LLM',
          minTierLevel: 0,
          poolName: 'ghost',
          maxCandidates: 1,
        }),
      ).rejects.toThrow();
    });

    it('空模型数组被 CHECK 拒（空池与无配置必须分开）', async () => {
      await expect(admin.upsertPool({ name: 'empty', kind: 'LLM', models: [] })).rejects.toThrow();
    });

    it('两张表为空时 select 返回 null —— 调用方回落 env', async () => {
      expect(await pools.select('IMAGE', 99)).toBeNull();
      expect(await pools.select('LLM', 0)).toBeNull();
    });
  });
});
