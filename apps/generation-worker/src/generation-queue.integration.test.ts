import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPool,
  createUsersRepository,
  createTravelPlansRepository,
  createPresentationsRepository,
  createGenerationExecutionRepository,
  createCreditWalletRepository,
  migrate,
  migrationsDirectory,
} from '@tps/db';
import { makeValidContext } from '@tps/planning';
import { createQueueRedis } from '@tps/queue';
import { LlmTimeoutError } from '@tps/llm';
import * as generation from './generate-plan.js';
import { createE2eWorkerDeps } from './e2e-harness.js';
import { createJobBilling } from './billing.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const suite = databaseUrl !== undefined && redisUrl !== undefined ? describe : describe.skip;
suite('生成执行真实 BullMQ 重试（隔离 PostgreSQL/Redis）', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl!,
      maxConnections: 8,
      idleTimeoutMs: 5000,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 15000,
    });
    await migrate(pool, migrationsDirectory());
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
  });
  afterAll(async () => pool.end());

  it.each(['retry', 'exhausted', 'busy'] as const)(
    '%s：队列结果、业务尝试和钱包保持一致',
    async (scenario) => {
      expect(generation).toHaveProperty('processGenerationJob');
      const user = await createUsersRepository(pool).createRegistered({
        email: 'queue@test.invalid',
        passwordHash: 'fake',
        displayName: null,
        dailyQuota: 50,
        monthlyQuota: 100,
      });
      const normalized = makeValidContext().normalized;
      const handles = await createTravelPlansRepository(pool).createGeneration({
        userId: user.id,
        clientRequestId: 'queue',
        idempotencyKey: 'a'.repeat(64),
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
      const payload = { ...handles, userId: user.id };
      const repository = createGenerationExecutionRepository(pool);
      const wallet = createCreditWalletRepository(pool);
      await wallet.credit({
        userId: user.id,
        amountCr: 1000,
        kind: 'GRANT',
        idempotencyKey: `seed:${handles.jobId}`,
      });
      await wallet.reserve({
        userId: user.id,
        jobId: handles.jobId,
        amountCr: 100,
        priceVersion: 1,
        expiresAt: new Date(Date.now() + 7200000),
      });
      const base = createE2eWorkerDeps(pool);
      const billing = createJobBilling({ wallet, logger: base.logger });
      if (scenario === 'busy') await repository.claim(handles.jobId, 1);
      const connection = createQueueRedis(redisUrl!);
      const queueName = `p1-generation-${randomUUID()}`;
      const queue = new Queue(queueName, { connection });
      const events = new QueueEvents(queueName, { connection });
      let modelAttempts = 0;
      const worker = new Worker(
        queueName,
        (job, token) =>
          generation.processGenerationJob(
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
                  modelAttempts += 1;
                  if (scenario === 'exhausted' || (scenario === 'retry' && modelAttempts === 1))
                    throw new LlmTimeoutError(1);
                  return typeof base.llm === 'function' ? base.llm(request, context) : base.llm;
                },
              }),
            },
            job,
            token,
          ),
        { connection },
      );
      try {
        await events.waitUntilReady();
        await worker.waitUntilReady();
        const job = await queue.add('generate', payload, {
          jobId: handles.jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 20 },
          removeOnComplete: false,
          removeOnFail: false,
        });
        if (scenario === 'busy') {
          await vi.waitFor(async () => expect(await job.getState()).toBe('delayed'), {
            timeout: 5000,
          });
          const deferred = await queue.getJob(job.id!);
          expect(deferred?.attemptsMade).toBe(0);
          expect(modelAttempts).toBe(0);
          expect(await wallet.findHold(handles.jobId)).toMatchObject({ status: 'ACTIVE' });
          await pool.query(
            "UPDATE generation_jobs SET execution_expires_at = NOW() - interval '1 second' WHERE id = $1",
            [handles.jobId],
          );
        }
        if (scenario === 'exhausted') {
          await expect(job.waitUntilFinished(events, 10000)).rejects.toThrow('PLAN_LLM_TIMEOUT');
          expect(await repository.read(handles.jobId)).toMatchObject({
            status: 'FAILED',
            finalizationPending: false,
          });
          expect(await wallet.findHold(handles.jobId)).toMatchObject({ status: 'RELEASED' });
          expect(await wallet.balance(user.id)).toEqual({ balanceCr: 1000, heldCr: 0 });
          expect((await queue.getJob(job.id!))?.attemptsMade).toBe(3);
        } else {
          await job.waitUntilFinished(events, 10000);
          expect(await repository.read(handles.jobId)).toMatchObject({
            status: 'COMPLETED',
            finalizationPending: false,
          });
          expect(await wallet.findHold(handles.jobId)).toMatchObject({ status: 'SETTLED' });
          expect(
            (
              await pool.query('SELECT id FROM travel_plan_versions WHERE plan_id = $1', [
                handles.planId,
              ])
            ).rows,
          ).toHaveLength(1);
          expect((await queue.getJob(job.id!))?.attemptsMade).toBe(scenario === 'retry' ? 2 : 1);
        }
      } finally {
        await worker.close();
        await events.close();
        // 只清理由本用例创建的独立队列，不碰其他测试或应用队列。
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    },
    20000,
  );
});
