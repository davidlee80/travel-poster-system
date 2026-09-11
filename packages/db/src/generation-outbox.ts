import type { Pool } from 'pg';

export interface OutboxClaim {
  readonly jobId: string;
  readonly token: string;
  readonly attempts: number;
}
export interface OutboxStats {
  readonly pending: number;
  readonly oldestSeconds: number;
}
export type OutboxPreparation =
  | { readonly kind: 'skip' }
  | { readonly kind: 'release'; readonly jobId: string }
  | {
      readonly kind: 'deliver';
      readonly payload: {
        readonly jobId: string;
        readonly requestId: string;
        readonly planId: string;
        readonly userId: string;
        readonly traceContext?: Readonly<Record<string, string>>;
      };
    };
export interface GenerationOutboxRepository {
  claim(): Promise<readonly OutboxClaim[]>;
  prepare(claim: OutboxClaim): Promise<OutboxPreparation>;
  acknowledge(claim: OutboxClaim): Promise<boolean>;
  retry(claim: OutboxClaim): Promise<boolean>;
  stats(): Promise<OutboxStats>;
}

/** 所有领取和确认均使用数据库时钟，Redis 调用不占用任何数据库事务。 */
export function createGenerationOutboxRepository(pool: Pool): GenerationOutboxRepository {
  return {
    async claim() {
      const result = await pool.query<{ job_id: string; lease_token: string; attempts: number }>(`
        WITH pending AS (
          SELECT job_id FROM generation_outbox
          WHERE delivered_at IS NULL AND next_attempt_at <= NOW()
            AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
          ORDER BY next_attempt_at, created_at, job_id
          LIMIT 20 FOR UPDATE SKIP LOCKED
        )
        UPDATE generation_outbox o
        SET lease_token = gen_random_uuid(), lease_expires_at = NOW() + interval '30 seconds',
            attempts = attempts + 1
        FROM pending WHERE o.job_id = pending.job_id
        RETURNING o.job_id, o.lease_token, o.attempts`);
      return result.rows.map((row) => ({
        jobId: row.job_id,
        token: row.lease_token,
        attempts: row.attempts,
      }));
    },
    async prepare(claim) {
      // 首次排队超时才失败，重试任务的 started_at 不为空，不沿用首次排队期限。
      await pool.query(
        `UPDATE generation_jobs j
        SET status = 'FAILED', error_code = 'JOB_QUEUE_TIMEOUT',
            message = '排队超时，请稍后重试', finished_at = NOW()
        WHERE j.id = $1 AND j.status = 'QUEUED' AND j.started_at IS NULL
          AND j.created_at < NOW() - interval '600 seconds'
          AND EXISTS (SELECT 1 FROM generation_outbox o WHERE o.job_id = j.id
            AND o.lease_token = $2 AND o.lease_expires_at > NOW() AND o.delivered_at IS NULL)`,
        [claim.jobId, claim.token],
      );
      const result = await pool.query<{
        request_id: string;
        plan_id: string | null;
        user_id: string;
        status: string;
        trace_context: Record<string, string> | null;
      }>(
        `SELECT j.request_id, j.plan_id, j.user_id, j.status, o.trace_context
        FROM generation_outbox o JOIN generation_jobs j ON j.id = o.job_id
        WHERE o.job_id = $1 AND o.lease_token = $2 AND o.lease_expires_at > NOW()
          AND o.delivered_at IS NULL`,
        [claim.jobId, claim.token],
      );
      const row = result.rows[0];
      if (row === undefined || row.plan_id === null || row.status === 'COMPLETED')
        return { kind: 'skip' };
      if (row.status === 'FAILED' || row.status === 'CANCELLED')
        return { kind: 'release', jobId: claim.jobId };
      return {
        kind: 'deliver',
        payload: {
          jobId: claim.jobId,
          requestId: row.request_id,
          planId: row.plan_id,
          userId: row.user_id,
          ...(row.trace_context === null ? {} : { traceContext: row.trace_context }),
        },
      };
    },
    async acknowledge(claim) {
      const result = await pool.query(
        `UPDATE generation_outbox
        SET delivered_at = NOW(), lease_token = NULL, lease_expires_at = NULL
        WHERE job_id = $1 AND lease_token = $2 AND lease_expires_at > NOW() AND delivered_at IS NULL`,
        [claim.jobId, claim.token],
      );
      return result.rowCount === 1;
    },
    async retry(claim) {
      const result = await pool.query(
        `UPDATE generation_outbox
        SET next_attempt_at = NOW() + LEAST(60, power(2, LEAST(attempts - 1, 6))) * interval '1 second',
            lease_token = NULL, lease_expires_at = NULL
        WHERE job_id = $1 AND lease_token = $2 AND lease_expires_at > NOW() AND delivered_at IS NULL`,
        [claim.jobId, claim.token],
      );
      return result.rowCount === 1;
    },
    async stats() {
      const result = await pool.query<{
        pending: string;
        oldest: number;
      }>(`SELECT count(*) AS pending,
        COALESCE(EXTRACT(EPOCH FROM NOW() - min(o.created_at)), 0)::float8 AS oldest
        FROM generation_outbox o JOIN generation_jobs j ON j.id = o.job_id
        WHERE o.delivered_at IS NULL AND j.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`);
      return {
        pending: Number(result.rows[0]!.pending),
        oldestSeconds: Math.max(0, result.rows[0]!.oldest),
      };
    },
  };
}
