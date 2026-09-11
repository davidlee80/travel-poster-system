import type { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from './index.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import type { GenerationOutboxRepository } from './generation-outbox.js';

const url = process.env['DATABASE_URL'];
const suite = url === undefined ? describe.skip : describe;
suite('生成 Outbox（隔离 PostgreSQL）', () => {
  let pool: Pool;
  let outbox: GenerationOutboxRepository;
  beforeAll(async () => {
    pool = db.createPool({
      connectionString: url!,
      maxConnections: 5,
      idleTimeoutMs: 5000,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 15000,
    });
    await migrate(pool, migrationsDirectory());
  });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    expect(db).toHaveProperty('createGenerationOutboxRepository');
    outbox = db.createGenerationOutboxRepository(pool);
  });
  async function submit(seed = 'a') {
    const user = await db.createUsersRepository(pool).createRegistered({
      email: `${seed}@test.invalid`,
      passwordHash: 'fake',
      displayName: null,
      dailyQuota: 5,
      monthlyQuota: 20,
    });
    return db.createTravelPlansRepository(pool).createGeneration({
      userId: user.id,
      clientRequestId: seed,
      idempotencyKey: seed.padEnd(64, '0'),
      rawRequest: {},
      normalizedRequest: {},
      destinationName: '杭州',
      destinationPlaceId: null,
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      totalDays: 1,
      travelerCount: 1,
      supersedeBefore: new Date(0),
      traceContext: { traceparent: 'isolated-trace' },
    });
  }
  it('免费任务持久接受；投递器重启后可领取，仅返回标识符和 trace', async () => {
    const job = await submit();
    expect(await outbox.stats()).toMatchObject({ pending: 1 });
    const [claim] = await outbox.claim();
    expect(claim?.jobId).toBe(job.jobId);
    expect(await outbox.prepare(claim!)).toMatchObject({
      kind: 'deliver',
      payload: {
        jobId: job.jobId,
        planId: job.planId,
        requestId: job.requestId,
        traceContext: { traceparent: 'isolated-trace' },
      },
    });
    expect(JSON.stringify(await outbox.prepare(claim!))).not.toContain('杭州');
  });
  it('两个投递器竞争只领取一次；旧 token 不得确认或重排', async () => {
    await submit();
    const batches = await Promise.all([outbox.claim(), outbox.claim()]);
    const claims = batches.flat();
    expect(claims).toHaveLength(1);
    const old = claims[0]!;
    await pool.query("UPDATE generation_outbox SET lease_expires_at = NOW() - interval '1 second'");
    const [fresh] = await outbox.claim();
    expect(fresh!.token).not.toBe(old.token);
    expect(await outbox.acknowledge(old)).toBe(false);
    expect(await outbox.retry(old)).toBe(false);
    expect(await outbox.acknowledge(fresh!)).toBe(true);
    expect(await outbox.stats()).toMatchObject({ pending: 0 });
  });
  it('入队确认丢失可再投，失败退避后恢复；删除任务级联清理', async () => {
    const job = await submit();
    const [first] = await outbox.claim();
    expect(await outbox.retry(first!)).toBe(true);
    expect(await outbox.claim()).toEqual([]);
    await pool.query("UPDATE generation_outbox SET next_attempt_at = NOW() - interval '1 second'");
    const [second] = await outbox.claim();
    expect(second?.attempts).toBe(2);
    await pool.query('DELETE FROM generation_jobs WHERE id = $1', [job.jobId]);
    expect(await outbox.prepare(second!)).toEqual({ kind: 'skip' });
    expect(await outbox.stats()).toMatchObject({ pending: 0 });
  });
  it('取消与超期任务不投递，超期写 FAILED 后由投递器等待释放预留', async () => {
    const job = await submit();
    await pool.query("UPDATE generation_jobs SET created_at = NOW() - interval '601 seconds'");
    const [claim] = await outbox.claim();
    expect(await outbox.prepare(claim!)).toEqual({ kind: 'release', jobId: job.jobId });
    const state = await pool.query('SELECT status, error_code FROM generation_jobs WHERE id = $1', [
      job.jobId,
    ]);
    expect(state.rows[0]).toEqual({ status: 'FAILED', error_code: 'JOB_QUEUE_TIMEOUT' });
    await outbox.acknowledge(claim!);
    const cancelled = await submit('b');
    await pool.query(
      "UPDATE generation_jobs SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1",
      [cancelled.jobId],
    );
    const [next] = await outbox.claim();
    expect(await outbox.prepare(next!)).toEqual({ kind: 'release', jobId: cancelled.jobId });
  });
});
