import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPresentationsRepository, type PresentationsRepository } from './presentations.js';

/**
 * 展示与绑定仓储（TP-3-15、TP-3-16，需真实 PostgreSQL）。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('展示与绑定仓储（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repo: PresentationsRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    repo = createPresentationsRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
  });

  interface Fixture {
    readonly userId: string;
    readonly planId: string;
    readonly versionId: string;
  }

  /** 建到「有当前版本」的状态 */
  async function fixture(status: 'READY' | 'REJECTED' = 'READY'): Promise<Fixture> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (user_type, status, anon_token_hash, anon_expires_at,
                          daily_plan_quota, monthly_plan_quota)
       VALUES ('ANONYMOUS', 'ACTIVE', md5(random()::text) || md5(random()::text),
               NOW() + INTERVAL '30 days', 5, 10)
       RETURNING id`,
    );
    const userId = user.rows[0]!.id;

    const request = await pool.query<{ id: string }>(
      `INSERT INTO travel_requests (
         user_id, client_request_id, idempotency_key, raw_request, normalized_request,
         destination_name, start_date, end_date, total_days, traveler_count)
       VALUES ($1, 'req', md5(random()::text) || md5(random()::text), '{}', '{}',
               '杭州', DATE '2026-04-01', DATE '2026-04-03', 3, 2)
       RETURNING id`,
      [userId],
    );
    const plan = await pool.query<{ id: string }>(
      `INSERT INTO travel_plans (user_id, request_id, destination_name, start_date, total_days)
       VALUES ($1, $2, '杭州', DATE '2026-04-01', 3) RETURNING id`,
      [userId, request.rows[0]!.id],
    );
    const planId = plan.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO travel_plan_versions (
         plan_id, version_number, status, plan_json, retrieval_projection,
         destination_place_id, total_days)
       VALUES ($1, 1, $2, '{}', '{}', 'cn-hangzhou', 3)
       RETURNING id`,
      [planId, status],
    );
    const versionId = version.rows[0]!.id;

    /*
     * REJECTED 版本不能成为 current_version_id（0003 的触发器会拒绝），
     * 这正是 13.4 返回 404 的机制之一 —— 因此这里只在 READY 时提升。
     */
    if (status === 'READY') {
      await pool.query(`UPDATE travel_plans SET current_version_id = $2 WHERE id = $1`, [
        planId,
        versionId,
      ]);
    }

    return { userId, planId, versionId };
  }

  async function insertAsset(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO assets (asset_type, source_type, storage_url, license_type,
                           entity_name, destination_place_id, width, height)
       VALUES ('IMAGE', 'PLATFORM_LIBRARY', 's3://tps-assets/' || md5(random()::text),
               'PLATFORM_OWNED', '拱宸桥', 'cn-hangzhou', 1200, 675)
       RETURNING id`,
    );
    return rows[0]!.id;
  }

  // ── 13.4 取数 ─────────────────────────────────────────────

  it('N+1 页写入后按天与按完整页各取一次', async () => {
    const { userId, planId, versionId } = await fixture();

    await repo.savePresentations([
      ...[1, 2, 3].map((day) => ({
        planId,
        planVersionId: versionId,
        templateId: 'travel_infographic_v1',
        pageType: 'DAILY_POSTER' as const,
        dayNumber: day,
        viewModel: { day_number: day },
        validationStatus: 'VALID' as const,
      })),
      {
        planId,
        planVersionId: versionId,
        templateId: 'travel_full_plan_v1',
        pageType: 'FULL_PLAN' as const,
        dayNumber: null,
        viewModel: { page: 'full' },
        validationStatus: 'VALID' as const,
      },
    ]);

    const day2 = await repo.findPresentation({
      planId,
      userId,
      pageType: 'DAILY_POSTER',
      dayNumber: 2,
    });
    expect(day2?.viewModel).toEqual({ day_number: 2 });

    const full = await repo.findPresentation({ planId, userId, pageType: 'FULL_PLAN' });
    expect(full?.viewModel).toEqual({ page: 'full' });
    expect(full?.dayNumber).toBeNull();
  });

  it('重复编排走 upsert：行数不变，内容更新', async () => {
    const { userId, planId, versionId } = await fixture();
    const row = {
      planId,
      planVersionId: versionId,
      templateId: 'travel_infographic_v1',
      pageType: 'DAILY_POSTER' as const,
      dayNumber: 1,
      validationStatus: 'DEGRADED' as const,
    };

    await repo.savePresentations([{ ...row, viewModel: { v: 1 } }]);
    await repo.savePresentations([
      { ...row, viewModel: { v: 2 }, validationStatus: 'VALID' as const },
    ]);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM plan_presentations');
    expect(rows[0]!.count).toBe('1');

    const found = await repo.findPresentation({
      planId,
      userId,
      pageType: 'DAILY_POSTER',
      dayNumber: 1,
    });
    expect(found?.viewModel).toEqual({ v: 2 });
    expect(found?.validationStatus).toBe('VALID');
  });

  it('他人计划取不到（13.0：返回 null 由调用方映射 404）', async () => {
    const { planId, versionId } = await fixture();
    await repo.savePresentations([
      {
        planId,
        planVersionId: versionId,
        templateId: 'travel_infographic_v1',
        pageType: 'DAILY_POSTER',
        dayNumber: 1,
        viewModel: {},
        validationStatus: 'VALID',
      },
    ]);

    const other = await fixture();
    const found = await repo.findPresentation({
      planId,
      userId: other.userId,
      pageType: 'DAILY_POSTER',
      dayNumber: 1,
    });
    expect(found).toBeNull();
  });

  it('REJECTED 版本取不到，即使显式指定版本 ID（验收标准 15）', async () => {
    const { userId, planId, versionId } = await fixture('REJECTED');
    await repo.savePresentations([
      {
        planId,
        planVersionId: versionId,
        templateId: 'travel_infographic_v1',
        pageType: 'DAILY_POSTER',
        dayNumber: 1,
        viewModel: { draft: true },
        validationStatus: 'INVALID',
      },
    ]);

    expect(
      await repo.findPresentation({ planId, userId, pageType: 'DAILY_POSTER', dayNumber: 1 }),
    ).toBeNull();
    expect(
      await repo.findPresentation({
        planId,
        userId,
        pageType: 'DAILY_POSTER',
        dayNumber: 1,
        planVersionId: versionId,
      }),
    ).toBeNull();
  });

  it('默认取当前版本；显式指定旧版本时返回旧版本（13.4）', async () => {
    const { userId, planId, versionId } = await fixture();

    // 第二个版本并提升为当前
    const v2 = await pool.query<{ id: string }>(
      `INSERT INTO travel_plan_versions (
         plan_id, version_number, status, plan_json, retrieval_projection,
         destination_place_id, total_days)
       VALUES ($1, 2, 'REPAIRED', '{}', '{}', 'cn-hangzhou', 3) RETURNING id`,
      [planId],
    );
    const v2Id = v2.rows[0]!.id;
    await pool.query('UPDATE travel_plans SET current_version_id = $2 WHERE id = $1', [
      planId,
      v2Id,
    ]);

    const base = {
      planId,
      templateId: 'travel_infographic_v1',
      pageType: 'DAILY_POSTER' as const,
      dayNumber: 1,
      validationStatus: 'VALID' as const,
    };
    await repo.savePresentations([
      { ...base, planVersionId: versionId, viewModel: { v: 1 } },
      { ...base, planVersionId: v2Id, viewModel: { v: 2 } },
    ]);

    const current = await repo.findPresentation({
      planId,
      userId,
      pageType: 'DAILY_POSTER',
      dayNumber: 1,
    });
    expect(current?.viewModel).toEqual({ v: 2 });

    const old = await repo.findPresentation({
      planId,
      userId,
      pageType: 'DAILY_POSTER',
      dayNumber: 1,
      planVersionId: versionId,
    });
    expect(old?.viewModel).toEqual({ v: 1 });
  });

  // ── 绑定 ──────────────────────────────────────────────────

  it('重复解析不产生重复绑定，且素材可替换（TP-3-15）', async () => {
    const { planId, versionId } = await fixture();
    const first = await insertAsset();
    const second = await insertAsset();

    const binding = {
      planId,
      planVersionId: versionId,
      dayNumber: 1,
      templateId: 'travel_infographic_v1',
      slotId: 'day_1.photo_spot.1',
      role: 'DESTINATION_PHOTO',
      resolutionStrategy: 'LOCAL_LIBRARY_MATCH',
      resolutionScore: 0.8,
    };

    await repo.saveBindings([{ ...binding, assetId: first }]);
    await repo.saveBindings([
      { ...binding, assetId: second, resolutionStrategy: 'CACHE_HIT', resolutionScore: 1 },
    ]);

    const rows = await repo.listBindings(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetId).toBe(second);
    expect(rows[0]!.resolutionStrategy).toBe('CACHE_HIT');
    // NUMERIC 转回数值而不是字符串 —— 前者才能参与比较与打点
    expect(rows[0]!.resolutionScore).toBe(1);
  });

  it('listBindings 连素材表取出展示字段', async () => {
    const { planId, versionId } = await fixture();
    const assetId = await insertAsset();

    await repo.saveBindings([
      {
        planId,
        planVersionId: versionId,
        dayNumber: 2,
        templateId: 'travel_infographic_v1',
        slotId: 'day_2.food.lunch',
        role: 'FOOD_IMAGE',
        assetId,
        resolutionStrategy: 'LOCAL_LIBRARY_MATCH',
        resolutionScore: 0.91,
      },
    ]);

    const rows = await repo.listBindings(versionId);
    expect(rows[0]).toMatchObject({
      slotId: 'day_2.food.lunch',
      role: 'FOOD_IMAGE',
      dayNumber: 2,
      sourceType: 'PLATFORM_LIBRARY',
      representationType: 'PHOTOGRAPHIC',
      assetType: 'IMAGE',
      width: 1200,
      height: 675,
    });
    expect(rows[0]!.storageUrl).toMatch(/^s3:\/\/tps-assets\//);
  });

  // ── R-85：多模板共存 ────────────────────────

  /**
   * 一个 `plan_version_id` 下可以共存多套模板的展示数据 ——
   * `plan_presentations_uk` 包含 `template_id`，这是 schema 一开始就给的能力。
   *
   * 而在 R-85 之前四处读查询都不按 `template_id` 过滤，不出问题只因为
   * 「每个页型恰好一行」。下面这组用例先造出共存，再逐个验。
   */
  async function twoTemplates() {
    const f = await fixture();
    /*
     * 注意插入顺序：magazine 在前。这是有意的 —— 它让物理顺序与
     * `ORDER BY ... , template_id` 的顺序**相反**，于是下面那条
     * 「缺 templateId 时取哪一套」的用例才真能失败。
     * 顺序一致的话那条用例无论 ORDER BY 在不在都会绿（已实测）。
     */
    const templates = ['magazine_v1', 'classic_v1'] as const;
    await repo.savePresentations([
      ...[1, 2].flatMap((day) =>
        templates.map((templateId) => ({
          planId: f.planId,
          planVersionId: f.versionId,
          templateId,
          pageType: 'DAILY_POSTER' as const,
          dayNumber: day,
          viewModel: { day_number: day, from: templateId },
          validationStatus: 'VALID' as const,
        })),
      ),
      ...templates.map((templateId) => ({
        planId: f.planId,
        planVersionId: f.versionId,
        templateId,
        pageType: 'FULL_PLAN' as const,
        dayNumber: null,
        viewModel: { page: 'full', from: templateId },
        validationStatus: 'VALID' as const,
      })),
    ]);
    return f;
  }

  it('同版本同页型的两套模板可以共存（先确认写得进去）', async () => {
    const { versionId } = await twoTemplates();

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM plan_presentations WHERE plan_version_id = $1`,
      [versionId],
    );
    // 2 天 × 2 套 + 全览页 × 2 套
    expect(rows[0]!.count).toBe('6');
  });

  it('findPresentationByVersion 按 templateId 取回各自那份（渲染路径）', async () => {
    /*
     * 这是本组里最要紧的一条。渲染路径走的就是这个函数，
     * 而它原先是 `LIMIT 1` 且没有 `ORDER BY` —— 两套模板共存时
     * PostgreSQL 不保证返回哪一行，同一次导出的 PNG 与 PDF 都可能
     * 取到不同模板，而两者都会被判为成功。
     */
    const { versionId } = await twoTemplates();

    const classic = await repo.findPresentationByVersion({
      planVersionId: versionId,
      pageType: 'DAILY_POSTER',
      dayNumber: 2,
      templateId: 'classic_v1',
    });
    const magazine = await repo.findPresentationByVersion({
      planVersionId: versionId,
      pageType: 'DAILY_POSTER',
      dayNumber: 2,
      templateId: 'magazine_v1',
    });

    expect(classic?.templateId).toBe('classic_v1');
    expect(classic?.viewModel).toEqual({ day_number: 2, from: 'classic_v1' });
    expect(magazine?.templateId).toBe('magazine_v1');
    expect(magazine?.viewModel).toEqual({ day_number: 2, from: 'magazine_v1' });
  });

  it('缺 templateId 时取 template_id 排序在前的那一套，而不是物理顺序第一行', async () => {
    /*
     * 缺省不报错是有意的（P0 阶段渲染 URL 还不带 template），但缺省必须确定。
     *
     * 这条用例验的是 `ORDER BY pr.created_at DESC, pr.template_id` 里的
     * **第二个字段**：`created_at` 默认 NOW()，而 PostgreSQL 的 NOW() 是
     * 事务级的，`savePresentations` 又是单事务批量写入 —— 两套模板的
     * created_at **必然完全相同**。因此只按 created_at 排序等于没排，
     * `LIMIT 1` 会退回物理顺序。
     *
     * `twoTemplates` 故意把 magazine 插在前面，所以：
     *   有 template_id 排序 → classic_v1（字典序在前）
     *   没有          → magazine_v1（物理第一行）
     */
    const { versionId } = await twoTemplates();

    const row = await repo.findPresentationByVersion({
      planVersionId: versionId,
      pageType: 'DAILY_POSTER',
      dayNumber: 1,
    });

    expect(row?.templateId).toBe('classic_v1');
    expect(row?.viewModel).toEqual({ day_number: 1, from: 'classic_v1' });
  });

  it('findPresentation 按 templateId 取回各自那份（用户 API 路径）', async () => {
    const { userId, planId, versionId } = await twoTemplates();
    expect(versionId).toBeDefined();

    const classic = await repo.findPresentation({
      planId,
      userId,
      pageType: 'FULL_PLAN',
      templateId: 'classic_v1',
    });
    const magazine = await repo.findPresentation({
      planId,
      userId,
      pageType: 'FULL_PLAN',
      templateId: 'magazine_v1',
    });

    expect(classic?.viewModel).toEqual({ page: 'full', from: 'classic_v1' });
    expect(magazine?.viewModel).toEqual({ page: 'full', from: 'magazine_v1' });
  });

  it('listDayNumbers 不会把天号算两遍（导出页数与计费）', async () => {
    /*
     * 不过滤模板的后果是 2 天变 4 行，于是 `pagesFor` 渲染 4 页 ——
     * 真实场景里是 14 天变 28 页，时长翻倍、按页计费翻倍，
     * 而任务状态是 COMPLETED。
     */
    const { versionId } = await twoTemplates();

    expect(await repo.listDayNumbers(versionId, 'classic_v1')).toEqual([1, 2]);
    expect(await repo.listDayNumbers(versionId, 'magazine_v1')).toEqual([1, 2]);
    expect(await repo.listDayNumbers(versionId, '不存在的模板')).toEqual([]);
  });

  it('listBindings 给 templateId 时只返回该套，缺省时返回全部', async () => {
    const { planId, versionId } = await fixture();
    const assetId = await insertAsset();

    await repo.saveBindings(
      (['classic_v1', 'magazine_v1'] as const).map((templateId) => ({
        planId,
        planVersionId: versionId,
        dayNumber: 1,
        templateId,
        slotId: 'day_1.hero_background',
        role: 'HERO_BACKGROUND',
        assetId,
        resolutionStrategy: 'CACHE_HIT',
        resolutionScore: 1,
      })),
    );

    // 同一个 slot_id 在两套模板下各一行（plan_asset_bindings_uk 含 template_id）
    expect(await repo.listBindings(versionId)).toHaveLength(2);
    expect(await repo.listBindings(versionId, 'classic_v1')).toHaveLength(1);
  });
});
