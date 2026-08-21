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
  /**
   * T1/T2 里程碑时刻（21.2 措施一）。
   *
   * ## 为什么要出现在读路径上
   *
   * 21.2 的原文是「客户端据此提前展示，而不是等 `status === 'COMPLETED'`」——
   * 也就是说这两列的**目标消费者是客户端**。R-34 补了列、P5 接了指标，
   * 但两者都在服务端：客户端读不到，那句「据此」就没有对象。
   *
   * 与 `status` 的分工：`status` 说「现在在哪个阶段」，里程碑说
   * 「哪些东西已经可以看了」。前端可以只看 status（P2 就是这么做的），
   * 但那要求它记住「`SAVING_PLAN` 及之后计划可读」这条映射 ——
   * 而那条映射属于服务端的状态机，不该复制到客户端。
   */
  readonly t1At: Date | null;
  readonly t2At: Date | null;
}

/** 13.9.5 列表项。**刻意不含 `retrieval_projection`**（二十章 L2、TP-2-30） */
export interface PlanListItem {
  readonly planId: string;
  readonly title: string | null;
  readonly destinationName: string;
  readonly startDate: string;
  readonly totalDays: number;
  readonly status: string;
  /**
   * 封面图（13.9.5 的 `cover_url`）。
   *
   * 取当前版本第 1 天 Hero 槽位绑定的素材缩略图。用缩略图而不是原图：
   * 列表页可能同时显示 20 个封面，原图（最大 2400 宽）会让首屏多下载几十 MB。
   * 没有绑定时为 null，前端渲染渐变占位。
   */
  readonly coverUrl: string | null;
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

/** Worker 侧推进任务需要的上下文（13.1 的载荷只带 ID，内容从库里读回） */
export interface JobContext {
  readonly jobId: string;
  readonly requestId: string;
  readonly planId: string;
  readonly userId: string;
  /**
   * 身份类型（21.4）。
   *
   * Worker 需要它来定 AI Hero 额度（匿名为 0，TP-4-17），也用作
   * `travel_ai_image_total` 的 `user_type` 标签（21.3 的 R-13 通用维度）。
   * 从 `users` join 出来而不是塞进队列载荷：载荷只放标识符（见 @tps/queue），
   * 而身份类型会变（匿名升级为注册），载荷里那份会过期。
   */
  readonly userType: 'ANONYMOUS' | 'REGISTERED';
  /**
   * 用户分层等级（迁移 0009 的 `users.tier_level`，默认 0）。
   *
   * Worker 用它按 `tier_model_pools` 选候选模型池。与 `userType` 一起
   * 从 `users` join 出来而不是塞进队列载荷：等级会变（用户升级订阅），
   * 载荷里那份在任务排队期间就可能过期，而排队本身可能持续几分钟。
   */
  readonly tierLevel: number;
  readonly status: JobStatusValue;
  readonly progress: number;
  /** `travel_requests.normalized_request`，由调用方用 schema 解析 */
  readonly normalizedRequest: unknown;
}

/**
 * 取消的三种结局。
 *
 * `already_terminal` 与 `not_found` 必须分开：前者返回 200（幂等，任务确实
 * 已经不在跑了），后者返回 404。合成一个的话，用户对一个已完成的任务点
 * 「取消」会看到「未找到该任务」—— 而它明明就在页面上。
 */
export type CancelJobResult = 'cancelled' | 'already_terminal' | 'not_found';

export interface UpdateJobStateInput {
  readonly jobId: string;
  readonly to: JobStatusValue;
  /** 16.2 查表得到的目标进度。实际写入取 `GREATEST(现值, 该值)` */
  readonly progress: number;
  readonly message: string | null;
  /** 期望的当前状态。给出时用于乐观并发控制（16.1 的合法转移） */
  readonly from?: JobStatusValue;
  readonly errorCode?: string;
  readonly planVersionId?: string;
  /**
   * 已结束阶段的耗时毫秒数增量（十五章的 `stage_timings`，TP-5-01）。
   *
   * 挂在状态推进上而不是单独一次 UPDATE：状态与 progress 本来就要在同一事务里
   * 写（16.1），顺带写这一列是零额外往返。分开写的代价不只是性能 ——
   * 两条语句之间进程被杀，库里就会出现「状态已推进但耗时缺一段」的行。
   *
   * SQL 侧用 `stage_timings || $n::jsonb` 合并，因此传增量即可，同名键覆盖。
   */
  readonly stageTimings?: Readonly<Record<string, number>>;
}

/**
 * 入队时刻与已排队时长（R-40）。
 *
 * 两个字段都由**数据库时钟**给出。`queuedForMs` 是「到读取这一刻为止
 * 排了多久」，进程侧据此推算任意后续时刻的「从入队算起」耗时：
 * `queuedForMs + (t - 读取时刻)`。
 */
export interface JobQueueTiming {
  readonly createdAt: Date;
  readonly queuedForMs: number;
}

export interface SavePlanVersionInput {
  /**
   * 版本 ID 由**调用方**生成，不用数据库的 `gen_random_uuid()` 默认值。
   *
   * 理由是 `plan_json` 里必须含 `plan_version_id`（六章的 `TravelPlan`
   * 三个 ID 都是必填）。让数据库生成的话，插入完成才知道 ID，
   * 而那时 `plan_json` 已经写进去了 —— 只能再 UPDATE 一次，
   * 中间那一瞬间库里存着一份读不回来的计划（`TravelPlanSchema` 会拒绝它）。
   */
  readonly versionId: string;
  readonly planId: string;
  readonly status: 'READY' | 'REPAIRED' | 'REJECTED';
  readonly planJson: unknown;
  readonly constraintReport: unknown;
  /** 3.2.4 的脱敏投影。NOT NULL，因此**必须**在这里就构造好 */
  readonly retrievalProjection: unknown;
  readonly destinationPlaceId: string | null;
  readonly totalDays: number;
  /** 15.2：必须由投影计算。null 表示向量化失败，检索时该版本不参与 */
  readonly planEmbedding: readonly number[] | null;
  readonly title: string | null;
  readonly llmModel: string | null;
  readonly llmPromptVersion: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly repairIterations: number;
  readonly regenerationCount: number;
}

export interface SavedPlanVersion {
  readonly versionId: string;
  readonly versionNumber: number;
  /** 是否被设为 `current_version_id`（REJECTED 永远不会） */
  readonly promoted: boolean;
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

  /**
   * Worker 侧：按 job_id 读回上下文。
   *
   * **没有 `userId` 参数** —— 这是 13.0 的例外之一，且理由与检索路径不同：
   * Worker 消费的是自己入队的任务，队列载荷里的 `userId` 就是归属，
   * 再加一个谓词只会让「载荷与库里不一致」这种真正的故障被静默跳过。
   */
  findJobContext(jobId: string): Promise<JobContext | null>;

  /** 状态与进度同事务更新（16.1），进度取 `GREATEST` 保证单调不减（16.2） */
  updateJobState(input: UpdateJobStateInput): Promise<boolean>;

  /**
   * 记录 T1 / T2 里程碑时刻（21.2 措施一，TP-4-14）。
   *
   * 只写一次：`COALESCE(t1_at, NOW())` —— 重试导致的第二次到达不该覆盖
   * 首次时刻。覆盖的后果是 SLA 统计里那个任务的 T1 变成「重试成功的时刻」，
   * 而用户真正等到计划可读的时间是第一次。
   *
   * T2 另取 `GREATEST(NOW(), t1_at)` 以保证 T1 ≤ T2（R-41，见实现）。
   */
  markMilestone(jobId: string, milestone: 't1' | 't2'): Promise<void>;

  /**
   * 用户主动取消（16.1「任意非终态 → CANCELLED」，TP-4-08）。
   *
   * 带 `user_id` 谓词（13.0）：取消是写操作，越权取消别人的任务比越权
   * 读取更严重 —— 它会让对方的计划永久停在一个不会继续的状态上。
   *
   * `progress` 保持当前值（16.2）。
   */
  cancelJob(jobId: string, userId: string): Promise<CancelJobResult>;

  /**
   * 追加非阻断告警码（13.7、16.3，TP-4-09）。
   *
   * 合并去重在 SQL 里做（`jsonb` 数组的并集），不是「读出来 → 合并 → 写回」：
   * 后者在并发写入时会互相覆盖，而素材解析本来就是并发的（21.2 天级 8）。
   * 丢掉一个告警码的表现是排查时看不到某一类降级发生过。
   */
  appendJobWarnings(jobId: string, codes: readonly string[]): Promise<void>;

  /**
   * 16.3 的队列等待上限判定所需：入队时刻**与已排队时长**。
   *
   * 单独一个方法而不是塞进 `findJobContext`：队列超时的判定发生在
   * **消费的第一件事**，而那时还没必要读回标准化请求（它可能有几十 KB）。
   *
   * ## 为什么排队时长由数据库算（R-40）
   *
   * `created_at` 来自数据库时钟，而 Worker 只有自己的 `Date.now()`。
   * 两者相减就是跨时钟比较 —— 生产上 Worker 与数据库在不同机器上，
   * NTP 偏差几十毫秒是常态，容器宿主休眠后偏差能到几秒。
   * 实测中这让 `stage_timings.total` 出现了**负数**。
   *
   * 让数据库同时给出 `NOW() - created_at`，两个时刻就来自同一个时钟。
   * 之后进程侧只做「排队时长 + 进程内经过的时长」的加法，不再有跨时钟相减。
   */
  findJobQueueTiming(jobId: string): Promise<JobQueueTiming | null>;

  /** TP-2-14：写版本 + 提升 `current_version_id`，同一事务 */
  savePlanVersion(input: SavePlanVersionInput): Promise<SavedPlanVersion>;
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
        t1_at: Date | null;
        t2_at: Date | null;
      }>(
        `SELECT id, plan_id, status, progress, message, error_code, warnings, t1_at, t2_at
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
        t1At: row.t1_at,
        t2At: row.t2_at,
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
        cover_url: string | null;
        created_at: Date;
      }>(
        /*
         * 封面走两次 LEFT JOIN 而不是子查询：绑定表的唯一约束是
         * (plan_version_id, template_id, slot_id)，加上 role 与 day_number
         * 的过滤后最多命中一行，因此不会让结果集变多。
         * LEFT JOIN 保证「还没解析素材的计划」仍然出现在列表里 ——
         * 内连接会让刚提交的计划从历史列表里消失。
         */
        `SELECT p.id, p.title, p.destination_name, p.start_date::text AS start_date,
                p.total_days, p.status, p.created_at,
                COALESCE(a.thumbnail_url, a.storage_url) AS cover_url
           FROM travel_plans p
           LEFT JOIN plan_asset_bindings b
                  ON b.plan_version_id = p.current_version_id
                 AND b.role = 'HERO_BACKGROUND'
                 AND b.day_number = 1
           LEFT JOIN assets a
                  ON a.id = b.asset_id
                 AND a.status = 'ACTIVE'
          WHERE p.user_id = $1
            AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
          ORDER BY p.created_at DESC, p.id DESC
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
        coverUrl: row.cover_url,
        createdAt: row.created_at,
      }));

      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      };
    },

    async findJobContext(jobId) {
      const { rows } = await pool.query<{
        id: string;
        request_id: string;
        plan_id: string | null;
        user_id: string;
        user_type: string;
        tier_level: number;
        status: string;
        progress: number;
        normalized_request: unknown;
      }>(
        `SELECT j.id, j.request_id, j.plan_id, j.user_id, j.status, j.progress,
                u.user_type, u.tier_level, r.normalized_request
           FROM generation_jobs j
           JOIN travel_requests r ON r.id = j.request_id
           JOIN users u ON u.id = j.user_id
          WHERE j.id = $1`,
        [jobId],
      );

      const row = rows[0];
      if (row === undefined || row.plan_id === null) return null;

      return {
        jobId: row.id,
        requestId: row.request_id,
        planId: row.plan_id,
        userId: row.user_id,
        userType: row.user_type === 'REGISTERED' ? 'REGISTERED' : 'ANONYMOUS',
        // 列是 NOT NULL DEFAULT 0；兜底是为了迁移未跑完时不至于 NaN 传下去
        tierLevel: Number(row.tier_level ?? 0),
        status: row.status,
        progress: row.progress,
        normalizedRequest: row.normalized_request,
      };
    },

    async updateJobState(input) {
      const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'];
      const isTerminal = terminal.includes(input.to);

      /*
       * `GREATEST(progress, $3)` 而不是直接赋值：16.2 要求 progress 单调不减，
       * 而回边（REPAIRING_PLAN → VALIDATING_PLAN）的表值是往下走的。
       * 放在 SQL 里而不是应用层，是因为并发写入时应用层的
       * 「读-比较-写」会互相覆盖 —— 而 SQL 的 GREATEST 是原子的。
       *
       * `finished_at` 必须与终态一致（0003 有 CHECK 约束），因此在同一条
       * 语句里按状态设值，不能留给调用方。
       */
      const { rowCount } = await pool.query(
        `UPDATE generation_jobs
            SET status = $2,
                progress = GREATEST(progress, $3::smallint),
                message = $4,
                error_code = COALESCE($5, error_code),
                plan_version_id = COALESCE($6::uuid, plan_version_id),
                started_at = COALESCE(started_at, NOW()),
                finished_at = CASE WHEN $7::boolean THEN NOW() ELSE finished_at END,
                stage_timings = stage_timings || $10::jsonb,
                updated_at = NOW()
          WHERE id = $1
            AND ($8::text IS NULL OR status = $8::text)
            AND status <> ALL($9::text[])`,
        [
          input.jobId,
          input.to,
          input.progress,
          input.message,
          input.errorCode ?? null,
          input.planVersionId ?? null,
          isTerminal,
          input.from ?? null,
          terminal,
          /*
           * 空对象而不是 null：`jsonb || NULL` 的结果是 NULL，会把已积累的
           * 耗时全部清掉。而 `jsonb || '{}'` 是恒等操作，因此不传耗时的调用方
           * （例如取消、或 P2 时期的老代码路径）不受影响。
           */
          JSON.stringify(input.stageTimings ?? {}),
        ],
      );

      return (rowCount ?? 0) > 0;
    },

    async markMilestone(jobId, milestone) {
      /*
       * R-41：T2 取 `GREATEST(NOW(), t1_at)`，不是裸的 `NOW()`。
       *
       * 「T1 先于 T2」是业务不变量（文字版计划必然先于带图页面可读），
       * 但用两次 `NOW()` 表达它，等于假设数据库时钟单调递增 ——
       * 而那个假设会被 NTP 回拨打破。本机实测中容器时钟被拉回过 1.6 秒，
       * 结果 `t1_at > t2_at`，SLA 统计里那个任务的 T2 成了负数。
       *
       * 与 `progress` 用 `GREATEST` 保证单调不减是同一手法、同一理由：
       * 顺序不变量放进 SQL，而不是依赖调用顺序加时钟精度。
       *
       * `GREATEST` 忽略 NULL，因此 T1 未写过时（异常路径）它退化为 `NOW()`。
       */
      const assignment =
        milestone === 't1'
          ? 't1_at = COALESCE(t1_at, NOW())'
          : 't2_at = COALESCE(t2_at, GREATEST(NOW(), t1_at))';
      await pool.query(
        `UPDATE generation_jobs SET ${assignment}, updated_at = NOW() WHERE id = $1`,
        [jobId],
      );
    },

    async cancelJob(jobId, userId) {
      /*
       * 一条语句完成「存在性 + 归属 + 非终态」三重判定，靠 RETURNING 区分结局。
       * 分成「先查再更新」的话，两步之间任务可能刚好完成 —— 那时会把一个
       * 已完成的任务改成 CANCELLED，用户的计划凭空消失。
       */
      const { rows } = await pool.query<{ status: string }>(
        `WITH target AS (
           SELECT id, status FROM generation_jobs WHERE id = $1 AND user_id = $2
         ), updated AS (
           UPDATE generation_jobs j
              SET status = 'CANCELLED',
                  -- 16.2：CANCELLED 保持当前 progress
                  message = $3,
                  finished_at = NOW(),
                  updated_at = NOW()
             FROM target t
            WHERE j.id = t.id
              AND j.status <> ALL($4::text[])
           RETURNING j.status
         )
         SELECT status FROM updated
         UNION ALL
         SELECT 'ALREADY_TERMINAL' FROM target
          WHERE NOT EXISTS (SELECT 1 FROM updated)`,
        [jobId, userId, '已取消生成', ['COMPLETED', 'FAILED', 'CANCELLED']],
      );

      const row = rows[0];
      if (row === undefined) return 'not_found';
      return row.status === 'CANCELLED' ? 'cancelled' : 'already_terminal';
    },

    async appendJobWarnings(jobId, codes) {
      if (codes.length === 0) return;
      /*
       * `jsonb` 的并集：把现有数组与新数组拼起来，用 `jsonb_agg(DISTINCT …)`
       * 去重。`COALESCE` 兜住空数组（`jsonb_agg` 对空集返回 NULL）。
       *
       * 顺序按去重后的文本序而不是首次出现序 —— 数组本身是集合语义
       * （13.7 的告警码集合），顺序不承载信息。
       */
      await pool.query(
        `UPDATE generation_jobs
            SET warnings = COALESCE(
                  (SELECT jsonb_agg(DISTINCT value)
                     FROM jsonb_array_elements(warnings || $2::jsonb) AS t(value)),
                  '[]'::jsonb
                ),
                updated_at = NOW()
          WHERE id = $1`,
        [jobId, JSON.stringify(codes)],
      );
    },

    async findJobQueueTiming(jobId) {
      const { rows } = await pool.query<{ created_at: Date; queued_for_ms: string }>(
        `SELECT created_at,
                -- 毫秒取整：stage_timings 存的是整数毫秒（十五章）
                round(EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::text AS queued_for_ms
           FROM generation_jobs
          WHERE id = $1`,
        [jobId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        createdAt: row.created_at,
        /*
         * 钳到非负：`NOW()` 一定不早于 `created_at`（同一个时钟、
         * 且行已提交），但重放老数据或手工改过 `created_at` 的行不该
         * 让下游算出负耗时。
         */
        queuedForMs: Math.max(0, Number(row.queued_for_ms)),
      };
    },

    async savePlanVersion(input) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');

        /*
         * 版本号在事务里取 `MAX + 1`。`travel_plan_versions` 上有
         * `UNIQUE (plan_id, version_number)`，因此两个并发写入里必有一个
         * 冲突失败 —— 这正是想要的：同一计划不该被两个 Worker 同时保存
         * （13.8 的 `lock:job:{job_id}` 是第一道防线，这里是最后一道）。
         */
        const next = await client.query<{ version_number: number }>(
          `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
             FROM travel_plan_versions WHERE plan_id = $1`,
          [input.planId],
        );
        const versionNumber = next.rows[0]?.version_number ?? 1;

        const version = await client.query<{ id: string }>(
          `INSERT INTO travel_plan_versions (
             id, plan_id, version_number, status, plan_json, constraint_report,
             retrieval_projection, destination_place_id, total_days,
             llm_model, llm_prompt_version, input_tokens, output_tokens,
             repair_iterations, regeneration_count, plan_embedding)
           VALUES ($16::uuid, $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8,
                   $9, $10, $11, $12, $13, $14, $15::vector)
           RETURNING id`,
          [
            input.planId,
            versionNumber,
            input.status,
            JSON.stringify(input.planJson),
            JSON.stringify(input.constraintReport),
            JSON.stringify(input.retrievalProjection),
            input.destinationPlaceId,
            input.totalDays,
            input.llmModel,
            input.llmPromptVersion,
            input.inputTokens,
            input.outputTokens,
            input.repairIterations,
            input.regenerationCount,
            input.planEmbedding === null ? null : `[${input.planEmbedding.join(',')}]`,
            input.versionId,
          ],
        );
        const versionId = version.rows[0]!.id;

        /*
         * 3.2.2 / 验收标准 15：`REJECTED` 版本只落库供排查，**不提升**为
         * 当前版本。数据库的触发器也会拒绝这么做，这里的分支是为了让
         * 「不提升」成为显式意图而不是依赖异常。
         */
        const promoted = input.status !== 'REJECTED';
        if (promoted) {
          await client.query(
            `UPDATE travel_plans
                SET current_version_id = $2,
                    status = 'READY',
                    title = COALESCE($3, title),
                    updated_at = NOW()
              WHERE id = $1`,
            [input.planId, versionId, input.title],
          );
        }

        await client.query('COMMIT');
        return { versionId, versionNumber, promoted };
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
  };
}
