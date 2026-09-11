import {
  createPool,
  createUsersRepository,
  createTravelPlansRepository,
  createGenerationExecutionRepository,
  createPresentationsRepository,
  createCreditWalletRepository,
  migrate,
  migrationsDirectory,
  type GenerationLease,
} from '@tps/db';
import { LlmTimeoutError } from '@tps/llm';
import { createJobBilling, finalizeGenerationBilling } from './billing.js';
import * as billingModule from './billing.js';
import * as generation from './generate-plan.js';
import type { UsageSnapshot } from '@tps/billing';
import { makeValidContext } from '@tps/planning';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createE2eWorkerDeps } from './e2e-harness.js';
import { generatePlan, type GeneratePlanDeps } from './generate-plan.js';

const url = process.env['DATABASE_URL'];
const suite = url === undefined ? describe.skip : describe;
suite('生成恢复与用量（隔离 PostgreSQL，模型 fake）', () => {
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
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
  });
  async function submit() {
    const user = await createUsersRepository(pool).createRegistered({
      email: 'recovery@test.invalid',
      passwordHash: 'fake',
      displayName: null,
      dailyQuota: 50,
      monthlyQuota: 100,
    });
    const normalized = makeValidContext().normalized;
    const handles = await createTravelPlansRepository(pool).createGeneration({
      userId: user.id,
      clientRequestId: 'recovery',
      idempotencyKey: 'e'.repeat(64),
      rawRequest: {},
      normalizedRequest: normalized,
      destinationName: normalized.destination_name,
      destinationPlaceId: normalized.destination_place_id ?? null,
      startDate: normalized.start_date,
      endDate: normalized.end_date,
      totalDays: normalized.total_days,
      travelerCount: normalized.traveler_count,
      supersedeBefore: new Date(0),
    });
    return { ...handles, userId: user.id };
  }

  async function managed(
    payload: Awaited<ReturnType<typeof submit>>,
    attempt: number,
    decorate: (deps: GeneratePlanDeps, lease: GenerationLease) => GeneratePlanDeps = (deps) => deps,
  ) {
    const repository = createGenerationExecutionRepository(pool);
    const claim = await repository.claim(payload.jobId, attempt);
    if (claim.kind !== 'acquired') throw new Error(`无法领取：${claim.kind}`);
    const base = createE2eWorkerDeps(pool);
    return generatePlan(
      decorate(
        {
          ...base,
          plans: createTravelPlansRepository(pool, claim.lease),
          presentation: {
            ...base.presentation!,
            presentations: createPresentationsRepository(pool, claim.lease),
          },
          billing: createJobBilling({
            wallet: createCreditWalletRepository(pool),
            logger: base.logger,
          }),
          execution: {
            repository,
            lease: claim.lease,
            firstAttempt: claim.firstAttempt,
            attempt,
            attempts: 3,
          },
        },
        claim.lease,
      ),
      payload,
    );
  }
  async function reserve(payload: Awaited<ReturnType<typeof submit>>) {
    const wallet = createCreditWalletRepository(pool);
    await wallet.credit({
      userId: payload.userId,
      amountCr: 1000,
      kind: 'GRANT',
      idempotencyKey: `seed:${payload.jobId}`,
    });
    await wallet.reserve({
      userId: payload.userId,
      jobId: payload.jobId,
      amountCr: 100,
      priceVersion: 1,
      expiresAt: new Date(Date.now() + 7200000),
    });
    return wallet;
  }
  it('消费入口遇到活跃租约返回延迟信号，不执行模型或消耗业务尝试', async () => {
    expect(generation).toHaveProperty('consumeGeneration');
    const payload = await submit();
    const repository = createGenerationExecutionRepository(pool);
    await repository.claim(payload.jobId, 1);
    const base = createE2eWorkerDeps(pool);
    const result = await generation.consumeGeneration(
      {
        repository,
        logger: base.logger,
        createDeps: () => {
          throw new Error('冲突时不能构造模型依赖');
        },
      },
      payload,
      { attempt: 2, attempts: 3 },
    );
    expect(result).toEqual({ outcome: 'busy' });
    expect(
      (await pool.query('SELECT attempt_count FROM generation_jobs WHERE id = $1', [payload.jobId]))
        .rows[0].attempt_count,
    ).toBe(1);
  });
  it('成功后结算故障保留终态和快照，重复收尾只产生一笔消费', async () => {
    const payload = await submit();
    const wallet = await reserve(payload);
    await expect(
      managed(payload, 1, (deps) => ({
        ...deps,
        billing: {
          ...deps.billing!,
          settle: () => Promise.reject(new Error('模拟账务数据库故障')),
        },
      })),
    ).rejects.toThrow('模拟账务数据库故障');
    const repository = createGenerationExecutionRepository(pool);
    expect(await repository.read(payload.jobId)).toMatchObject({
      status: 'COMPLETED',
      finalizationPending: true,
    });
    expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'ACTIVE' });
    const billing = createJobBilling({ wallet, logger: createE2eWorkerDeps(pool).logger });
    await finalizeGenerationBilling(repository, billing, payload.jobId);
    await finalizeGenerationBilling(repository, billing, payload.jobId);
    expect(await repository.pendingFinalizations()).toEqual([]);
    expect(
      (await wallet.history({ userId: payload.userId, limit: 100 })).filter(
        (row) => row.kind === 'SPEND',
      ),
    ).toHaveLength(1);
  });
  it('最终失败恢复扫描账务故障后下轮继续，成功释放且不再启动模型', async () => {
    expect(billingModule).toHaveProperty('recoverGenerationBilling');
    const payload = await submit();
    const wallet = await reserve(payload);
    const repository = createGenerationExecutionRepository(pool);
    const logger = createE2eWorkerDeps(pool).logger;
    const billing = createJobBilling({ wallet, logger });
    const failedJobs = [{ jobId: payload.jobId, errorCode: 'PLAN_LLM_TIMEOUT' }];
    await billingModule.recoverGenerationBilling({
      repository,
      logger,
      failedJobs,
      billing: {
        ...billing,
        release: () => Promise.reject(new Error('模拟退款故障')),
      },
    });
    expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'ACTIVE' });
    expect(await repository.pendingFinalizations()).toEqual([payload.jobId]);
    await billingModule.recoverGenerationBilling({ repository, logger, failedJobs: [], billing });
    expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'RELEASED' });
    expect(await repository.pendingFinalizations()).toEqual([]);
  });
  it('展示提交成功但确认抛错，最终失败仍保留已确认页数', async () => {
    const payload = await submit();
    const outcome = await managed(payload, 3, (deps) => ({
      ...deps,
      presentation: {
        ...deps.presentation!,
        presentations: {
          ...deps.presentation!.presentations,
          savePresentations: async (rows, checkpoint) => {
            await deps.presentation!.presentations.savePresentations(rows, checkpoint);
            throw new Error('模拟提交后连接中断');
          },
        },
      },
    }));
    expect(outcome).toMatchObject({ outcome: 'failed' });
    const pages = (await pool.query('SELECT count(*)::int AS count FROM plan_presentations'))
      .rows[0].count;
    expect(pages).toBeGreaterThan(0);
    const state = await createGenerationExecutionRepository(pool).read(payload.jobId);
    expect(state?.usage.renderPages).toBe(pages);
  });
  it('文本模型返回时租约已失效，不能继续向量化或写产物', async () => {
    const payload = await submit();
    let embedded = false;
    await expect(
      managed(payload, 1, (deps) => ({
        ...deps,
        llm: async (request, context) => {
          const client =
            typeof deps.llm === 'function' ? await deps.llm(request, context) : deps.llm;
          return {
            ...client,
            model: client.model,
            complete: async (input) => {
              const result = await client.complete(input);
              await pool.query(
                "UPDATE generation_jobs SET execution_expires_at = NOW() - interval '1 second' WHERE id = $1",
                [payload.jobId],
              );
              return result;
            },
          };
        },
        embedding: {
          ...deps.embedding,
          embed: () => {
            embedded = true;
            return Promise.resolve([]);
          },
        },
      })),
    ).rejects.toThrow('GENERATION_LEASE_LOST');
    expect(embedded).toBe(false);
    expect(
      (await pool.query('SELECT id FROM travel_plan_versions WHERE plan_id = $1', [payload.planId]))
        .rows,
    ).toEqual([]);
  });
  it('长模型调用期间续租，用户取消后不发布产物并完成退款', async () => {
    const payload = await submit();
    const wallet = await reserve(payload);
    const repository = createGenerationExecutionRepository(pool);
    const base = createE2eWorkerDeps(pool);
    const billing = createJobBilling({ wallet, logger: base.logger });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const work = generation.consumeGeneration(
      {
        repository,
        billing,
        logger: base.logger,
        createDeps: (lease) => ({
          ...base,
          billing,
          plans: createTravelPlansRepository(pool, lease),
          presentation: {
            ...base.presentation!,
            presentations: createPresentationsRepository(pool, lease),
          },
          llm: async (request, context) => {
            entered();
            await barrier;
            return typeof base.llm === 'function' ? base.llm(request, context) : base.llm;
          },
        }),
      },
      payload,
      { attempt: 1, attempts: 3 },
    );
    try {
      await started;
      const initial = (
        await pool.query('SELECT execution_expires_at FROM generation_jobs WHERE id = $1', [
          payload.jobId,
        ])
      ).rows[0].execution_expires_at as Date;
      await vi.waitFor(
        async () => {
          const renewed = (
            await pool.query('SELECT execution_expires_at FROM generation_jobs WHERE id = $1', [
              payload.jobId,
            ])
          ).rows[0].execution_expires_at as Date;
          expect(renewed.getTime()).toBeGreaterThan(initial.getTime() + 5000);
        },
        { timeout: 13000, interval: 100 },
      );
      await createTravelPlansRepository(pool).cancelJob(payload.jobId, payload.userId);
      unblock();
      expect(await work).toMatchObject({ outcome: 'skipped' });
      expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'RELEASED' });
      expect(await repository.read(payload.jobId)).toMatchObject({ status: 'CANCELLED' });
      expect(
        (
          await pool.query('SELECT id FROM travel_plan_versions WHERE plan_id = $1', [
            payload.planId,
          ])
        ).rows,
      ).toEqual([]);
    } finally {
      unblock();
      await work;
    }
  }, 20000);
  it('首败保留预留和待重试状态，第二次成功只结算一次', async () => {
    const payload = await submit();
    const wallet = await reserve(payload);
    expect(
      await managed(payload, 1, (deps) => ({
        ...deps,
        llm: () => {
          throw new LlmTimeoutError(1);
        },
      })),
    ).toMatchObject({ outcome: 'failed' });
    expect(await createTravelPlansRepository(pool).findJobContext(payload.jobId)).toMatchObject({
      status: 'QUEUED',
    });
    expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'ACTIVE' });
    expect(await managed(payload, 2)).toMatchObject({ outcome: 'saved' });
    expect(
      await createTravelPlansRepository(pool).findJobForUser(payload.jobId, payload.userId),
    ).toMatchObject({ status: 'COMPLETED', errorCode: null });
    expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'SETTLED' });
    expect(
      (await wallet.history({ userId: payload.userId, limit: 100 })).filter(
        (row) => row.kind === 'SPEND',
      ),
    ).toHaveLength(1);
  });
  it.each(['t1', 'warnings', 't2'] as const)(
    '版本保存后 %s 异常重试复用版本和确认用量',
    async (point) => {
      const payload = await submit();
      await managed(payload, 1, (deps) => ({
        ...deps,
        plans: {
          ...deps.plans,
          markMilestone: async (id, milestone) => {
            if (milestone === point) throw new Error('模拟里程碑故障');
            return deps.plans.markMilestone(id, milestone);
          },
          appendJobWarnings: async (id, codes) => {
            if (point === 'warnings') throw new Error('模拟告警故障');
            return deps.plans.appendJobWarnings(id, codes);
          },
        },
      }));
      const repository = createGenerationExecutionRepository(pool);
      const before = await repository.read(payload.jobId);
      expect(before?.status).toBe('QUEUED');
      expect(before?.checkpoint?.versionId).toBeTruthy();
      const outcome = await managed(payload, 2, (deps) => ({
        ...deps,
        llm: () => {
          throw new Error('恢复不得再构造文本模型');
        },
        ...(point === 't1'
          ? {}
          : {
              aiAssets: () => {
                throw new Error('恢复不得重新生成素材');
              },
            }),
      }));
      expect(outcome).toMatchObject({ outcome: 'saved', versionId: before!.checkpoint!.versionId });
      expect(
        (
          await pool.query('SELECT id FROM travel_plan_versions WHERE plan_id = $1', [
            payload.planId,
          ])
        ).rows,
      ).toHaveLength(1);
      const after = await repository.read(payload.jobId);
      expect(after?.status).toBe('COMPLETED');
      expect(after?.usage.llmInputTokens).toEqual(before?.usage.llmInputTokens);
      if (point !== 't1') expect(after?.usage).toEqual(before?.usage);
      expect(after?.usage.renderPages).toBeGreaterThan(0);
    },
  );
  it('重试耗尽等待退款完成，终态重复调用不重新生成', async () => {
    const payload = await submit();
    const wallet = await reserve(payload);
    await managed(payload, 3, (deps) => ({
      ...deps,
      llm: () => {
        throw new LlmTimeoutError(1);
      },
    }));
    expect(await createTravelPlansRepository(pool).findJobContext(payload.jobId)).toMatchObject({
      status: 'FAILED',
    });
    expect(await wallet.findHold(payload.jobId)).toMatchObject({ status: 'RELEASED' });
    expect(await wallet.balance(payload.userId)).toEqual({ balanceCr: 1000, heldCr: 0 });
    expect(
      await generatePlan(
        {
          ...createE2eWorkerDeps(pool),
          llm: () => {
            throw new Error('不得调用');
          },
        },
        payload,
      ),
    ).toMatchObject({ outcome: 'skipped', reason: 'already_terminal' });
  });

  it.each(['warnings', 't2', 'completed'] as const)(
    '素材保存后 %s 写入抛错，用量不重复累加且保留已保存页数',
    async (point) => {
      const payload = await submit();
      const deps = createE2eWorkerDeps(pool);
      let images = 0;
      let billingReadImages = () => 0;
      let usage: UsageSnapshot | undefined;
      await generatePlan(
        {
          ...deps,
          aiAssets: async (context) => {
            const ai = await deps.aiAssets!(context);
            // 保留真实预算与素材管线，仅在最终结算时读取实际成功张数。
            billingReadImages = () => ai.budget.used.images;
            return ai;
          },
          plans: {
            ...deps.plans,
            appendJobWarnings: async (jobId, codes) => {
              if (point === 'warnings') throw new Error('模拟告警持久化故障');
              return deps.plans.appendJobWarnings(jobId, codes);
            },
            markMilestone: async (jobId, milestone) => {
              if (point === 't2' && milestone === 't2') throw new Error('模拟里程碑持久化故障');
              return deps.plans.markMilestone(jobId, milestone);
            },
            updateJobState: async (input) => {
              if (point === 'completed' && input.to === 'COMPLETED')
                throw new Error('模拟终态持久化故障');
              return deps.plans.updateJobState(input);
            },
          },
          billing: {
            settle: (input) => {
              usage = input.usage;
              images = billingReadImages();
              return Promise.resolve();
            },
            release: (input) => {
              usage = input.usage;
              images = billingReadImages();
              return Promise.resolve();
            },
            priceOf: (input) => {
              usage = input.usage;
              images = billingReadImages();
              return Promise.resolve(null);
            },
          },
        },
        payload,
      );
      const pages = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM plan_presentations',
      );
      expect(images).toBeGreaterThan(0);
      expect(usage?.aiImages).toBe(images);
      expect(usage?.renderPages).toBe(pages.rows[0]!.count);
      expect(usage?.renderPages).toBeGreaterThan(0);
    },
  );
});
