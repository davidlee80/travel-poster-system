import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPool } from './pool.js';
import { createRetentionRepository, type RetentionRepository } from './retention.js';
import { createRetrievalRepository, type RetrievalRepository } from './retrieval.js';
import { createTravelPlansRepository, type TravelPlansRepository } from './travel-plans.js';
import { createUsersRepository, type UsersRepository } from './users.js';

/**
 * 保留期清理与知识转存（TP-4-21/22/23，需真实 PostgreSQL）。
 *
 * 门禁 #29 的两条都在这里验：
 *   - 转存**先于**删除，且两者同一事务（转存失败则不删除）；
 *   - `plan_knowledge` 行不含任何标识符。
 *
 * 还有 TP-4-23：匿名行被清理后，其知识仍能被后续生成的检索命中 ——
 * 这是整套设计的目的（3.2.4 的全局检索不因清理而持续失血）。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

/** 与 `plan_knowledge.embedding` 同维度（1536） */
function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_unused, index) => ((index + seed) % 7) / 7);
}

describeIntegration('保留期清理（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let retention: RetentionRepository;
  let plans: TravelPlansRepository;
  let users: UsersRepository;
  let retrieval: RetrievalRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 10_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
    });
    await migrate(pool, migrationsDirectory());
    retention = createRetentionRepository(pool);
    plans = createTravelPlansRepository(pool);
    users = createUsersRepository(pool);
    retrieval = createRetrievalRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    await pool.query('TRUNCATE plan_knowledge');
  });

  /**
   * 建一个匿名用户 + 一个计划版本。
   *
   * `expiredDaysAgo` 是 `anon_expires_at` 距今的天数（正数表示已过期）。
   */
  async function seedAnonymous(options: {
    readonly expiredDaysAgo: number;
    readonly status?: 'READY' | 'REJECTED';
    readonly withEmbedding?: boolean;
  }): Promise<{ userId: string; planId: string; versionId: string }> {
    const user = await users.createAnonymous({
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() - options.expiredDaysAgo * 86_400_000),
      createdIp: null,
      dailyQuota: 5,
      monthlyQuota: 10,
    });

    const handles = await plans.createGeneration({
      userId: user.id,
      clientRequestId: 'req-1',
      idempotencyKey: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      rawRequest: { schema_version: 'travel_request_ui_v1' },
      normalizedRequest: { schema_version: 'normalized_travel_request_v1' },
      destinationName: '杭州',
      destinationPlaceId: 'cn_hangzhou',
      startDate: '2026-09-10',
      endDate: '2026-09-14',
      totalDays: 5,
      travelerCount: 2,
    });

    const versionId = randomUUID();
    await plans.savePlanVersion({
      versionId,
      planId: handles.planId,
      status: options.status ?? 'READY',
      planJson: { schema_version: 'travel_plan_v1', title: '杭州 5 天' },
      constraintReport: {},
      retrievalProjection: {
        schema_version: 'retrieval_projection_v1',
        destination_place_id: 'cn_hangzhou',
        total_days: 5,
        poi_names: ['拱宸桥', '大运河博物馆'],
      },
      destinationPlaceId: 'cn_hangzhou',
      totalDays: 5,
      planEmbedding: options.withEmbedding === false ? null : vector(1),
      title: '杭州 5 天',
      llmModel: 'fake',
      llmPromptVersion: 'plan_v1',
      inputTokens: 0,
      outputTokens: 0,
      repairIterations: 0,
      regenerationCount: 0,
    });

    return { userId: user.id, planId: handles.planId, versionId };
  }

  describe('扫描到期用户（15.1）', () => {
    it('过了 30 天宽限期才收', async () => {
      // 刚过期 10 天 —— 还在宽限期内
      await seedAnonymous({ expiredDaysAgo: 10 });
      // 过期 45 天 —— 超过宽限期
      const stale = await seedAnonymous({ expiredDaysAgo: 45 });

      const found = await retention.findExpiredAnonymous({ limit: 100, graceDays: 30 });
      expect(found.map((row) => row.userId)).toEqual([stale.userId]);
    });

    it('未过期的匿名用户不收（last_seen_at 续期后应当留下）', async () => {
      await seedAnonymous({ expiredDaysAgo: -10 });
      expect(await retention.findExpiredAnonymous({ limit: 100, graceDays: 30 })).toEqual([]);
    });

    it('注册用户永不被这条路径收（15.1：长期保留）', async () => {
      await users.createRegistered({
        email: 'keep@example.com',
        passwordHash: 'argon2-placeholder',
        displayName: null,
        dailyQuota: 5,
        monthlyQuota: 20,
      });
      expect(await retention.findExpiredAnonymous({ limit: 100, graceDays: 0 })).toEqual([]);
    });

    it('按到期时间升序（最旧的先清）', async () => {
      const older = await seedAnonymous({ expiredDaysAgo: 90 });
      const newer = await seedAnonymous({ expiredDaysAgo: 45 });

      const found = await retention.findExpiredAnonymous({ limit: 100, graceDays: 30 });
      expect(found.map((row) => row.userId)).toEqual([older.userId, newer.userId]);
    });

    it('limit 生效（15.1 每批 500）', async () => {
      await seedAnonymous({ expiredDaysAgo: 45 });
      await seedAnonymous({ expiredDaysAgo: 46 });
      expect(await retention.findExpiredAnonymous({ limit: 1, graceDays: 30 })).toHaveLength(1);
    });
  });

  describe('知识转存先于删除（TP-4-22、门禁 #29）', () => {
    it('转存 READY 版本，然后级联删除用户', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45 });

      const result = await retention.purgeUser(seeded.userId);

      expect(result).toEqual({ userId: seeded.userId, transferred: 1, deleted: true });

      // users 行与计划全部消失
      const remaining = await pool.query('SELECT 1 FROM users WHERE id = $1', [seeded.userId]);
      expect(remaining.rowCount).toBe(0);
      const versions = await pool.query('SELECT 1 FROM travel_plan_versions WHERE id = $1', [
        seeded.versionId,
      ]);
      expect(versions.rowCount).toBe(0);

      // 知识留下来了
      const knowledge = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM plan_knowledge',
      );
      expect(knowledge.rows[0]!.count).toBe('1');
    });

    it('plan_knowledge 行不含任何标识符（门禁 #29）', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45 });
      await retention.purgeUser(seeded.userId);

      const { rows } = await pool.query<Record<string, unknown>>('SELECT * FROM plan_knowledge');
      const columns = Object.keys(rows[0] ?? {});

      /*
       * 表本身没有 user_id 列（迁移 0003），因此这一条在数据库层就成立。
       * 这个断言防的是「将来有人为了排查方便加一列 user_id」——
       * 那会让「被清理掉的是谁在什么时候要去哪」这条承诺失效。
       */
      for (const forbidden of ['user_id', 'plan_id', 'plan_version_id', 'start_date', 'email']) {
        expect(columns, forbidden).not.toContain(forbidden);
      }

      // projection 里也不能有标识符（15.2 已保证，这里是回归断言）
      const projection = JSON.stringify(rows[0]?.['projection'] ?? {});
      expect(projection).not.toContain(seeded.userId);
      expect(projection).not.toContain(seeded.planId);
    });

    it('REJECTED 版本不转存（错误的安排不该推荐给后来的用户）', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45, status: 'REJECTED' });

      const result = await retention.purgeUser(seeded.userId);

      expect(result.transferred).toBe(0);
      expect(result.deleted).toBe(true);
      const knowledge = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM plan_knowledge',
      );
      expect(knowledge.rows[0]!.count).toBe('0');
    });

    it('没有向量的版本不转存（plan_knowledge.embedding 是 NOT NULL）', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45, withEmbedding: false });

      const result = await retention.purgeUser(seeded.userId);
      expect(result.transferred).toBe(0);
      // 用户仍然被删除 —— 保留承诺不因为「这份计划没能沉淀成知识」而打折
      expect(result.deleted).toBe(true);
    });

    it('转存失败则不删除（同一事务）', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45 });

      /*
       * 用一个必然让 INSERT 失败的方式注入故障：给 plan_knowledge 加一条
       * 不可能满足的 CHECK。事务里的 INSERT 因此报错，DELETE 必须一起回滚。
       *
       * 这是整套设计里最重要的一条不变量：先删后转存会**永久**损失行程知识，
       * 而分两个事务则会在失败时二者不一致。
       */
      await pool.query(
        `ALTER TABLE plan_knowledge ADD CONSTRAINT tmp_block_insert CHECK (total_days < 0)`,
      );
      try {
        await expect(retention.purgeUser(seeded.userId)).rejects.toThrow();

        // 用户仍在，计划仍在
        const remaining = await pool.query('SELECT 1 FROM users WHERE id = $1', [seeded.userId]);
        expect(remaining.rowCount).toBe(1);
        const versions = await pool.query('SELECT 1 FROM travel_plan_versions WHERE id = $1', [
          seeded.versionId,
        ]);
        expect(versions.rowCount).toBe(1);
      } finally {
        await pool.query('ALTER TABLE plan_knowledge DROP CONSTRAINT tmp_block_insert');
      }
    });

    it('assets 不随用户删除（15.1：素材跨用户共享，不删除）', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45 });
      const assetId = randomUUID();
      await pool.query(
        `INSERT INTO assets (id, asset_type, source_type, storage_url, license_type)
         VALUES ($1::uuid, 'IMAGE', 'PLATFORM_LIBRARY', 'https://cdn.test/a.webp', 'PLATFORM_OWNED')`,
        [assetId],
      );

      await retention.purgeUser(seeded.userId);

      const asset = await pool.query('SELECT 1 FROM assets WHERE id = $1', [assetId]);
      expect(asset.rowCount).toBe(1);
    });
  });

  describe('TP-4-23：清理后知识仍可被检索命中', () => {
    it('匿名行删除后，3.2.4 的检索仍能从 plan_knowledge 召回', async () => {
      const seeded = await seedAnonymous({ expiredDaysAgo: 45 });
      await retention.purgeUser(seeded.userId);

      const candidates = await retrieval.findSimilar({
        embedding: vector(1),
        destinationPlaceId: 'cn_hangzhou',
        totalDays: 5,
        // 用同一个向量查，相似度是 1.0，因此阈值取多少都命中
        minSimilarity: 0.5,
        dayTolerance: 1,
        limit: 5,
        timeoutMs: 5_000,
      });

      /*
       * 这条断言是整套设计的目的（15.1 的「关键决定」）：
       * 匿名请求占比可能很高，而它们的行程知识随身份删除会让 3.2.4 的
       * 全局检索持续失血 —— 后来的用户因此拿到更差的计划。
       */
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.some((candidate) => candidate.source === 'knowledge')).toBe(true);
      // knowledge 来源没有对应计划（原计划已被清理）
      const fromKnowledge = candidates.find((candidate) => candidate.source === 'knowledge');
      expect(fromKnowledge?.planId).toBeNull();
    });
  });

  describe('countKnowledgeRows', () => {
    it('返回当前行数（travel_knowledge_rows 指标的数据源）', async () => {
      expect(await retention.countKnowledgeRows()).toBe(0);
      const seeded = await seedAnonymous({ expiredDaysAgo: 45 });
      await retention.purgeUser(seeded.userId);
      expect(await retention.countKnowledgeRows()).toBe(1);
    });
  });
});
