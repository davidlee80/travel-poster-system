import type { Pool, PoolClient } from 'pg';

import { UniqueViolationError } from './users.js';

/**
 * 计划、请求与任务的仓储（TP-2-08、TP-2-09、TP-2-15、TP-2-28）。
 *
 * ## 13.0：所有查询在 SQL 层强制 `user_id` 谓词
 *
 * 「不允许查出后在应用层过滤」不是风格偏好。应用层过滤有两个具体问题：
 *   1. 忘写一次 `if (row.user_id !== me)` 就是一次越权，而这种遗漏在
 *      code review 里极难看出（那一行本来就不该存在）；
 *   2. 即使过滤对了，他人的数据已经离开数据库进了进程内存 ——
 *      一次日志误打印、一次错误响应回显就泄漏了。
 *
 * 因此本模块的每个读方法都**必须**接收 `userId`，并把它写进 WHERE。
 * 他人资源返回 `null`，由调用方统一映射为 `404 PLAN_NOT_FOUND`（不是 403），
 * 避免用状态码枚举出计划 ID 的存在性。
 */

export type JobStatusValue = string;

export interface CreateGenerationInput {
  readonly userId: string;
  readonly clientRequestId: string;
  readonly idempotencyKey: string;
  /** 原始 `TravelRequestUI`。标准化规则变更后要靠它重放 */
  readonly rawRequest: unknown;
  readonly normalizedRequest: unknown;
  readonly destinationName: string;
  readonly destinationPlaceId: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly totalDays: number;
  readonly travelerCount: number;
}

export interface GenerationHandles {
  readonly requestId: string;
  readonly planId: string;
  readonly jobId: string;
}

/** 13.8：幂等命中时需要知道既有任务是否还在跑 */
export interface ExistingGeneration extends GenerationHandles {
  readonly jobStatus: JobStatusValue;
  readonly createdAt: Date;
}

export interface PlanDetail {
  readonly planId: string;
  readonly planStatus: string;
  readonly planVersionId: string;
  readonly versionStatus: string;
  /** 完整 `TravelPlan`（13.3） */
  readonly planJson: unknown;
}

export interface JobDetail {
  readonly jobId: string;
  readonly planId: string | null;
  readonly status: JobStatusValue;
  readonly progress: number;
  readonly message: string | null;
  readonly errorCode: string | null;
  readonly warnings: unknown;
}

/** 13.9.5 列表项。**刻意不含 `retrieval_projection`**（二十章 L2、TP-2-30） */
export interface PlanListItem {
  readonly planId: string;
  readonly title: string | null;
  readonly destinationName: string;
  readonly startDate: string;
  readonly totalDays: number;
  readonly status: string;
  readonly createdAt: Date;
}

export interface PlanListPage {
  readonly items: readonly PlanListItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ListPlansInput {
  readonly userId: string;
  readonly limit: number;
  /** `(created_at, id)` 复合游标的 Base64URL 编码 */
  readonly cursor?: string;
}

export interface TravelPlansRepository {
  /**
   * 同事务插入 `travel_requests` + `travel_plans` + `generation_jobs`。
   *
   * 幂等键冲突时抛 `UniqueViolationError`，由调用方转为查既有任务（13.8）。
   */
  createGeneration(input: CreateGenerationInput): Promise<GenerationHandles>;
  findByIdempotencyKey(userId: string, key: string): Promise<ExistingGeneration | null>;
  findPlanForUser(planId: string, userId: string): Promise<PlanDetail | null>;
  findJobForUser(jobId: string, userId: string): Promise<JobDetail | null>;
  listPlansForUser(input: ListPlansInput): Promise<PlanListPage>;
}

/** PostgreSQL unique_violation */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

interface Cursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * 游标编解码。
 *
 * 13.9.5 要求「游标为 `(created_at, id)` 复合游标的 Base64URL 编码」。
 * 用复合游标而不是 `OFFSET`：翻页期间新计划会插到列表最前面，
 * `OFFSET 20` 会让第二页重复出现第一页的最后几条（用户看到重复项），
 * 而复合游标是「从这条之后继续」，插入不影响后续页。
 *
 * 必须同时带 `id`：`created_at` 可能相同（同一毫秒内两次提交，
 * 或数据库时钟精度限制），只用它作游标会漏掉或重复同一时刻的行。
 */
export function encodeCursor(item: { createdAt: Date; planId: string }): string {
  const payload: Cursor = { createdAt: item.createdAt.toISOString(), id: item.planId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { createdAt, id } = parsed as Record<string, unknown>;
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    /*
     * 游标来自客户端，可能被截断、被手改、或是上一版格式。
     * 一律当作「无游标」从第一页开始，而不是 500 ——
     * 用户看到的是列表回到开头，而不是一个打不开的页面。
     */
    return null;
  }
}

export function createTravelPlansRepository(pool: Pool): TravelPlansRepository {
  return {
    async createGeneration(input) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');

        const request = await client.query<{ id: string }>(
          `INSERT INTO travel_requests (
             user_id, client_request_id, idempotency_key, raw_request, normalized_request,
             destination_name, destination_place_id, start_date, end_date, total_days,
             traveler_count)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::date, $9::date, $10, $11)
           RETURNING id`,
          [
            input.userId,
            input.clientRequestId,
            input.idempotencyKey,
            JSON.stringify(input.rawRequest),
            JSON.stringify(input.normalizedRequest),
            input.destinationName,
            input.destinationPlaceId,
            input.startDate,
            input.endDate,
            input.totalDays,
            input.travelerCount,
          ],
        );
        const requestId = request.rows[0]!.id;

        const plan = await client.query<{ id: string }>(
          `INSERT INTO travel_plans (
             user_id, request_id, status, destination_name, start_date, total_days)
           VALUES ($1, $2, 'GENERATING', $3, $4::date, $5)
           RETURNING id`,
          [input.userId, requestId, input.destinationName, input.startDate, input.totalDays],
        );
        const planId = plan.rows[0]!.id;

        const job = await client.query<{ id: string }>(
          `INSERT INTO generation_jobs (user_id, request_id, plan_id, status, progress, message)
           VALUES ($1, $2, $3, 'QUEUED', 0, $4)
           RETURNING id`,
          [input.userId, requestId, planId, '已加入队列，正在等待处理'],
        );

        await client.query('COMMIT');
        return { requestId, planId, jobId: job.rows[0]!.id };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isUniqueViolation(error)) {
          throw new UniqueViolationError(error.constraint ?? 'unknown');
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async findByIdempotencyKey(userId, key) {
      /*
       * `user_id` 谓词在这里是**必要的**，尽管 idempotency_key 已经含
       * user_id 因此全局唯一。理由是 13.9.4 的归并：归并**不重算**
       * idempotency_key（TP-2-27），因此改挂后库里会存在
       * 「key 是按匿名 id 算的、user_id 已经是注册 id」的行。
       * 不带 user_id 谓词的话，那个匿名用户（若未被清理）重放同一请求时
       * 会读到已经改挂给别人的任务。
       */
      const { rows } = await pool.query<{
        request_id: string;
        plan_id: string | null;
        job_id: string | null;
        job_status: string | null;
        created_at: Date;
      }>(
        `SELECT r.id AS request_id,
                j.plan_id,
                j.id AS job_id,
                j.status AS job_status,
                r.created_at
           FROM travel_requests r
           LEFT JOIN generation_jobs j ON j.request_id = r.id
          WHERE r.idempotency_key = $1
            AND r.user_id = $2
          ORDER BY j.created_at DESC
          LIMIT 1`,
        [key, userId],
      );

      const row = rows[0];
      if (row === undefined) return null;
      // 请求已落库但任务插入失败（不可能同事务发生，但读路径不该因此崩）
      if (row.plan_id === null || row.job_id === null || row.job_status === null) return null;

      return {
        requestId: row.request_id,
        planId: row.plan_id,
        jobId: row.job_id,
        jobStatus: row.job_status,
        createdAt: row.created_at,
      };
    },

    async findPlanForUser(planId, userId) {
      /*
       * `v.status IN ('READY','REPAIRED')` 在 0003 的触发器之外**再拦一次**。
       * 触发器已经禁止 REJECTED 版本成为 current_version_id，因此这个条件
       * 理论上恒真。保留它的理由：验收标准 15（「绝不展示未通过校验的草稿」）
       * 是这条链路唯一的对外承诺，而它现在依赖一个触发器 ——
       * 触发器被某次迁移意外删掉时，这一行仍然守着。
       */
      const { rows } = await pool.query<{
        plan_status: string;
        version_id: string;
        version_status: string;
        plan_json: unknown;
      }>(
        `SELECT p.status AS plan_status,
                v.id AS version_id,
                v.status AS version_status,
                v.plan_json
           FROM travel_plans p
           JOIN travel_plan_versions v ON v.id = p.current_version_id
          WHERE p.id = $1
            AND p.user_id = $2
            AND v.status IN ('READY', 'REPAIRED')`,
        [planId, userId],
      );

      const row = rows[0];
      if (row === undefined) return null;

      return {
        planId,
        planStatus: row.plan_status,
        planVersionId: row.version_id,
        versionStatus: row.version_status,
        planJson: row.plan_json,
      };
    },

    async findJobForUser(jobId, userId) {
      const { rows } = await pool.query<{
        id: string;
        plan_id: string | null;
        status: string;
        progress: number;
        message: string | null;
        error_code: string | null;
        warnings: unknown;
      }>(
        `SELECT id, plan_id, status, progress, message, error_code, warnings
           FROM generation_jobs
          WHERE id = $1 AND user_id = $2`,
        [jobId, userId],
      );

      const row = rows[0];
      if (row === undefined) return null;

      return {
        jobId: row.id,
        planId: row.plan_id,
        status: row.status,
        progress: row.progress,
        message: row.message,
        errorCode: row.error_code,
        warnings: row.warnings,
      };
    },

    async listPlansForUser({ userId, limit, cursor }) {
      const decoded = cursor === undefined ? null : decodeCursor(cursor);

      /*
       * 多取一条判断 has_more，而不是再发一次 COUNT。
       * COUNT 在翻页中途会因为新计划插入而变化，导致 has_more 与实际不符 ——
       * 前端据此隐藏「加载更多」，用户就再也看不到剩下的计划。
       */
      const { rows } = await pool.query<{
        id: string;
        title: string | null;
        destination_name: string;
        start_date: string;
        total_days: number;
        status: string;
        created_at: Date;
      }>(
        `SELECT id, title, destination_name, start_date::text AS start_date,
                total_days, status, created_at
           FROM travel_plans
          WHERE user_id = $1
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [userId, decoded?.createdAt ?? null, decoded?.id ?? null, limit + 1],
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items: PlanListItem[] = page.map((row) => ({
        planId: row.id,
        title: row.title,
        destinationName: row.destination_name,
        startDate: row.start_date,
        totalDays: row.total_days,
        status: row.status,
        createdAt: row.created_at,
      }));

      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      };
    },
  };
}
