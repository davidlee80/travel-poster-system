import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createModelPoolsRepository, type ModelPoolsRepository } from './model-pools.js';
import { createPool } from './pool.js';
import { createUsersRepository } from './users.js';

/**
 * 模型候选池（迁移 0009，需真实 PostgreSQL）。
 *
 * 这里验证的都是**只有真实数据库能保证**的东西：区间匹配的 SQL、
 * 复合外键（映射不能指向别的 kind 的池）、非空数组 CHECK、
 * 以及两张表为空时的回落。假仓储只会重复我对这些约束的理解。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('模型候选池（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repo: ModelPoolsRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
    });
    await migrate(pool, migrationsDirectory());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // 映射先删：它对池有外键
    await pool.query('DELETE FROM tier_model_pools');
    await pool.query('DELETE FROM model_pools');
    // TTL 给 0，让每个用例都真的查库（缓存本身单独测）
    repo = createModelPoolsRepository(pool, { cacheTtlMs: 0 });
  });

  async function addPool(name: string, kind: 'LLM' | 'IMAGE', models: readonly string[]) {
    await pool.query(
      'INSERT INTO model_pools (pool_id, name, kind, models) VALUES ($1, $2, $3, $4::jsonb)',
      [randomUUID(), name, kind, JSON.stringify(models)],
    );
  }

  async function addMapping(
    kind: 'LLM' | 'IMAGE',
    minTierLevel: number,
    poolName: string,
    maxCandidates: number | null,
  ) {
    await pool.query(
      `INSERT INTO tier_model_pools (kind, min_tier_level, pool_name, max_candidates)
       VALUES ($1, $2, $3, $4)`,
      [kind, minTierLevel, poolName, maxCandidates],
    );
  }

  it('两张表为空时返回 null（调用方据此回落 env 单模型）', async () => {
    /*
     * 这一条是整个特性「渐进启用」的基础：迁移完不配置任何池，
     * 系统行为与迁移前完全一致。
     */
    expect(await repo.select('LLM', 0)).toBeNull();
    expect(await repo.select('IMAGE', 99)).toBeNull();
  });

  it('区间匹配：取 min_tier_level ≤ 用户等级 中最大的那条', async () => {
    await addPool('free', 'LLM', ['mini']);
    await addPool('mixed', 'LLM', ['mini', 'pro']);
    await addPool('paid', 'LLM', ['pro', 'opus']);
    await addMapping('LLM', 0, 'free', 3);
    await addMapping('LLM', 10, 'mixed', 3);
    await addMapping('LLM', 20, 'paid', null);

    expect((await repo.select('LLM', 0))?.poolName).toBe('free');
    expect((await repo.select('LLM', 9))?.poolName).toBe('free');
    expect((await repo.select('LLM', 10))?.poolName).toBe('mixed');
    expect((await repo.select('LLM', 20))?.poolName).toBe('paid');

    /*
     * 关键：运营新建 tier_level = 15 的用户时**不需要**加映射，
     * 它自动落到 10 那一档。这正是选整数等级而非枚举的收益。
     */
    const between = await repo.select('LLM', 15);
    expect(between?.poolName).toBe('mixed');
    expect(between?.minTierLevel).toBe(10);

    // 高于所有档位的等级落到最高那一档，而不是没有配置
    expect((await repo.select('LLM', 999))?.poolName).toBe('paid');
  });

  it('低于最低档位时返回 null，而不是落到最低档', async () => {
    /*
     * 最低映射是 10 时，等级 0 的用户没有配置 —— 回落 env。
     * 静默落到 10 那一档会让「只给高等级用户开放候选池」这种配置失效。
     */
    await addPool('paid', 'LLM', ['opus']);
    await addMapping('LLM', 10, 'paid', null);

    expect(await repo.select('LLM', 0)).toBeNull();
    expect(await repo.select('LLM', 9)).toBeNull();
    expect((await repo.select('LLM', 10))?.poolName).toBe('paid');
  });

  it('两个 kind 各自独立，同名池互不干扰', async () => {
    /*
     * 「付费池」在文本与图像下的模型完全不同，这是 (name, kind) 复合唯一
     * 存在的理由 —— 运营配置时说的是业务语言，不用记 paid_llm 这种拼名。
     */
    await addPool('paid', 'LLM', ['opus']);
    await addPool('paid', 'IMAGE', ['image-model-v2']);
    await addMapping('LLM', 0, 'paid', 3);
    await addMapping('IMAGE', 0, 'paid', 1);

    expect((await repo.select('LLM', 0))?.models).toEqual(['opus']);
    expect((await repo.select('IMAGE', 0))?.models).toEqual(['image-model-v2']);
    expect((await repo.select('IMAGE', 0))?.maxCandidates).toBe(1);
  });

  it('models 的顺序被保留（顺序即 failover 优先级）', async () => {
    await addPool('ordered', 'LLM', ['first', 'second', 'third']);
    await addMapping('LLM', 0, 'ordered', null);

    expect((await repo.select('LLM', 0))?.models).toEqual(['first', 'second', 'third']);
  });

  it('空 models 数组被 CHECK 拒绝', async () => {
    /*
     * 空池的语义会是「这一档不许用 AI」，而那与「没有配置、走 env 默认」
     * 完全不同 —— 允许空数组会让两种相反的意图在数据上长得一样。
     */
    await expect(addPool('empty', 'LLM', [])).rejects.toThrow(/models_nonempty/);
  });

  it('映射不能指向别的 kind 的池（复合外键）', async () => {
    /*
     * 拦的是把图像池配给文本这种错误。单列外键做不到 ——
     * 池名在两个 kind 下都合法存在。
     */
    await addPool('paid', 'IMAGE', ['image-model']);

    await expect(addMapping('LLM', 0, 'paid', 1)).rejects.toThrow(/pool_fkey/);
  });

  it('max_candidates 为 0 被 CHECK 拒绝', async () => {
    /*
     * 0 个候选等于「配了但不许用」，语义含混。要禁用 AI 走
     * QUOTA_*_AI_HERO=0 那条既有的路。
     */
    await addPool('paid', 'LLM', ['opus']);

    await expect(addMapping('LLM', 0, 'paid', 0)).rejects.toThrow(/max_candidates/);
  });

  it('users.tier_level 默认 0 且拒绝负数', async () => {
    /*
     * 用仓储建用户而不是手写 INSERT：users 表有若干必填列（配额等），
     * 手写会在表结构演进时随机失败，而这条用例关心的只是新加的那一列。
     */
    const users = createUsersRepository(pool);
    const created = await users.createAnonymous({
      tokenHash: `tier-test-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdIp: null,
      dailyQuota: 5,
      monthlyQuota: 10,
    });

    const row = await pool.query<{ tier_level: number }>(
      'SELECT tier_level FROM users WHERE id = $1',
      [created.id],
    );
    // 迁移用 DEFAULT 回填，因此存量行不需要 UPDATE
    expect(row.rows[0]?.tier_level).toBe(0);

    await expect(
      pool.query('UPDATE users SET tier_level = -1 WHERE id = $1', [created.id]),
    ).rejects.toThrow(/tier_level_check/);

    await pool.query('DELETE FROM users WHERE id = $1', [created.id]);
  });

  it('缓存在 TTL 内不重复查库，invalidate 后立刻重查', async () => {
    await addPool('free', 'LLM', ['mini']);
    await addMapping('LLM', 0, 'free', 3);

    let clock = 1_000_000;
    const cached = createModelPoolsRepository(pool, {
      cacheTtlMs: 60_000,
      now: () => clock,
    });

    expect((await cached.select('LLM', 0))?.models).toEqual(['mini']);

    // 库里换了内容，但 TTL 未到 —— 仍读到旧值
    await pool.query(`UPDATE model_pools SET models = '["pro"]'::jsonb WHERE name = 'free'`);
    expect((await cached.select('LLM', 0))?.models).toEqual(['mini']);

    // CLI 写完会调 invalidate，让本进程立刻看到新值
    cached.invalidate();
    expect((await cached.select('LLM', 0))?.models).toEqual(['pro']);

    // TTL 过期也会重查
    await pool.query(`UPDATE model_pools SET models = '["opus"]'::jsonb WHERE name = 'free'`);
    clock += 60_001;
    expect((await cached.select('LLM', 0))?.models).toEqual(['opus']);
  });
});
