import { randomUUID } from 'node:crypto';
import * as execution from './generation-execution.js';
import type { Pool } from 'pg';
import { EMPTY_USAGE } from '@tps/billing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createUsersRepository,
  createTravelPlansRepository,
  createPresentationsRepository,
  migrate,
  migrationsDirectory,
} from './index.js';

const url = process.env['DATABASE_URL'];
const suite = url === undefined ? describe.skip : describe;
suite('生成执行 fencing 与检查点（隔离 PostgreSQL）', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool({
      connectionString: url!,
      maxConnections: 8,
      idleTimeoutMs: 5000,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 15000,
    });
    await migrate(pool, migrationsDirectory());
  });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await pool.query('DELETE FROM users');
  });
  async function submit() {
    const user = await createUsersRepository(pool).createRegistered({
      email: 'lease@test.invalid',
      passwordHash: 'fake',
      displayName: null,
      dailyQuota: 50,
      monthlyQuota: 100,
    });
    return createTravelPlansRepository(pool).createGeneration({
      userId: user.id,
      clientRequestId: 'lease',
      idempotencyKey: 'f'.repeat(64),
      rawRequest: {},
      normalizedRequest: {},
      destinationName: '杭州',
      destinationPlaceId: null,
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      totalDays: 1,
      travelerCount: 1,
      supersedeBefore: new Date(0),
    });
  }
  it('未持有有效 token 的执行不能推进任务', async () => {
    const handles = await submit();
    const scoped = createTravelPlansRepository(pool, { jobId: handles.jobId, token: randomUUID() });
    expect(
      await scoped.updateJobState({
        jobId: handles.jobId,
        to: 'GENERATING_PLAN',
        progress: 30,
        message: null,
      }),
    ).toBe(false);
    const job = await createTravelPlansRepository(pool).findJobContext(handles.jobId);
    expect(job?.status).toBe('QUEUED');
  });
  it('双消费者互斥，过期接管后旧 token 不能续期、重试或写入', async () => {
    expect(execution).toHaveProperty('createGenerationExecutionRepository');
    const handles = await submit();
    const repository = execution.createGenerationExecutionRepository(pool);
    const claims = await Promise.all([
      repository.claim(handles.jobId, 1),
      repository.claim(handles.jobId, 1),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(['acquired', 'busy']);
    const first = claims.find((claim) => claim.kind === 'acquired')!;
    if (first.kind !== 'acquired') throw new Error('未领取');
    expect(first.firstAttempt).toBe(true);
    const oldPlans = createTravelPlansRepository(pool, first.lease);
    expect(
      await oldPlans.updateJobState({
        jobId: handles.jobId,
        to: 'GENERATING_PLAN',
        progress: 40,
        message: null,
      }),
    ).toBe(true);
    await pool.query(
      "UPDATE generation_jobs SET execution_expires_at = NOW() - interval '1 second'",
    );
    const fresh = await repository.claim(handles.jobId, 2);
    if (fresh.kind !== 'acquired') throw new Error('未接管');
    expect(fresh.firstAttempt).toBe(false);
    expect(await repository.renew(first.lease)).toBe(false);
    expect(await repository.retry(first.lease, 'PLAN_LLM_TIMEOUT')).toBe(false);
    expect(
      await oldPlans.updateJobState({
        jobId: handles.jobId,
        to: 'COMPLETED',
        progress: 100,
        message: null,
      }),
    ).toBe(false);
    expect(await repository.retry(fresh.lease, 'PLAN_LLM_TIMEOUT')).toBe(true);
    const pending = await createTravelPlansRepository(pool).findJobContext(handles.jobId);
    expect(pending).toMatchObject({ status: 'QUEUED', progress: 40 });
    const last = await repository.claim(handles.jobId, 3);
    if (last.kind !== 'acquired') throw new Error('未领取最后尝试');
    expect(await repository.finish(last.lease, 'FAILED', EMPTY_USAGE, 'PLAN_LLM_TIMEOUT')).toBe(
      true,
    );
    expect(await repository.claim(handles.jobId, 4)).toMatchObject({ kind: 'terminal' });
    expect(await repository.retry(last.lease, 'PLAN_LLM_TIMEOUT')).toBe(false);
    expect(await repository.pendingFinalizations()).toEqual([handles.jobId]);
    await repository.markFinalized(handles.jobId);
    expect(await repository.pendingFinalizations()).toEqual([]);
  });
  it('取消撤销执行权限并留下可重试的账务收尾标记', async () => {
    const handles = await submit();
    const repository = execution.createGenerationExecutionRepository(pool);
    const claim = await repository.claim(handles.jobId, 1);
    if (claim.kind !== 'acquired') throw new Error('未领取');
    const context = await createTravelPlansRepository(pool).findJobContext(handles.jobId);
    await createTravelPlansRepository(pool).cancelJob(handles.jobId, context!.userId);
    expect(await repository.renew(claim.lease)).toBe(false);
    expect(await repository.finish(claim.lease, 'COMPLETED', EMPTY_USAGE)).toBe(false);
    expect(await repository.pendingFinalizations()).toEqual([handles.jobId]);
  });
  it('展示保存与确认用量同事务，旧 token 不可覆盖展示或素材绑定', async () => {
    const handles = await submit();
    const repository = execution.createGenerationExecutionRepository(pool);
    const claim = await repository.claim(handles.jobId, 1);
    if (claim.kind !== 'acquired') throw new Error('未领取');
    const versionId = randomUUID();
    await createTravelPlansRepository(pool, claim.lease).savePlanVersion({
      versionId,
      planId: handles.planId,
      status: 'READY',
      planJson: { title: '检查点' },
      constraintReport: {},
      retrievalProjection: {},
      destinationPlaceId: null,
      totalDays: 1,
      planEmbedding: null,
      title: '测试',
      llmModel: 'fake',
      llmPromptVersion: 'test',
      inputTokens: 10,
      outputTokens: 20,
      repairIterations: 0,
      regenerationCount: 0,
      checkpoint: { jobId: handles.jobId, usage: EMPTY_USAGE },
    });
    const presentations = createPresentationsRepository(pool, claim.lease);
    const row = {
      planId: handles.planId,
      planVersionId: versionId,
      templateId: 'test',
      pageType: 'FULL_PLAN' as const,
      dayNumber: null,
      viewModel: { saved: true },
      validationStatus: 'VALID' as const,
    };
    const usage = { ...EMPTY_USAGE, aiImages: 2, renderPages: 1 };
    const summary = {
      pages: 1,
      bindings: 2,
      validationStatus: 'VALID' as const,
      warnings: [],
      omitted: 0,
      budgetMismatch: false,
    };
    await presentations.savePresentations([row], {
      jobId: handles.jobId,
      usage,
      presentation: summary,
    });
    const stored = await pool.query(
      'SELECT usage_snapshot, presentation_checkpoint FROM generation_jobs WHERE id = $1',
      [handles.jobId],
    );
    expect(stored.rows[0]).toMatchObject({
      usage_snapshot: usage,
      presentation_checkpoint: summary,
    });
    expect(repository).toHaveProperty('read');
    expect(await repository.read(handles.jobId)).toMatchObject({
      usage,
      checkpoint: {
        versionId,
        planJson: { title: '检查点' },
        status: 'READY',
        presentation: summary,
      },
    });
    await pool.query(
      "UPDATE generation_jobs SET execution_expires_at = NOW() - interval '1 second'",
    );
    await expect(
      presentations.savePresentations([{ ...row, viewModel: { saved: false } }]),
    ).rejects.toThrow('GENERATION_LEASE_LOST');
    await expect(
      presentations.saveBindings([
        {
          planId: handles.planId,
          planVersionId: versionId,
          dayNumber: null,
          templateId: 'test',
          slotId: 'hero',
          role: 'HERO',
          assetId: randomUUID(),
          resolutionStrategy: 'AI',
          resolutionScore: 1,
        },
      ]),
    ).rejects.toThrow('GENERATION_LEASE_LOST');
    const rows = await pool.query('SELECT view_model FROM plan_presentations');
    expect(rows.rows).toEqual([{ view_model: { saved: true } }]);
    const fresh = await repository.claim(handles.jobId, 2);
    if (fresh.kind !== 'acquired') throw new Error('未接管');
    await expect(
      createPresentationsRepository(pool, fresh.lease).savePresentations(
        [{ ...row, viewModel: { saved: false } }],
        { jobId: randomUUID(), usage: EMPTY_USAGE, presentation: summary },
      ),
    ).rejects.toThrow('GENERATION_LEASE_LOST');
    expect((await pool.query('SELECT view_model FROM plan_presentations')).rows).toEqual(rows.rows);
  });
  it('最终失败补偿只收尾新协议的无活跃租约任务，不重放历史任务', async () => {
    const handles = await submit();
    const repository = execution.createGenerationExecutionRepository(pool);
    expect(repository).toHaveProperty('failAbandoned');
    const claim = await repository.claim(handles.jobId, 1);
    if (claim.kind !== 'acquired') throw new Error('未领取');
    expect(await repository.failAbandoned(handles.jobId, 'PLAN_LLM_TIMEOUT')).toBe(false);
    await pool.query(
      "UPDATE generation_jobs SET execution_expires_at = NOW() - interval '1 second'",
    );
    expect(await repository.failAbandoned(handles.jobId, 'PLAN_LLM_TIMEOUT')).toBe(true);
    expect(await repository.pendingFinalizations()).toEqual([handles.jobId]);
    await repository.markFinalized(handles.jobId);
    expect(await repository.failAbandoned(handles.jobId, 'PLAN_LLM_TIMEOUT')).toBe(false);
    expect(await repository.pendingFinalizations()).toEqual([]);
    await pool.query('DELETE FROM users');
    const legacy = await submit();
    await pool.query('UPDATE generation_jobs SET execution_protocol = 0');
    expect(await repository.failAbandoned(legacy.jobId, 'PLAN_LLM_TIMEOUT')).toBe(false);
    expect(await repository.claim(legacy.jobId, 1)).toMatchObject({ kind: 'legacy' });
    expect(await repository.read(legacy.jobId)).toMatchObject({ status: 'QUEUED' });
  });
  it('保存版本同时保存 job 引用、T1 与已确认用量', async () => {
    const handles = await submit();
    const versionId = randomUUID();
    const usage = { ...EMPTY_USAGE, aiImages: 2 };
    await createTravelPlansRepository(pool).savePlanVersion({
      versionId,
      planId: handles.planId,
      status: 'READY',
      planJson: {},
      constraintReport: {},
      retrievalProjection: {},
      destinationPlaceId: null,
      totalDays: 1,
      planEmbedding: null,
      title: '测试',
      llmModel: 'fake',
      llmPromptVersion: 'test',
      inputTokens: 10,
      outputTokens: 20,
      repairIterations: 0,
      regenerationCount: 0,
      checkpoint: { jobId: handles.jobId, usage },
    });
    const job = await pool.query(
      'SELECT plan_version_id, t1_at FROM generation_jobs WHERE id = $1',
      [handles.jobId],
    );
    expect(job.rows[0].plan_version_id).toBe(versionId);
    expect(job.rows[0].t1_at).toBeInstanceOf(Date);
    const stored = await pool.query('SELECT usage_snapshot FROM generation_jobs WHERE id = $1', [
      handles.jobId,
    ]);
    expect(stored.rows[0].usage_snapshot).toEqual(usage);
  });
});
