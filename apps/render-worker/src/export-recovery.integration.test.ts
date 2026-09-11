import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { createQueueRedis } from '@tps/queue';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Browser } from 'playwright-core';
import {
  createPool,
  createUsersRepository,
  createTravelPlansRepository,
  createExportsRepository,
  createExportExecutionRepository,
  createCreditWalletRepository,
  migrate,
  migrationsDirectory,
} from '@tps/db';
import { InMemoryExportStorage } from '@tps/storage';
import { createSilentLogger } from '@tps/shared';
import { runExport, type RunExportDeps } from './run-export.js';
import * as exportsModule from './run-export.js';

// 仅替换 Chromium 页面边界；PNG 压缩、上传、预签名、数据库和钱包均走真实实现。
const pageState = vi.hoisted<{ png: Buffer; failedDay: string; renders: number }>(() => ({
  png: Buffer.alloc(0),
  failedDay: '',
  renders: 0,
}));
vi.mock('./render-page.js', () => ({
  renderPage: (input: { path: string }) => {
    pageState.renders += 1;
    if (pageState.failedDay && input.path.endsWith(pageState.failedDay))
      return Promise.reject(new Error('页面失败'));
    return Promise.resolve({
      page: { screenshot: () => Promise.resolve(pageState.png), close: async () => {} },
      round: 0,
      degraded: false,
      missingIcons: [],
      images: { total: 0, broken: 0 },
    });
  },
}));
const url = process.env['DATABASE_URL'];
const suite = url === undefined ? describe.skip : describe;
suite('导出尝试恢复（隔离 PostgreSQL，Chromium 页面 fake）', () => {
  let pool: ReturnType<typeof createPool>;
  beforeAll(async () => {
    pool = createPool({
      connectionString: url!,
      maxConnections: 8,
      idleTimeoutMs: 5000,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 15000,
    });
    await migrate(pool, migrationsDirectory());
    pageState.png = await sharp({
      create: { width: 2400, height: 2, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    pageState.failedDay = '';
    pageState.renders = 0;
  });
  afterAll(async () => pool.end());
  async function setup() {
    const user = await createUsersRepository(pool).createRegistered({
      email: 'export@test.invalid',
      passwordHash: 'fake',
      displayName: null,
      dailyQuota: 50,
      monthlyQuota: 100,
    });
    const plans = createTravelPlansRepository(pool);
    const plan = await plans.createGeneration({
      userId: user.id,
      clientRequestId: 'export',
      idempotencyKey: 'e'.repeat(64),
      rawRequest: {},
      normalizedRequest: {},
      destinationName: '杭州',
      destinationPlaceId: null,
      startDate: '2026-04-10',
      endDate: '2026-04-11',
      totalDays: 2,
      travelerCount: 1,
      supersedeBefore: new Date(0),
    });
    const versionId = randomUUID();
    await plans.savePlanVersion({
      versionId,
      planId: plan.planId,
      status: 'READY',
      planJson: {},
      constraintReport: {},
      retrievalProjection: {},
      destinationPlaceId: null,
      totalDays: 2,
      planEmbedding: null,
      title: '测试',
      llmModel: 'fake',
      llmPromptVersion: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      repairIterations: 0,
      regenerationCount: 0,
    });
    const exports = createExportsRepository(pool);
    const row = await exports.create({
      exportId: randomUUID(),
      userId: user.id,
      planId: plan.planId,
      planVersionId: versionId,
      templateId: 'ink_paper_v1',
      format: 'PNG',
      scope: 'ALL_DAYS',
      dayNumbers: null,
      idempotencyKey: 'f'.repeat(64),
    });
    const wallet = createCreditWalletRepository(pool);
    await wallet.credit({ userId: user.id, amountCr: 1000, kind: 'GRANT', idempotencyKey: 'seed' });
    await wallet.charge({
      userId: user.id,
      amountCr: 37,
      idempotencyKey: 'charge',
      refType: 'EXPORT',
      refId: row.exportId,
      priceVersion: 1,
    });
    const storage = new InMemoryExportStorage();
    const execution = createExportExecutionRepository(pool, true);
    const deps: RunExportDeps = {
      exports,
      execution,
      storage,
      presentations: { listDayNumbers: () => Promise.resolve([1, 2]) },
      browser: {
        newContext: () => Promise.resolve({ close: async () => {} }),
      } as unknown as Browser,
      baseUrl: 'http://web:3000',
      signingKey: 'test-key',
      logger: createSilentLogger(),
    };
    return { user, row, wallet, storage, deps, execution };
  }
  it.each(['context-create', 'context-close', 'upload', 'presign', 'finish'] as const)(
    '%s 异常首败回 QUEUED 且不退款，重试成功只发布本次产物',
    async (point) => {
      const { user, row, wallet, storage, deps } = await setup();
      const broken: RunExportDeps = {
        ...deps,
        browser: {
          newContext: () => {
            if (point === 'context-create') return Promise.reject(new Error('context create'));
            return Promise.resolve({
              close: () =>
                point === 'context-close'
                  ? Promise.reject(new Error('context close'))
                  : Promise.resolve(),
            });
          },
        } as unknown as Browser,
        storage: {
          put: async (input) => {
            await storage.put(input);
            if (point === 'upload') throw new Error('upload');
          },
          presign: async (key, ttl) => {
            if (point === 'presign') throw new Error('presign');
            return storage.presign(key, ttl);
          },
          delete: (keys) => storage.delete(keys),
        },
        execution: {
          ...deps.execution,
          finish: async (lease, input) => {
            if (point === 'finish' && input.status !== 'FAILED') throw new Error('finish');
            return deps.execution.finish(lease, input);
          },
        },
      };
      expect(await runExport(broken, row.exportId, { attempt: 1, attempts: 2 })).toMatchObject({
        kind: 'failed',
      });
      expect(await deps.exports.findById(row.exportId)).toMatchObject({
        status: 'QUEUED',
        progress: 50,
      });
      expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 963 });
      const previousKeys = [...storage.objects.keys()];
      expect(await runExport(deps, row.exportId, { attempt: 2, attempts: 2 })).toMatchObject({
        kind: 'completed',
      });
      const completed = await deps.exports.findById(row.exportId);
      expect(completed).toMatchObject({ status: 'COMPLETED', errorCode: null });
      const files = completed!.files as { storage_key: string }[];
      expect(files).toHaveLength(3);
      expect(files.every((file) => !previousKeys.includes(file.storage_key))).toBe(true);
      expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 963 });
      const renders = pageState.renders;
      expect(await runExport(deps, row.exportId, { attempt: 2, attempts: 2 })).toMatchObject({
        kind: 'skipped',
      });
      expect(pageState.renders).toBe(renders);
    },
  );
  it('提交成功但响应丢失不能退款或清理已发布产物', async () => {
    const { row, user, wallet, deps, execution, storage } = await setup();
    const outcome = await runExport(
      {
        ...deps,
        execution: {
          ...execution,
          finish: async (lease, input) => {
            await execution.finish(lease, input);
            throw new Error('提交响应丢失');
          },
        },
      },
      row.exportId,
    );
    expect(outcome).toMatchObject({ kind: 'skipped' });
    const completed = await deps.exports.findById(row.exportId);
    expect(completed).toMatchObject({ status: 'COMPLETED' });
    await exportsModule.recoverExports({ execution, storage, logger: deps.logger, failedJobs: [] });
    const files = completed!.files as { storage_key: string }[];
    expect(files).toHaveLength(3);
    expect(files.every((file) => storage.objects.has(file.storage_key))).toBe(true);
    expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 963 });
    expect(
      (await pool.query("SELECT entry_id FROM credit_ledger WHERE kind = 'REFUND'")).rows,
    ).toHaveLength(0);
  });

  it('长浏览器调用期间每十秒续租，重复领取仍为 busy', async () => {
    const { row, deps, execution } = await setup();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runExport(
      {
        ...deps,
        browser: async () => {
          entered();
          await barrier;
          return typeof deps.browser === 'function' ? deps.browser() : deps.browser;
        },
      },
      row.exportId,
    );
    try {
      await started;
      const initial = await pool.query<{ execution_expires_at: Date }>(
        'SELECT execution_expires_at FROM exports WHERE id = $1',
        [row.exportId],
      );
      await vi.waitFor(
        async () => {
          const current = await pool.query<{ execution_expires_at: Date }>(
            'SELECT execution_expires_at FROM exports WHERE id = $1',
            [row.exportId],
          );
          expect(current.rows[0]!.execution_expires_at.getTime()).toBeGreaterThan(
            initial.rows[0]!.execution_expires_at.getTime() + 5000,
          );
        },
        { timeout: 12500, interval: 100 },
      );
      expect(await execution.claim(row.exportId, 2)).toEqual({ kind: 'busy' });
      release();
      expect(await running).toMatchObject({ kind: 'completed' });
    } finally {
      release();
      await running;
    }
  }, 18000);

  it('上传后签名失败，清理故障下轮继续且不删除新尝试已发布产物', async () => {
    expect(exportsModule).toHaveProperty('recoverExports');
    const { row, storage, deps, execution } = await setup();
    const broken = {
      ...deps,
      storage: {
        put: storage.put.bind(storage),
        delete: storage.delete.bind(storage),
        presign: () => Promise.reject(new Error('签名失败')),
      },
    };
    await runExport(broken, row.exportId, { attempt: 1, attempts: 2 });
    const oldKeys = [...storage.objects.keys()];
    expect(oldKeys).toHaveLength(1);
    await runExport(deps, row.exportId, { attempt: 2, attempts: 2 });
    const files = (await deps.exports.findById(row.exportId))!.files as { storage_key: string }[];
    await exportsModule.recoverExports({
      execution,
      logger: deps.logger,
      storage: {
        ...broken.storage,
        delete: () => Promise.reject(new Error('存储删除故障')),
      },
      failedJobs: [],
    });
    expect(oldKeys.every((key) => storage.objects.has(key))).toBe(true);
    await exportsModule.recoverExports({ execution, logger: deps.logger, storage, failedJobs: [] });
    expect(oldKeys.every((key) => !storage.objects.has(key))).toBe(true);
    expect(files.every((file) => storage.objects.has(file.storage_key))).toBe(true);
  });

  it('旧执行上传阻塞时被接管，迟到产物不能覆盖新文件', async () => {
    const { row, storage, deps, execution } = await setup();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let oldKey = '';
    const stale = runExport(
      {
        ...deps,
        storage: {
          put: async (input) => {
            oldKey = input.key;
            entered();
            await barrier;
            await storage.put(input);
          },
          presign: storage.presign.bind(storage),
          delete: storage.delete.bind(storage),
        },
      },
      row.exportId,
      { attempt: 1, attempts: 2 },
    );
    try {
      await started;
      await pool.query(
        "UPDATE exports SET execution_expires_at = NOW() - interval '1 second' WHERE id = $1",
        [row.exportId],
      );
      expect(await runExport(deps, row.exportId, { attempt: 2, attempts: 2 })).toMatchObject({
        kind: 'completed',
      });
      release();
      await stale;
      const files = (await deps.exports.findById(row.exportId))!.files as { storage_key: string }[];
      expect(files.every((file) => file.storage_key !== oldKey)).toBe(true);
      await exportsModule.recoverExports({
        execution,
        logger: deps.logger,
        storage,
        failedJobs: [],
      });
      expect(storage.objects.has(oldKey)).toBe(false);
      expect(files.every((file) => storage.objects.has(file.storage_key))).toBe(true);
    } finally {
      release();
      await stale;
    }
  });

  it.skipIf(process.env['REDIS_URL'] === undefined).each(['retry', 'exhausted', 'busy'] as const)(
    '真实 BullMQ %s：尝试计数、终态与退款一致',
    async (scenario) => {
      expect(exportsModule).toHaveProperty('processExportJob');
      const { row, user, wallet, deps, execution } = await setup();
      const connection = createQueueRedis(process.env['REDIS_URL']!);
      const name = `p1-export-${randomUUID()}`;
      const queue = new Queue(name, { connection });
      const events = new QueueEvents(name, { connection });
      let calls = 0;
      if (scenario === 'busy') await execution.claim(row.exportId, 1);
      const worker = new Worker(
        name,
        (job, token) =>
          exportsModule.processExportJob(
            {
              ...deps,
              browser: async () => {
                calls += 1;
                if (scenario === 'exhausted' || (scenario === 'retry' && calls === 1))
                  throw new Error('浏览器崩溃');
                return typeof deps.browser === 'function' ? deps.browser() : deps.browser;
              },
            },
            job,
            token,
          ),
        { connection },
      );
      try {
        await events.waitUntilReady();
        await worker.waitUntilReady();
        const job = await queue.add(
          'export',
          { exportId: row.exportId },
          {
            jobId: row.exportId,
            attempts: 2,
            backoff: { type: 'exponential', delay: 20 },
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
        if (scenario === 'busy') {
          await vi.waitFor(async () => expect(await job.getState()).toBe('delayed'), {
            timeout: 5000,
          });
          expect((await queue.getJob(job.id!))?.attemptsMade).toBe(0);
          expect(calls).toBe(0);
          await pool.query(
            "UPDATE exports SET execution_expires_at = NOW() - interval '1 second' WHERE id = $1",
            [row.exportId],
          );
        }
        if (scenario === 'exhausted') {
          await expect(job.waitUntilFinished(events, 10000)).rejects.toThrow('EXPORT_PNG_FAILED');
          expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 1000 });
          expect(await deps.exports.findById(row.exportId)).toMatchObject({ status: 'FAILED' });
        } else {
          await job.waitUntilFinished(events, 10000);
          expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 963 });
          expect(await deps.exports.findById(row.exportId)).toMatchObject({ status: 'COMPLETED' });
        }
        expect((await queue.getJob(job.id!))?.attemptsMade).toBe(scenario === 'busy' ? 1 : 2);
      } finally {
        await worker.close();
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    },
    20000,
  );

  it('队列最终失败原因超长时仍能恢复 FAILED 并只退款一次', async () => {
    const { row, user, wallet, deps, execution, storage } = await setup();
    const failedJobs = [{ exportId: row.exportId, errorCode: '数据库连接失败'.repeat(20) }];
    await exportsModule.recoverExports({ execution, storage, logger: deps.logger, failedJobs });
    expect(await deps.exports.findById(row.exportId)).toMatchObject({ status: 'FAILED' });
    expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 1000 });
    await exportsModule.recoverExports({ execution, storage, logger: deps.logger, failedJobs });
    expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 1000 });
    expect(
      (await pool.query("SELECT entry_id FROM credit_ledger WHERE kind = 'REFUND'")).rows,
    ).toHaveLength(1);
  });

  it('PARTIAL 不退款', async () => {
    const { user, row, wallet, deps } = await setup();
    pageState.failedDay = '/2';
    expect(await runExport(deps, row.exportId, { attempt: 1, attempts: 2 })).toMatchObject({
      kind: 'partial',
    });
    expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 963 });
    expect(await deps.exports.findById(row.exportId)).toMatchObject({ status: 'PARTIAL' });
  });
  it('两次全失败后退款，终态重复投递不再渲染', async () => {
    const { user, row, wallet, deps } = await setup();
    const broken = {
      ...deps,
      browser: {
        newContext: () => Promise.reject(new Error('crashed')),
      } as unknown as Browser,
    };
    await runExport(broken, row.exportId, { attempt: 1, attempts: 2 });
    expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 963 });
    await runExport(broken, row.exportId, { attempt: 2, attempts: 2 });
    expect(await deps.exports.findById(row.exportId)).toMatchObject({ status: 'FAILED' });
    expect(await wallet.balance(user.id)).toMatchObject({ balanceCr: 1000 });
    expect(await runExport(deps, row.exportId, { attempt: 3, attempts: 2 })).toMatchObject({
      kind: 'skipped',
    });
    expect(pageState.renders).toBe(0);
  });
});
