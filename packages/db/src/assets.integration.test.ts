import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';

/**
 * 素材与展示表的集成测试（TP-3-01，需真实 PostgreSQL）。
 *
 * 这里验证的每一条都是**只有数据库能保证**的不变式：
 *   - AI 图不能被标成实拍（9.4、二十章的对外披露承诺）
 *   - 同一 cache_key 全平台只一行（19.5 的复用前提）
 *   - 同一槽位不产生重复绑定（TP-3-15）
 *   - 完整计划页不能重复插入（COALESCE 唯一索引，13.4 取数确定性）
 *   - 素材不随计划删除而消失（15.3 的 RESTRICT）
 *
 * 运行：`DATABASE_URL=postgres://... pnpm test:integration`
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('素材与展示表（集成，需 PostgreSQL）', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    /*
     * 顺序有意义：绑定引用素材且是 RESTRICT，先删素材会报外键冲突。
     * assets 不带 user_id（十五章「表关系总览」：全局共享），
     * 因此删 users 带不走它，必须显式清理。
     */
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
  });

  // ── 夹具 ──────────────────────────────────────────────────

  async function insertUser(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (
         user_type, status, anon_token_hash, anon_expires_at,
         daily_plan_quota, monthly_plan_quota)
       VALUES ('ANONYMOUS', 'ACTIVE',
               md5(random()::text) || md5(random()::text),
               NOW() + INTERVAL '30 days', 5, 10)
       RETURNING id`,
    );
    return rows[0]!.id;
  }

  /** 建到版本一层，返回 (plan_id, version_id) */
  async function insertPlanVersion(): Promise<{ planId: string; versionId: string }> {
    const userId = await insertUser();
    const request = await pool.query<{ id: string }>(
      `INSERT INTO travel_requests (
         user_id, client_request_id, idempotency_key, raw_request, normalized_request,
         destination_name, destination_place_id, start_date, end_date, total_days, traveler_count)
       VALUES ($1, 'req-1', md5(random()::text) || md5(random()::text), '{}', '{}',
               '杭州', 'cn-hangzhou', DATE '2026-04-01', DATE '2026-04-03', 3, 2)
       RETURNING id`,
      [userId],
    );
    const plan = await pool.query<{ id: string }>(
      `INSERT INTO travel_plans (user_id, request_id, destination_name, start_date, total_days)
       VALUES ($1, $2, '杭州', DATE '2026-04-01', 3)
       RETURNING id`,
      [userId, request.rows[0]!.id],
    );
    const planId = plan.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO travel_plan_versions (
         plan_id, version_number, status, plan_json, retrieval_projection,
         destination_place_id, total_days)
       VALUES ($1, 1, 'READY', '{"days":[]}', '{}', 'cn-hangzhou', 3)
       RETURNING id`,
      [planId],
    );
    return { planId, versionId: version.rows[0]!.id };
  }

  interface AssetOverrides {
    readonly sourceType?: string;
    readonly representationType?: string;
    readonly cacheKey?: string | null;
    readonly generationMetadata?: string | null;
    readonly status?: string;
  }

  async function insertAsset(overrides: AssetOverrides = {}): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         asset_type, source_type, representation_type, entity_name, destination_name,
         destination_place_id, storage_url, mime_type, width, height, aspect_ratio,
         license_type, quality_score, cache_key, generation_metadata, status)
       VALUES ('IMAGE', $1, $2, '拱宸桥', '杭州', 'cn-hangzhou',
               's3://tps-assets/' || md5(random()::text) || '.webp', 'image/webp',
               1200, 675, 1.77778, 'PLATFORM_OWNED', 0.8, $3, $4::jsonb, $5)
       RETURNING id`,
      [
        overrides.sourceType ?? 'PLATFORM_LIBRARY',
        overrides.representationType ?? 'PHOTOGRAPHIC',
        overrides.cacheKey ?? null,
        overrides.generationMetadata ?? null,
        overrides.status ?? 'ACTIVE',
      ],
    );
    return rows[0]!.id;
  }

  // ── assets 的两条 CHECK ───────────────────────────────────

  describe('assets 约束', () => {
    it('AI_GENERATED + PHOTOGRAPHIC 被拒（assets_ai_must_be_illustrative）', async () => {
      /*
       * 这是二十章「不把 AI 景点图标记成真实照片」在数据库层的落点。
       * 只靠解析器保证不够：把 AI 图标成实拍没有任何外部症状 ——
       * 页面上就是一张好看的图，只是「示意图」三个字没了。
       */
      await expect(
        insertAsset({
          sourceType: 'AI_GENERATED',
          representationType: 'PHOTOGRAPHIC',
          generationMetadata: '{"generated_model":"m","cost_units":1}',
        }),
      ).rejects.toThrow(/assets_ai_must_be_illustrative/);
    });

    it('AI_GENERATED + ILLUSTRATIVE 可以插入', async () => {
      const id = await insertAsset({
        sourceType: 'AI_GENERATED',
        representationType: 'ILLUSTRATIVE',
        generationMetadata: '{"generated_model":"m","cost_units":1}',
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('AI_GENERATED 缺 generation_metadata 被拒（验收标准 12 的判定依据）', async () => {
      await expect(
        insertAsset({ sourceType: 'AI_GENERATED', representationType: 'ILLUSTRATIVE' }),
      ).rejects.toThrow(/assets_ai_metadata_check/);
    });

    it('同一 cache_key 只能有一行，但多行 NULL 允许（19.5）', async () => {
      await insertAsset({ cacheKey: 'place:v1:hz-gongchen-bridge:destination_photo:16x9' });
      await expect(
        insertAsset({ cacheKey: 'place:v1:hz-gongchen-bridge:destination_photo:16x9' }),
      ).rejects.toThrow(/assets_cache_key_uk/);

      // 人工灌入的种子素材不带 cache_key，必须能有任意多行
      await insertAsset({ cacheKey: null });
      await insertAsset({ cacheKey: null });
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) FROM assets WHERE cache_key IS NULL',
      );
      expect(rows[0]!.count).toBe('2');
    });

    it('quality_score 超出 [0,1] 被拒', async () => {
      await expect(
        pool.query(
          `INSERT INTO assets (asset_type, source_type, storage_url, license_type, quality_score)
           VALUES ('IMAGE', 'PLATFORM_LIBRARY', 's3://x', 'CC0', 1.5)`,
        ),
      ).rejects.toThrow(/assets_quality_range_check/);
    });
  });

  // ── plan_asset_bindings ───────────────────────────────────

  describe('plan_asset_bindings', () => {
    async function bind(
      versionId: string,
      planId: string,
      assetId: string,
      slotId: string,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO plan_asset_bindings (
           plan_id, plan_version_id, day_number, template_id, slot_id, role, asset_id,
           resolution_strategy, resolution_score)
         VALUES ($1, $2, 1, 'travel_infographic_v1', $3, 'DESTINATION_PHOTO', $4,
                 'LOCAL_LIBRARY_MATCH', 0.92)`,
        [planId, versionId, slotId, assetId],
      );
    }

    it('同一 (版本, 模板, 槽位) 重复绑定被拒（TP-3-15）', async () => {
      const { planId, versionId } = await insertPlanVersion();
      const assetId = await insertAsset();

      await bind(versionId, planId, assetId, 'day_1.photo_spot.1');
      await expect(bind(versionId, planId, assetId, 'day_1.photo_spot.1')).rejects.toThrow(
        /plan_asset_bindings_uk/,
      );
    });

    it('素材被引用时不能删除（15.3 的 RESTRICT）', async () => {
      const { planId, versionId } = await insertPlanVersion();
      const assetId = await insertAsset();
      await bind(versionId, planId, assetId, 'day_1.photo_spot.1');

      await expect(pool.query('DELETE FROM assets WHERE id = $1', [assetId])).rejects.toThrow(
        /plan_asset_bindings/,
      );

      /*
       * 因此「下架」只能是标记而不是删除 —— 迁移 0005 为此补了 status 列
       * （19.3 引用了 assets.status，而十五章的 DDL 里没有它）。
       */
      await pool.query(`UPDATE assets SET status = 'RETIRED' WHERE id = $1`, [assetId]);
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM assets WHERE id = $1',
        [assetId],
      );
      expect(rows[0]!.status).toBe('RETIRED');
    });

    it('删除用户带走绑定，但素材留下（素材是共享资源）', async () => {
      const { planId, versionId } = await insertPlanVersion();
      const assetId = await insertAsset();
      await bind(versionId, planId, assetId, 'day_1.photo_spot.1');

      await pool.query('DELETE FROM users');

      const bindings = await pool.query<{ count: string }>(
        'SELECT count(*) FROM plan_asset_bindings',
      );
      expect(bindings.rows[0]!.count).toBe('0');
      const assets = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
      expect(assets.rows[0]!.count).toBe('1');
    });
  });

  // ── plan_presentations ────────────────────────────────────

  describe('plan_presentations', () => {
    async function insertPresentation(
      planId: string,
      versionId: string,
      pageType: 'DAILY_POSTER' | 'FULL_PLAN',
      dayNumber: number | null,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO plan_presentations (
           plan_id, plan_version_id, template_id, page_type, day_number,
           view_model, validation_status)
         VALUES ($1, $2, $3, $4, $5, '{}', 'VALID')`,
        [
          planId,
          versionId,
          pageType === 'FULL_PLAN' ? 'travel_full_plan_v1' : 'travel_infographic_v1',
          pageType,
          dayNumber,
        ],
      );
    }

    it('完整计划页重复插入被拒（COALESCE(day_number, -1) 唯一索引）', async () => {
      const { planId, versionId } = await insertPlanVersion();
      await insertPresentation(planId, versionId, 'FULL_PLAN', null);

      /*
       * 不做 COALESCE 处理时这里会成功 —— NULL 不参与唯一性比较。
       * 症状是 13.4 取数拿到多行，「同一个计划刷新两次看到不同的页面」。
       */
      await expect(insertPresentation(planId, versionId, 'FULL_PLAN', null)).rejects.toThrow(
        /plan_presentations_uk/,
      );
    });

    it('同一天重复编排被拒，不同天并存', async () => {
      const { planId, versionId } = await insertPlanVersion();
      await insertPresentation(planId, versionId, 'DAILY_POSTER', 1);
      await insertPresentation(planId, versionId, 'DAILY_POSTER', 2);

      await expect(insertPresentation(planId, versionId, 'DAILY_POSTER', 1)).rejects.toThrow(
        /plan_presentations_uk/,
      );
    });

    it('page_type 与 day_number 的绑定关系被强制（3.3.1）', async () => {
      const { planId, versionId } = await insertPlanVersion();

      await expect(insertPresentation(planId, versionId, 'DAILY_POSTER', null)).rejects.toThrow(
        /plan_presentations_day_number_check/,
      );
      await expect(insertPresentation(planId, versionId, 'FULL_PLAN', 1)).rejects.toThrow(
        /plan_presentations_day_number_check/,
      );
    });

    it('N+1 行：3 天计划编排后恰好 4 行（TP-3-03 的验证形态）', async () => {
      const { planId, versionId } = await insertPlanVersion();
      for (const day of [1, 2, 3]) {
        await insertPresentation(planId, versionId, 'DAILY_POSTER', day);
      }
      await insertPresentation(planId, versionId, 'FULL_PLAN', null);

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) FROM plan_presentations WHERE plan_version_id = $1',
        [versionId],
      );
      expect(rows[0]!.count).toBe('4');
    });

    it('删除版本带走展示行（15.3）', async () => {
      const { planId, versionId } = await insertPlanVersion();
      await insertPresentation(planId, versionId, 'DAILY_POSTER', 1);

      await pool.query('DELETE FROM users');
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) FROM plan_presentations',
      );
      expect(rows[0]!.count).toBe('0');
    });
  });
});
