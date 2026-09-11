import type { Pool } from 'pg';

import { UniqueViolationError } from './users.js';
import { refundCreditsInTransaction } from './credit-wallet.js';

/** PostgreSQL unique_violation。与 travel-plans.ts 同一判定 */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * 导出任务仓储（TP-4-12/13，设计稿 13.5、13.6、十五章 `exports`）。
 *
 * ## 幂等的最终真相在唯一索引上
 *
 * 与 13.8 的生成幂等同一结构：`exports_idempotency_uk` 是最终真相，
 * 应用层的「先查一次」只是快路径。两个并发的导出请求会有一个撞上唯一索引，
 * 捕获后转为返回既有任务 —— 而不是让两个渲染任务同时跑
 * （渲染是这条链路上最贵的一步：一个 14 天的 PDF 要跑 14 次页面渲染）。
 */

export interface CreateExportInput {
  readonly exportId: string;
  readonly userId: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly templateId: string;
  readonly format: 'PNG' | 'PDF';
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
  readonly dayNumbers: readonly number[] | null;
  readonly idempotencyKey: string;
}

export interface ExportRow {
  readonly exportId: string;
  readonly userId: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly templateId: string;
  readonly format: 'PNG' | 'PDF';
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
  readonly dayNumbers: readonly number[] | null;
  readonly status: string;
  readonly progress: number;
  /** `ExportArtifact[]`，由调用方用 schema 解析 */
  readonly files: unknown;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

/**
 * Worker 侧读到的导出行：多一个 `userType`（TP-5-01）。
 *
 * 单独一个类型而不是加进 `ExportRow`：`create` 的 `RETURNING` 拿不到
 * `users` 的列，让 `ExportRow` 带上这个字段会迫使那里编一个值。
 */
export interface ExportJobRow extends ExportRow {
  readonly userType: 'ANONYMOUS' | 'REGISTERED';
  /**
   * 计划版本行的创建时刻（TP-6-12）。
   *
   * 15.4 的路径里 `yyyyMM` 由 `content_id`（UUIDv7）派生，这一列只在
   * ID 是存量 v4 时作为回退（R-53，见 `@tps/storage` 的 `contentPrefix`）。
   * 与 `userType` 同一处理：join 一次拿到，不放进队列载荷。
   */
  readonly planVersionCreatedAt: Date;
}

/** API 下载与历史列表需要的稳定命名上下文。 */
export interface ExportDownloadRow extends ExportRow {
  readonly destinationName: string;
  readonly startDate: string;
  readonly totalDays: number;
  readonly versionNumber: number;
}

export interface FinishExportInput {
  readonly exportId: string;
  readonly status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  /** `ExportArtifact[]`。含 `storage_key`，重签名要用（13.6） */
  readonly files: unknown;
  readonly errorCode: string | null;
  readonly errorDetail?: unknown;
}

export interface ExportsRepository {
  /** 幂等键冲突时抛 `UniqueViolationError`，由调用方转为查既有任务（13.5） */
  create(input: CreateExportInput): Promise<ExportRow>;
  /**
   * 按幂等键回查**活跃**的导出。
   *
   * 谓词必须与迁移 0018 的部分唯一索引一致（`status <> 'FAILED'`）。
   * 两边不一致会弄出一个没有出路的状态：这里返回了历史失败行，
   * 路由于是返回 200 + 一个已经没人消费的 `export_id`，
   * 而用户永远等不到它完成。
   */
  findByIdempotencyKey(key: string): Promise<ExportRow | null>;
  /** 13.6：**必须带 `user_id` 谓词**（13.0） */
  findForUser(exportId: string, userId: string): Promise<ExportDownloadRow | null>;
  /** 结果页刷新后恢复该计划的导出任务；查询本身必须带 user_id 谓词。 */
  listForPlanForUser(planId: string, userId: string): Promise<readonly ExportDownloadRow[]>;
  /** Worker 侧：无 `user_id`（消费自己入队的任务，与 `findJobContext` 同一例外） */
  findById(exportId: string): Promise<ExportJobRow | null>;
  markRendering(exportId: string): Promise<boolean>;
  finish(input: FinishExportInput): Promise<void>;
  /** 13.6 重签名：只换 `files` 里的 URL 与过期时刻，不动状态 */
  replaceFiles(exportId: string, files: unknown): Promise<void>;
  /** 21.4：每计划导出次数的既有计数（幂等命中不算新的一次） */
  countForPlan(planId: string): Promise<number>;
}

interface Row {
  id: string;
  user_id: string;
  plan_id: string;
  plan_version_id: string;
  template_id: string;
  format: string;
  scope: string;
  day_numbers: number[] | null;
  status: string;
  progress: number;
  files: unknown;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

interface DownloadRow extends Row {
  destination_name: string;
  start_date: string;
  total_days: number;
  version_number: number;
}

const COLUMNS = `id, user_id, plan_id, plan_version_id, template_id, format, scope,
                 day_numbers, status, progress, files, error_code, created_at, finished_at`;

/** 同一组列，带 `e.` 前缀，用于需要 join users 的查询 */
const COLUMNS_PREFIXED = COLUMNS.split(',')
  .map((column) => `e.${column.trim()}`)
  .join(', ');

function toRow(row: Row): ExportRow {
  return {
    exportId: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    planVersionId: row.plan_version_id,
    templateId: row.template_id,
    format: row.format as 'PNG' | 'PDF',
    scope: row.scope as ExportRow['scope'],
    dayNumbers: row.day_numbers,
    status: row.status,
    progress: row.progress,
    files: row.files,
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toDownloadRow(row: DownloadRow): ExportDownloadRow {
  return {
    ...toRow(row),
    destinationName: row.destination_name,
    startDate: row.start_date,
    totalDays: row.total_days,
    versionNumber: row.version_number,
  };
}

export interface ExportLease {
  readonly exportId: string;
  readonly token: string;
}

export class ExportLeaseLostError extends Error {
  constructor() {
    super('EXPORT_LEASE_LOST');
  }
}

export type ExportClaim =
  | { readonly kind: 'acquired'; readonly lease: ExportLease }
  | { readonly kind: 'busy' | 'terminal' | 'not_found' | 'legacy' };

export interface ExportExecutionRepository {
  claim(exportId: string, attempt: number): Promise<ExportClaim>;
  renew(lease: ExportLease): Promise<boolean>;
  retry(lease: ExportLease, errorCode: string): Promise<boolean>;
  finish(lease: ExportLease, input: FinishExportInput): Promise<boolean>;
  failAbandoned(exportId: string, errorCode: string): Promise<boolean>;
  pendingFinalizations(): Promise<readonly { exportId: string; errorCode: string }[]>;
  registerArtifact(lease: ExportLease, key: string): Promise<void>;
  pendingArtifacts(): Promise<readonly { token: string; key: string }[]>;
  deferArtifact(token: string, key: string): Promise<void>;
}

export function createExportExecutionRepository(
  pool: Pool,
  billingEnabled: boolean,
): ExportExecutionRepository {
  const finish = async (input: FinishExportInput, lease?: ExportLease): Promise<boolean> => {
    if (lease !== undefined && lease.exportId !== input.exportId) throw new ExportLeaseLostError();
    // 退款事务失败仍留下待收尾标记；不提前公开 FAILED。
    if (input.status === 'FAILED') {
      await pool.query(
        `UPDATE exports SET finalization_pending = true, error_code = $3
        WHERE id = $1 AND execution_protocol = 1 AND status IN ('QUEUED', 'RENDERING')
          AND (($2::uuid IS NOT NULL AND execution_token = $2 AND execution_expires_at > clock_timestamp())
            OR ($2::uuid IS NULL AND (execution_expires_at IS NULL OR execution_expires_at <= clock_timestamp())))`,
        [input.exportId, lease?.token ?? null, input.errorCode],
      );
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT id FROM exports
        WHERE id = $1 AND execution_protocol = 1 AND status IN ('QUEUED', 'RENDERING')
          AND (($2::uuid IS NOT NULL AND execution_token = $2 AND execution_expires_at > clock_timestamp())
            OR ($2::uuid IS NULL AND (execution_expires_at IS NULL OR execution_expires_at <= clock_timestamp())))
        FOR UPDATE`,
        [input.exportId, lease?.token ?? null],
      );
      if (result.rowCount !== 1) return false;
      if (input.status === 'FAILED' && billingEnabled) {
        const spend = await client.query<{ user_id: string; amount_cr: string }>(
          `SELECT user_id, amount_cr FROM credit_ledger
           WHERE ref_type = 'EXPORT' AND ref_id = $1 AND kind = 'SPEND' ORDER BY created_at DESC LIMIT 1`,
          [input.exportId],
        );
        const row = spend.rows[0];
        if (row !== undefined && Number(row.amount_cr) < 0) {
          await refundCreditsInTransaction(client, {
            userId: row.user_id,
            amountCr: -Number(row.amount_cr),
            idempotencyKey: `refund:export:${input.exportId}`,
            refType: 'EXPORT',
            refId: input.exportId,
          });
        }
      }
      const updated = await client.query(
        `UPDATE exports SET status = $2::text,
        progress = CASE WHEN $2::text = 'FAILED' THEN progress ELSE 100 END,
        files = $3::jsonb, error_code = $4, error_detail = $5::jsonb, finished_at = NOW(),
        execution_token = NULL, execution_expires_at = NULL, finalization_pending = false
        WHERE id = $1 AND ($6::uuid IS NULL OR (execution_token = $6 AND execution_expires_at > clock_timestamp()))`,
        [
          input.exportId,
          input.status,
          JSON.stringify(input.files),
          input.errorCode,
          JSON.stringify(input.errorDetail ?? null),
          lease?.token ?? null,
        ],
      );
      if (updated.rowCount !== 1) return false;
      if (input.status !== 'FAILED' && lease !== undefined) {
        await client.query('DELETE FROM export_attempt_artifacts WHERE token = $1', [lease.token]);
      }
      await client.query('COMMIT');
      return true;
    } finally {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
  };
  return {
    async claim(exportId, attempt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{
          status: string;
          execution_protocol: number;
          busy: boolean;
        }>(
          `SELECT status, execution_protocol, COALESCE(execution_expires_at > clock_timestamp(), false) AS busy
           FROM exports WHERE id = $1 FOR UPDATE`,
          [exportId],
        );
        const row = result.rows[0];
        if (row === undefined) return { kind: 'not_found' };
        if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(row.status)) return { kind: 'terminal' };
        if (row.execution_protocol !== 1) return { kind: 'legacy' };
        if (row.busy) return { kind: 'busy' };
        const claimed = await client.query<{ execution_token: string }>(
          `UPDATE exports
          SET execution_token = gen_random_uuid(), execution_expires_at = clock_timestamp() + interval '60 seconds',
            status = 'RENDERING', progress = GREATEST(progress, 50), attempt_count = GREATEST(attempt_count, $2)
          WHERE id = $1 RETURNING execution_token`,
          [exportId, attempt],
        );
        await client.query('COMMIT');
        return { kind: 'acquired', lease: { exportId, token: claimed.rows[0]!.execution_token } };
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    },
    async renew(lease) {
      const result = await pool.query(
        `UPDATE exports SET execution_expires_at = clock_timestamp() + interval '60 seconds'
        WHERE id = $1 AND execution_token = $2 AND execution_expires_at > clock_timestamp() AND status = 'RENDERING'`,
        [lease.exportId, lease.token],
      );
      return result.rowCount === 1;
    },
    async retry(lease, errorCode) {
      const result = await pool.query(
        `UPDATE exports SET status = 'QUEUED', error_code = $3,
        error_detail = '{"message":"暂时失败，正在重试"}'::jsonb,
        execution_token = NULL, execution_expires_at = NULL, finalization_pending = false
        WHERE id = $1 AND execution_token = $2 AND execution_expires_at > clock_timestamp() AND status = 'RENDERING'`,
        [lease.exportId, lease.token, errorCode],
      );
      return result.rowCount === 1;
    },
    async registerArtifact(lease, key) {
      if (!key.includes(`/exports/${lease.exportId}/attempts/${lease.token}/`))
        throw new ExportLeaseLostError();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const valid = await client.query(
          `SELECT id FROM exports WHERE id = $1 AND execution_token = $2
          AND execution_expires_at > clock_timestamp() AND status = 'RENDERING' FOR UPDATE`,
          [lease.exportId, lease.token],
        );
        if (valid.rowCount !== 1) throw new ExportLeaseLostError();
        await client.query(
          `INSERT INTO export_attempt_artifacts (token, export_id, storage_key)
          VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [lease.token, lease.exportId, key],
        );
        await client.query('COMMIT');
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    },
    async pendingArtifacts() {
      const result = await pool.query<{
        token: string;
        storage_key: string;
      }>(`SELECT a.token, a.storage_key
        FROM export_attempt_artifacts a LEFT JOIN exports e ON e.id = a.export_id
        WHERE a.cleanup_after <= NOW() AND NOT COALESCE(e.execution_token = a.token
          AND e.execution_expires_at > clock_timestamp(), false)
        ORDER BY a.cleanup_after, a.token, a.storage_key LIMIT 100`);
      return result.rows.map((row) => ({ token: row.token, key: row.storage_key }));
    },
    async deferArtifact(token, key) {
      // 保留登记并重复删除，覆盖失去租约后才返回的迟到上传；绝不按前缀删除。
      await pool.query(
        `UPDATE export_attempt_artifacts SET cleanup_after = NOW() + interval '60 seconds'
        WHERE token = $1 AND storage_key = $2`,
        [token, key],
      );
    },
    finish: (lease, input) => finish(input, lease),
    failAbandoned: (exportId, errorCode) =>
      finish({ exportId, status: 'FAILED', files: [], errorCode }),
    async pendingFinalizations() {
      const result = await pool.query<{
        id: string;
        error_code: string;
      }>(`SELECT id, error_code FROM exports
        WHERE execution_protocol = 1 AND finalization_pending
          AND (execution_expires_at IS NULL OR execution_expires_at <= clock_timestamp())
          AND status IN ('QUEUED', 'RENDERING') ORDER BY id LIMIT 100`);
      return result.rows.map((row) => ({ exportId: row.id, errorCode: row.error_code }));
    },
  };
}

export function createExportsRepository(pool: Pool): ExportsRepository {
  return {
    async create(input) {
      try {
        const { rows } = await pool.query<Row>(
          `INSERT INTO exports
             (id, user_id, plan_id, plan_version_id, template_id, format, scope,
              day_numbers, idempotency_key)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::integer[], $9)
           RETURNING ${COLUMNS}`,
          [
            input.exportId,
            input.userId,
            input.planId,
            input.planVersionId,
            input.templateId,
            input.format,
            input.scope,
            /*
             * `null` 而不是空数组：`exports_day_numbers_check` 要求非
             * SINGLE_DAY 时 `day_numbers IS NULL`，而空数组不满足它
             * （R-18 用 cardinality 替掉 array_length 正是为了这类边界）。
             */
            input.dayNumbers === null ? null : [...input.dayNumbers],
            input.idempotencyKey,
          ],
        );
        return toRow(rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new UniqueViolationError(error.constraint ?? 'exports_idempotency_uk');
        }
        throw error;
      }
    },

    async findByIdempotencyKey(key) {
      /*
       * `status <> 'FAILED'` 与迁移 0018 的部分唯一索引同一谓词 ——
       * 失败的导出不占用幂等键，因此也不应当被当成「已有任务」返回。
       * 同一个键下可能有多行历史 FAILED，而活跃行最多一行，
       * 因此这条查询仍然最多命中一行。
       */
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM exports
          WHERE idempotency_key = $1 AND status <> 'FAILED'`,
        [key],
      );
      return rows[0] === undefined ? null : toRow(rows[0]);
    },

    async findForUser(exportId, userId) {
      const { rows } = await pool.query<DownloadRow>(
        `SELECT ${COLUMNS_PREFIXED}, p.destination_name, p.start_date::text AS start_date,
                p.total_days, v.version_number
           FROM exports e
           JOIN travel_plans p ON p.id = e.plan_id
           JOIN travel_plan_versions v ON v.id = e.plan_version_id
          WHERE e.id = $1 AND e.user_id = $2`,
        [exportId, userId],
      );
      return rows[0] === undefined ? null : toDownloadRow(rows[0]);
    },

    async listForPlanForUser(planId, userId) {
      const { rows } = await pool.query<DownloadRow>(
        `SELECT ${COLUMNS_PREFIXED}, p.destination_name, p.start_date::text AS start_date,
                p.total_days, v.version_number
           FROM exports e
           JOIN travel_plans p ON p.id = e.plan_id
           JOIN travel_plan_versions v ON v.id = e.plan_version_id
          WHERE e.plan_id = $1 AND e.user_id = $2
          ORDER BY e.created_at DESC, e.id DESC`,
        [planId, userId],
      );
      return rows.map(toDownloadRow);
    },

    async findById(exportId) {
      /*
       * join users 只为拿 `user_type`（TP-5-01）：21.3 的 R-13 要求
       * `travel_export_total` 带身份维度，而门禁 #20 的「匿名导出次数上限
       * 3 次」也只能按身份分开看。
       *
       * 为什么不放进队列载荷：export-queue.ts 的「载荷只放 export_id」是
       * 刻意的（避免快照与库里的行分歧）。而这次 join 是单行主键查询，
       * 与本来就要做的 `findById` 合并成一条语句，没有额外往返。
       */
      const { rows } = await pool.query<Row & { user_type: string; plan_version_created_at: Date }>(
        `SELECT ${COLUMNS_PREFIXED}, u.user_type, v.created_at AS plan_version_created_at
           FROM exports e
           JOIN users u ON u.id = e.user_id
           JOIN travel_plan_versions v ON v.id = e.plan_version_id
          WHERE e.id = $1`,
        [exportId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        ...toRow(row),
        userType: row.user_type === 'REGISTERED' ? 'REGISTERED' : 'ANONYMOUS',
        planVersionCreatedAt: row.plan_version_created_at,
      };
    },

    async markRendering(exportId) {
      /*
       * 只从 QUEUED 转 RENDERING。重复投递时第二个消费者会改 0 行并返回 false，
       * 据此直接退出 —— 与 13.8 的 Worker 侧并发保护同一手法。
       */
      const { rowCount } = await pool.query(
        `UPDATE exports SET status = 'RENDERING', progress = GREATEST(progress, 50)
          WHERE id = $1 AND status = 'QUEUED' AND execution_token IS NULL`,
        [exportId],
      );
      return (rowCount ?? 0) > 0;
    },

    async finish(input) {
      const result = await pool.query(
        `UPDATE exports
            SET status = $2::text,
                -- 显式 ::text：同一个占位符既赋给 varchar 列又参与比较时，
                -- Postgres 会报 inconsistent types deduced for parameter
                progress = CASE WHEN $2::text = 'FAILED' THEN progress ELSE 100 END,
                files = $3::jsonb,
                error_code = $4,
                error_detail = $5::jsonb,
                finished_at = NOW()
          WHERE id = $1 AND execution_token IS NULL
            AND status NOT IN ('COMPLETED', 'PARTIAL', 'FAILED')`,
        [
          input.exportId,
          input.status,
          JSON.stringify(input.files),
          input.errorCode,
          input.errorDetail === undefined ? null : JSON.stringify(input.errorDetail),
        ],
      );
      if (result.rowCount !== 1) throw new ExportLeaseLostError();
    },

    async replaceFiles(exportId, files) {
      /*
       * 13.6：「过期后重新调用本端点获取新签名，**不重新渲染**」。
       * 因此重签名只改 `files`，不动 `status` 与 `finished_at` ——
       * 动了的话「这次导出是什么时候完成的」就变成了「最后一次重签名的时间」。
       */
      await pool.query(`UPDATE exports SET files = $2::jsonb WHERE id = $1`, [
        exportId,
        JSON.stringify(files),
      ]);
    },

    async countForPlan(planId) {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM exports WHERE plan_id = $1',
        [planId],
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}
