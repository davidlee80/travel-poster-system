import type { Pool } from 'pg';

import { UniqueViolationError } from './users.js';

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
  findByIdempotencyKey(key: string): Promise<ExportRow | null>;
  /** 13.6：**必须带 `user_id` 谓词**（13.0） */
  findForUser(exportId: string, userId: string): Promise<ExportRow | null>;
  /** Worker 侧：无 `user_id`（消费自己入队的任务，与 `findJobContext` 同一例外） */
  findById(exportId: string): Promise<ExportRow | null>;
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

const COLUMNS = `id, user_id, plan_id, plan_version_id, template_id, format, scope,
                 day_numbers, status, progress, files, error_code, created_at, finished_at`;

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
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM exports WHERE idempotency_key = $1`,
        [key],
      );
      return rows[0] === undefined ? null : toRow(rows[0]);
    },

    async findForUser(exportId, userId) {
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM exports WHERE id = $1 AND user_id = $2`,
        [exportId, userId],
      );
      return rows[0] === undefined ? null : toRow(rows[0]);
    },

    async findById(exportId) {
      const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM exports WHERE id = $1`, [
        exportId,
      ]);
      return rows[0] === undefined ? null : toRow(rows[0]);
    },

    async markRendering(exportId) {
      /*
       * 只从 QUEUED 转 RENDERING。重复投递时第二个消费者会改 0 行并返回 false，
       * 据此直接退出 —— 与 13.8 的 Worker 侧并发保护同一手法。
       */
      const { rowCount } = await pool.query(
        `UPDATE exports SET status = 'RENDERING', progress = GREATEST(progress, 50)
          WHERE id = $1 AND status = 'QUEUED'`,
        [exportId],
      );
      return (rowCount ?? 0) > 0;
    },

    async finish(input) {
      await pool.query(
        `UPDATE exports
            SET status = $2::text,
                -- 显式 ::text：同一个占位符既赋给 varchar 列又参与比较时，
                -- Postgres 会报 inconsistent types deduced for parameter
                progress = CASE WHEN $2::text = 'FAILED' THEN progress ELSE 100 END,
                files = $3::jsonb,
                error_code = $4,
                error_detail = $5::jsonb,
                finished_at = NOW()
          WHERE id = $1`,
        [
          input.exportId,
          input.status,
          JSON.stringify(input.files),
          input.errorCode,
          input.errorDetail === undefined ? null : JSON.stringify(input.errorDetail),
        ],
      );
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
