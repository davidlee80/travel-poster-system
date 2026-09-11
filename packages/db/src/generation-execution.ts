import type { Pool, PoolClient } from 'pg';
import { EMPTY_USAGE, type UsageSnapshot } from '@tps/billing';
import type { AssetWarningCode, PresentationValidation } from '@tps/schemas';

export interface GenerationLease {
  readonly jobId: string;
  readonly token: string;
}

export class GenerationLeaseLostError extends Error {
  constructor() {
    super('GENERATION_LEASE_LOST');
  }
}

export type GenerationClaim =
  | { readonly kind: 'acquired'; readonly lease: GenerationLease; readonly firstAttempt: boolean }
  | { readonly kind: 'busy' | 'terminal' | 'not_found' | 'legacy' };

export interface PresentationCheckpoint {
  readonly pages: number;
  readonly validationStatus: PresentationValidation;
  readonly bindings: number;
  readonly omitted: number;
  readonly budgetMismatch: boolean;
  readonly warnings: readonly AssetWarningCode[];
}

export interface GenerationCheckpoint {
  readonly versionId: string;
  readonly planJson: unknown;
  readonly status: 'READY' | 'REPAIRED' | 'REJECTED';
  readonly presentation: PresentationCheckpoint | null;
}

export interface GenerationExecutionState {
  readonly status: string;
  readonly usage: UsageSnapshot;
  readonly checkpoint: GenerationCheckpoint | null;
  readonly finalizationPending: boolean;
}

export interface GenerationExecutionRepository {
  read(jobId: string): Promise<GenerationExecutionState | null>;
  claim(jobId: string, attempt: number): Promise<GenerationClaim>;
  renew(lease: GenerationLease): Promise<boolean>;
  retry(lease: GenerationLease, errorCode: string): Promise<boolean>;
  finish(
    lease: GenerationLease,
    status: 'COMPLETED' | 'FAILED',
    usage: UsageSnapshot,
    errorCode?: string,
  ): Promise<boolean>;
  failAbandoned(jobId: string, errorCode: string): Promise<boolean>;
  pendingFinalizations(): Promise<readonly string[]>;
  markFinalized(jobId: string): Promise<void>;
}

export function createGenerationExecutionRepository(pool: Pool): GenerationExecutionRepository {
  return {
    async read(jobId) {
      const result = await pool.query<{
        status: string;
        usage_snapshot: UsageSnapshot | null;
        finalization_pending: boolean;
        version_id: string | null;
        plan_json: unknown;
        version_status: GenerationCheckpoint['status'];
        presentation_checkpoint: PresentationCheckpoint | null;
      }>(
        `SELECT j.status, j.usage_snapshot, j.finalization_pending, v.id AS version_id,
        v.plan_json, v.status AS version_status, j.presentation_checkpoint
        FROM generation_jobs j LEFT JOIN travel_plan_versions v ON v.id = j.plan_version_id
        WHERE j.id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        status: row.status,
        usage: row.usage_snapshot ?? EMPTY_USAGE,
        finalizationPending: row.finalization_pending,
        checkpoint:
          row.version_id === null
            ? null
            : {
                versionId: row.version_id,
                planJson: row.plan_json,
                status: row.version_status,
                presentation: row.presentation_checkpoint,
              },
      };
    },
    async claim(jobId, attempt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{
          status: string;
          started_at: Date | null;
          busy: boolean;
          execution_protocol: number;
        }>(
          `SELECT status, started_at, execution_protocol,
          COALESCE(execution_expires_at > clock_timestamp(), false) AS busy
          FROM generation_jobs WHERE id = $1 FOR UPDATE`,
          [jobId],
        );
        const row = result.rows[0];
        if (row === undefined) return { kind: 'not_found' };
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) return { kind: 'terminal' };
        if (row.execution_protocol !== 1) return { kind: 'legacy' };
        if (row.busy) return { kind: 'busy' };
        const claimed = await client.query<{ execution_token: string }>(
          `UPDATE generation_jobs
          SET execution_token = gen_random_uuid(), execution_expires_at = clock_timestamp() + interval '60 seconds',
            attempt_count = GREATEST(attempt_count, $2), started_at = COALESCE(started_at, NOW()), updated_at = NOW()
          WHERE id = $1 RETURNING execution_token`,
          [jobId, attempt],
        );
        await client.query('COMMIT');
        return {
          kind: 'acquired',
          lease: { jobId, token: claimed.rows[0]!.execution_token },
          firstAttempt: row.started_at === null,
        };
      } finally {
        // 提前返回和查询失败同样释放事务锁；COMMIT 后 ROLLBACK 是无副作用的。
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    },
    async renew(lease) {
      const result = await pool.query(
        `UPDATE generation_jobs
        SET execution_expires_at = clock_timestamp() + interval '60 seconds'
        WHERE id = $1 AND execution_token = $2 AND execution_expires_at > clock_timestamp()
          AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        [lease.jobId, lease.token],
      );
      return result.rowCount === 1;
    },
    async retry(lease, errorCode) {
      const result = await pool.query(
        `UPDATE generation_jobs
        SET status = 'QUEUED', message = '暂时失败，正在重试', error_code = $3,
          execution_token = NULL, execution_expires_at = NULL, updated_at = NOW()
        WHERE id = $1 AND execution_token = $2 AND execution_expires_at > clock_timestamp()
          AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        [lease.jobId, lease.token, errorCode],
      );
      return result.rowCount === 1;
    },
    async finish(lease, status, usage, errorCode) {
      const result = await pool.query(
        `UPDATE generation_jobs
        SET status = $3::text, progress = CASE WHEN $3::text = 'COMPLETED' THEN 100 ELSE progress END,
          error_code = CASE WHEN $3::text = 'COMPLETED' THEN NULL ELSE $5 END,
          message = CASE WHEN $3::text = 'COMPLETED' THEN '生成完成' ELSE '生成失败，请稍后重试' END,
          usage_snapshot = $4::jsonb, finalization_pending = true, finished_at = NOW(), updated_at = NOW(),
          execution_token = NULL, execution_expires_at = NULL
        WHERE id = $1 AND execution_token = $2 AND execution_expires_at > clock_timestamp()
          AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        [lease.jobId, lease.token, status, JSON.stringify(usage), errorCode ?? null],
      );
      return result.rowCount === 1;
    },
    async failAbandoned(jobId, errorCode) {
      const result = await pool.query(
        `UPDATE generation_jobs
        SET status = 'FAILED', error_code = $2, message = '生成失败，请稍后重试',
          finalization_pending = true, finished_at = NOW(), updated_at = NOW(),
          execution_token = NULL, execution_expires_at = NULL
        WHERE id = $1 AND execution_protocol = 1
          AND (execution_expires_at IS NULL OR execution_expires_at <= clock_timestamp())
          AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        [jobId, errorCode],
      );
      return result.rowCount === 1;
    },
    async pendingFinalizations() {
      const result = await pool.query<{ id: string }>(`SELECT id FROM generation_jobs
        WHERE execution_protocol = 1 AND finalization_pending
          AND status IN ('COMPLETED', 'FAILED', 'CANCELLED') ORDER BY updated_at, id LIMIT 100`);
      return result.rows.map((row) => row.id);
    },
    async markFinalized(jobId) {
      await pool.query(
        `UPDATE generation_jobs SET finalization_pending = false
        WHERE id = $1 AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        [jobId],
      );
    },
  };
}

/** 短事务先锁任务行再写产物；领取、取消、续租与提交共用这一行锁。 */
export async function lockGenerationWrite(
  client: PoolClient,
  planId: string,
  lease?: GenerationLease,
): Promise<void> {
  const result = await client.query<{ id: string; allowed: boolean }>(
    `
    SELECT id, CASE WHEN $2::uuid IS NULL THEN execution_token IS NULL
      ELSE id = $2 AND execution_token = $3 AND execution_expires_at > clock_timestamp()
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') END AS allowed
    FROM generation_jobs WHERE plan_id = $1 ORDER BY id FOR UPDATE`,
    [planId, lease?.jobId ?? null, lease?.token ?? null],
  );
  if (
    (lease !== undefined && result.rows.length === 0) ||
    result.rows.some((row) => !row.allowed)
  ) {
    throw new GenerationLeaseLostError();
  }
}
