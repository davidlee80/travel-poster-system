import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createExportsRepository, type ExportsRepository } from './exports.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPool } from './pool.js';
import { createTravelPlansRepository, type TravelPlansRepository } from './travel-plans.js';
import { UniqueViolationError, createUsersRepository, type UsersRepository } from './users.js';

/**
 * `exports` 仓储（TP-4-12/13，需真实 PostgreSQL）。
 *
 * 这里要证的三件事都只有真数据库能证：
 *   - `exports_idempotency_uk` 是幂等的**最终真相**（应用层的先查一次只是快路径）；
 *   - `exports_day_numbers_check` 挡住「SINGLE_DAY 却没说是哪一天」
 *     —— R-18 修正的那个三值逻辑漏洞；
 *   - `markRendering` 的 `WHERE status = 'QUEUED'` 让重复投递的第二个消费者
 *     改 0 行（13.8 的 Worker 侧并发保护）。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('exports 仓储（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repository: ExportsRepository;
  let plans: TravelPlansRepository;
  let users: UsersRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 10_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
    });
    await migrate(pool, migrationsDirectory());
    repository = createExportsRepository(pool);
    plans = createTravelPlansRepository(pool);
    users = createUsersRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
  });

  /** 建一个带有效计划版本的用户，返回导出需要的三个 ID */
  async function seed(): Promise<{ userId: string; planId: string; versionId: string }> {
    const user = await users.createAnonymous({
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      createdIp: null,
      dailyQuota: 5,
      monthlyQuota: 10,
    });

    const handles = await plans.createGeneration({
      userId: user.id,
      clientRequestId: 'req-1',
      idempotencyKey: 'export-seed'.padEnd(64, '0').slice(0, 64),
      rawRequest: { schema_version: 'travel_request_ui_v1' },
      normalizedRequest: { schema_version: 'normalized_travel_request_v1' },
      destinationName: '杭州',
      destinationPlaceId: 'cn_hangzhou',
      startDate: '2026-09-10',
      endDate: '2026-09-14',
      totalDays: 5,
      travelerCount: 2,
      /* 13.8 的 7 天窗口下界（迁移 0019） */
      supersedeBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000),
    });

    const versionId = randomUUID();
    await plans.savePlanVersion({
      versionId,
      planId: handles.planId,
      status: 'READY',
      planJson: { schema_version: 'travel_plan_v1' },
      constraintReport: {},
      retrievalProjection: { schema_version: 'retrieval_projection_v1' },
      destinationPlaceId: 'cn_hangzhou',
      totalDays: 5,
      planEmbedding: null,
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

  function input(
    seeded: { userId: string; planId: string; versionId: string },
    overrides: Partial<Parameters<ExportsRepository['create']>[0]> = {},
  ): Parameters<ExportsRepository['create']>[0] {
    return {
      exportId: randomUUID(),
      userId: seeded.userId,
      planId: seeded.planId,
      planVersionId: seeded.versionId,
      templateId: 'travel_infographic_v1',
      format: 'PDF',
      scope: 'ALL_DAYS',
      dayNumbers: null,
      idempotencyKey: 'k'.padEnd(64, '0'),
      ...overrides,
    };
  }

  describe('幂等', () => {
    it('同键第二次插入抛 UniqueViolationError（最终真相在唯一索引上）', async () => {
      const seeded = await seed();
      await repository.create(input(seeded));

      await expect(repository.create(input(seeded))).rejects.toBeInstanceOf(UniqueViolationError);
    });

    it('冲突后能按键查回既有任务', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));

      const found = await repository.findByIdempotencyKey('k'.padEnd(64, '0'));
      expect(found?.exportId).toBe(created.exportId);
    });
  });

  describe('exports_day_numbers_check（R-18）', () => {
    it('SINGLE_DAY 带一个天号可以落库', async () => {
      const seeded = await seed();
      const row = await repository.create(
        input(seeded, {
          scope: 'SINGLE_DAY',
          dayNumbers: [3],
          idempotencyKey: 'a'.padEnd(64, '0'),
        }),
      );
      expect(row.dayNumbers).toEqual([3]);
    });

    it('SINGLE_DAY 不带天号被数据库拒绝', async () => {
      const seeded = await seed();
      /*
       * 这一条正是 R-18 修正的漏洞：十五章原写法用
       * `array_length(NULL,1) = 1` → NULL，而 Postgres 把 NULL 视为满足 CHECK，
       * 于是「单日导出没说是哪一天」能落库，渲染 Worker 拿不到天号。
       */
      await expect(
        repository.create(
          input(seeded, {
            scope: 'SINGLE_DAY',
            dayNumbers: null,
            idempotencyKey: 'b'.padEnd(64, '0'),
          }),
        ),
      ).rejects.toThrow();
    });

    it('非 SINGLE_DAY 带天号被数据库拒绝', async () => {
      const seeded = await seed();
      await expect(
        repository.create(
          input(seeded, {
            scope: 'ALL_DAYS',
            dayNumbers: [1],
            idempotencyKey: 'c'.padEnd(64, '0'),
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('状态流转', () => {
    it('markRendering 只从 QUEUED 生效（重复投递的第二个消费者改 0 行）', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));

      expect(await repository.markRendering(created.exportId)).toBe(true);
      expect(await repository.markRendering(created.exportId)).toBe(false);
    });

    it('finish 写入 files 与状态，progress 置 100', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));
      await repository.markRendering(created.exportId);

      await repository.finish({
        exportId: created.exportId,
        status: 'COMPLETED',
        files: [
          {
            format: 'PDF',
            day_number: null,
            url: 'https://signed',
            byte_size: 100,
            expires_at: '2026-08-25T10:00:00.000Z',
            storage_key: `exports/${created.exportId}/all-days.pdf`,
          },
        ],
        errorCode: null,
      });

      const row = await repository.findById(created.exportId);
      expect(row?.status).toBe('COMPLETED');
      expect(row?.progress).toBe(100);
      expect(row?.finishedAt).not.toBeNull();
      expect(Array.isArray(row?.files)).toBe(true);
    });

    it('PARTIAL 也带错误码（13.6：部分失败仍返回成功项）', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));

      await repository.finish({
        exportId: created.exportId,
        status: 'PARTIAL',
        files: [],
        errorCode: 'EXPORT_PNG_FAILED',
        errorDetail: { failedDays: [2] },
      });

      const row = await repository.findById(created.exportId);
      expect(row?.status).toBe('PARTIAL');
      expect(row?.errorCode).toBe('EXPORT_PNG_FAILED');
    });

    it('replaceFiles 不动状态与完成时刻（13.6 重签不重渲染）', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));
      await repository.finish({
        exportId: created.exportId,
        status: 'COMPLETED',
        files: [],
        errorCode: null,
      });
      const before = await repository.findById(created.exportId);

      await repository.replaceFiles(created.exportId, [{ url: 'https://new-signature' }]);
      const after = await repository.findById(created.exportId);

      expect(after?.status).toBe('COMPLETED');
      /*
       * 完成时刻不能被重签名改写：动了的话「这次导出是什么时候完成的」
       * 就变成了「最后一次重签名的时间」。
       */
      expect(after?.finishedAt?.getTime()).toBe(before?.finishedAt?.getTime());
    });
  });

  describe('归属与级联', () => {
    it('findForUser 强制 user_id 谓词', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));

      expect(await repository.findForUser(created.exportId, seeded.userId)).not.toBeNull();
      expect(
        await repository.findForUser(created.exportId, '00000000-0000-4000-8000-000000000000'),
      ).toBeNull();
    });

    it('listForPlanForUser 返回下载命名上下文且强制 user_id 谓词', async () => {
      const seeded = await seed();
      const created = await repository.create(input(seeded));

      const mine = await repository.listForPlanForUser(seeded.planId, seeded.userId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        exportId: created.exportId,
        destinationName: '杭州',
        totalDays: 5,
        versionNumber: 1,
      });

      expect(
        await repository.listForPlanForUser(seeded.planId, '00000000-0000-4000-8000-000000000000'),
      ).toEqual([]);
    });

    it('删除用户时导出行级联删除（15.1）', async () => {
      const seeded = await seed();
      await repository.create(input(seeded));

      await pool.query('DELETE FROM users WHERE id = $1', [seeded.userId]);
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM exports WHERE plan_id = $1',
        [seeded.planId],
      );
      expect(rows[0]!.count).toBe('0');
    });

    it('countForPlan 数出该计划的导出次数（21.4 的既有计数）', async () => {
      const seeded = await seed();
      await repository.create(input(seeded, { idempotencyKey: 'd'.padEnd(64, '0') }));
      await repository.create(
        input(seeded, { format: 'PNG', idempotencyKey: 'e'.padEnd(64, '0') }),
      );

      expect(await repository.countForPlan(seeded.planId)).toBe(2);
    });
  });
});
