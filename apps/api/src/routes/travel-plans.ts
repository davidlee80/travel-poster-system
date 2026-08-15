import type { PlanQueue } from '@tps/queue';
import { prepareTravelRequest } from '@tps/planning';
import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  computeIdempotencyKey,
  type IdempotencyLock,
  type QuotaDecision,
  type QuotaGuard,
} from '@tps/shared';
import { UniqueViolationError, type ExistingGeneration, type TravelPlansRepository } from '@tps/db';
import {
  TravelRequestUISchema,
  isTerminalJobStatus,
  stageMessage,
  type JobStatus,
} from '@tps/schemas';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  buildErrorBody,
  errorDefinition,
  messageForCode,
  type ErrorCode,
} from '../errors/codes.js';
import { resolveIdentity, type IdentityContextDeps } from './identity-context.js';

/**
 * 计划相关业务端点（TP-2-06、TP-2-09、TP-2-15、TP-2-28）。
 *
 * 13.1  POST /api/v1/travel-plans/generate
 * 13.2  GET  /api/v1/generation-jobs/{job_id}
 * 13.3  GET  /api/v1/travel-plans/{plan_id}
 * 13.9.5 GET /api/v1/travel-plans
 *
 * ## 13.0 的两条硬约束在这一层的落点
 *
 * **归属**：每个读取都把 `userId` 传给仓储，由 SQL 强制过滤；他人资源
 * 一律 `404 PLAN_NOT_FOUND`，不用 403 —— 403 会告诉攻击者「这个 ID 存在，
 * 只是不属于你」，等于给了一个枚举计划 ID 的接口。
 *
 * **L2 数据不出网**：响应结构里没有任何 `retrieval_projection`
 * （二十章、TP-2-30）。仓储的返回类型本身就不含它，因此这不是「记得别返回」，
 * 而是「拿不到」。
 */

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(500).optional(),
});

export const DEFAULT_LIST_LIMIT = 20;

export interface TravelPlanRoutesDeps extends IdentityContextDeps {
  readonly plans: TravelPlansRepository;
  readonly quota: QuotaGuard;
  readonly queue: PlanQueue;
  readonly idempotencyLock: IdempotencyLock;
  /** 注入以便测试可控时间 */
  readonly now: () => Date;
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  extra?: { readonly field?: string; readonly retryAfterSeconds?: number | null },
): FastifyReply {
  const definition = errorDefinition(code);
  if (extra?.retryAfterSeconds != null) {
    reply.header('retry-after', String(extra.retryAfterSeconds));
  }
  return reply.code(definition.httpStatus).send(
    buildErrorBody(code, {
      requestId: request.id,
      traceId: 'unavailable',
      ...(extra?.field === undefined ? {} : { field: extra.field }),
    }),
  );
}

/** 21.4 的拒绝原因 → 13.7 错误码 */
function quotaErrorCode(decision: Extract<QuotaDecision, { allowed: false }>): ErrorCode {
  switch (decision.reason) {
    case 'RATE_LIMITED_PER_MINUTE':
      return 'AUTH_RATE_LIMITED';
    case 'DAILY_QUOTA_EXCEEDED':
    case 'MONTHLY_QUOTA_EXCEEDED':
    case 'IP_DAILY_QUOTA_EXCEEDED':
    case 'EXPORT_QUOTA_EXCEEDED':
      return 'AUTH_QUOTA_EXCEEDED';
    case 'IP_ANON_CREATE_RATE_LIMITED':
      return 'AUTH_ANON_CREATION_RATE_LIMITED';
  }
}

interface GenerateResponse {
  readonly request_id: string;
  readonly plan_id: string;
  readonly job_id: string;
  readonly status: JobStatus;
}

function generateResponse(existing: ExistingGeneration): GenerateResponse {
  return {
    request_id: existing.requestId,
    plan_id: existing.planId,
    job_id: existing.jobId,
    status: existing.jobStatus as JobStatus,
  };
}

export function registerTravelPlanRoutes(app: FastifyInstance, deps: TravelPlanRoutesDeps): void {
  const { plans, quota, queue, idempotencyLock } = deps;

  /**
   * 13.1 创建生成任务。
   *
   * 幂等流程（13.8）：
   * ```text
   * 标准化 + 同步校验     失败直接 4xx，不占用幂等键、不计配额
   * 查既有请求            命中 → 200/409（幂等命中不计入配额，21.4）
   * SETNX 快路径          抢不到 → 409（另一个请求正在插入）
   * 扣配额                超限 → 429
   * INSERT                唯一索引冲突 → 回到「查既有请求」
   * 入队 → 201
   * ```
   *
   * 顺序里最容易写反的是**先查既有再扣配额**。反过来的话，用户刷新页面
   * 重试会命中幂等但已经被扣了一次额度 —— 21.4 明确「幂等命中不计入配额」。
   */
  app.post('/api/v1/travel-plans/generate', async (request, reply) => {
    // 13.0 第 3.a 条：生成端点永不因为缺少身份而返回 401，它会为访客现场建号
    const resolved = await resolveIdentity(deps, request, reply, {
      allowAnonymousCreation: true,
    });
    if (resolved === null) return reply;

    const parsed = TravelRequestUISchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: parsed.error.issues[0]?.path.join('.') ?? 'body',
      });
    }

    const prepared = prepareTravelRequest(parsed.data, { now: deps.now() });
    if (!prepared.ok) {
      /*
       * 3.1.2 的冲突检查在**同步**路径上执行，失败直接 4xx，不入队、
       * 不调用 LLM。这一点是成本控制的关键：一次 LLM 调用几分钱，
       * 而「出发日期在过去」这类错误在入队前就能拦住。
       */
      const field = prepared.violations[0]?.field;
      return fail(request, reply, prepared.code, field === undefined ? {} : { field });
    }

    const normalized = prepared.normalized;
    const idempotencyKey = computeIdempotencyKey({
      userId: resolved.identity.userId,
      clientRequestId: normalized.client_request_id,
      normalized,
    });

    const existing = await plans.findByIdempotencyKey(resolved.identity.userId, idempotencyKey);
    if (existing !== null) {
      if (!isTerminalJobStatus(existing.jobStatus as JobStatus)) {
        // 13.8：进行中 → 409 并携带既有 job_id，客户端应改为轮询它
        reply.header('x-tps-job-id', existing.jobId);
        return fail(request, reply, 'JOB_ALREADY_RUNNING');
      }
      return reply.code(200).send(generateResponse(existing));
    }

    /*
     * Redis 锁是快路径。**它不可用时必须放行**（fail open）：
     * 13.8 明确唯一索引才是最终真相。这里把异常当成「抢到了」，
     * 后面的唯一索引冲突分支会兜住重复提交 —— 反过来 fail closed 的话，
     * Redis 一挂全站无法生成计划。
     */
    let acquired = true;
    try {
      acquired = await idempotencyLock.acquire(idempotencyKey, IDEMPOTENCY_LOCK_TTL_SECONDS);
    } catch {
      acquired = true;
    }

    if (!acquired) {
      /*
       * 锁被占用但库里还没有行：另一个并发请求正处在「已抢锁、未插入」之间。
       * 返回 409 而不是等待 —— 客户端拿到 409 后轮询任务状态，
       * 而等待会把 HTTP 请求挂在那里，并发一高就耗尽连接。
       */
      const raced = await plans.findByIdempotencyKey(resolved.identity.userId, idempotencyKey);
      if (raced !== null && isTerminalJobStatus(raced.jobStatus as JobStatus)) {
        return reply.code(200).send(generateResponse(raced));
      }
      if (raced !== null) reply.header('x-tps-job-id', raced.jobId);
      return fail(request, reply, 'JOB_ALREADY_RUNNING');
    }

    const decision = await quota.consumeGeneration({
      userId: resolved.identity.userId,
      userType: resolved.identity.userType,
      ip: request.ip,
      dailyQuotaOverride: resolved.identity.dailyQuota,
      monthlyQuotaOverride: resolved.identity.monthlyQuota,
    });
    if (!decision.allowed) {
      return fail(request, reply, quotaErrorCode(decision), {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    let handles;
    try {
      handles = await plans.createGeneration({
        userId: resolved.identity.userId,
        clientRequestId: normalized.client_request_id,
        idempotencyKey,
        rawRequest: parsed.data,
        normalizedRequest: normalized,
        destinationName: normalized.destination_name,
        destinationPlaceId: normalized.destination_place_id ?? null,
        startDate: normalized.start_date,
        endDate: normalized.end_date,
        totalDays: normalized.total_days,
        travelerCount: normalized.traveler_count,
      });
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;

      // 唯一索引兜底命中（Redis 不可用时的正常路径）
      const raced = await plans.findByIdempotencyKey(resolved.identity.userId, idempotencyKey);
      if (raced === null) return fail(request, reply, 'SYS_INTERNAL_ERROR');
      if (!isTerminalJobStatus(raced.jobStatus as JobStatus)) {
        reply.header('x-tps-job-id', raced.jobId);
        return fail(request, reply, 'JOB_ALREADY_RUNNING');
      }
      return reply.code(200).send(generateResponse(raced));
    }

    await queue.enqueue({
      jobId: handles.jobId,
      requestId: handles.requestId,
      planId: handles.planId,
      userId: resolved.identity.userId,
    });

    return reply.code(201).send({
      request_id: handles.requestId,
      plan_id: handles.planId,
      job_id: handles.jobId,
      status: 'QUEUED',
    } satisfies GenerateResponse);
  });

  /** 13.2 查询任务状态 */
  app.get<{ Params: { job_id: string } }>(
    '/api/v1/generation-jobs/:job_id',
    async (request, reply) => {
      const resolved = await resolveIdentity(deps, request, reply, {
        allowAnonymousCreation: false,
      });
      if (resolved === null) return reply;

      const job = await plans.findJobForUser(request.params.job_id, resolved.identity.userId);
      // 他人的任务与不存在的任务返回同一个 404（13.0）
      if (job === null) return fail(request, reply, 'JOB_NOT_FOUND');

      const status = job.status as JobStatus;
      return reply.code(200).send({
        job_id: job.jobId,
        status,
        /*
         * `progress` 取库里的值而不是查表重算：16.2 要求单调不减，
         * 而单调性由写入路径的 `nextProgress` 保证。读路径重算会在回边处
         * 把 54 显示成 48 —— 进度条倒退。
         */
        progress: job.progress,
        message: job.message ?? stageMessage(status, jobErrorMessage(job.errorCode)),
        ...(job.errorCode === null ? {} : { error_code: job.errorCode }),
      });
    },
  );

  /** 13.3 获取计划（完整 TravelPlan） */
  app.get<{ Params: { plan_id: string } }>(
    '/api/v1/travel-plans/:plan_id',
    async (request, reply) => {
      const resolved = await resolveIdentity(deps, request, reply, {
        allowAnonymousCreation: false,
      });
      if (resolved === null) return reply;

      const plan = await plans.findPlanForUser(request.params.plan_id, resolved.identity.userId);
      /*
       * 三种情况共用这个 404：不存在、不属于你、当前版本是 REJECTED。
       * 验收标准 15 要求「绝不展示未通过校验的草稿」，而把它做成一个
       * 独立错误码会顺带泄漏「这个计划存在但生成失败了」。
       */
      if (plan === null) return fail(request, reply, 'PLAN_NOT_FOUND');

      return reply.code(200).send(plan.planJson);
    },
  );

  /** 13.9.5 计划列表（对匿名与注册行为一致） */
  app.get('/api/v1/travel-plans', async (request, reply) => {
    const resolved = await resolveIdentity(deps, request, reply, {
      allowAnonymousCreation: false,
    });
    if (resolved === null) return reply;

    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: query.error.issues[0]?.path.join('.') ?? 'query',
      });
    }

    const page = await plans.listPlansForUser({
      userId: resolved.identity.userId,
      limit: query.data.limit,
      ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
    });

    return reply.code(200).send({
      items: page.items.map((item) => ({
        plan_id: item.planId,
        title: item.title,
        destination_name: item.destinationName,
        start_date: item.startDate,
        total_days: item.totalDays,
        status: item.status,
        /*
         * 封面图来自素材绑定（P3 的 TP-3-xx）。现在返回 null 而不是省略
         * 这个键：前端按 13.9.5 的响应结构写死了字段名，省略会让它读到
         * undefined 并渲染出破图。
         */
        cover_url: null,
        created_at: item.createdAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    });
  });
}

/**
 * FAILED 任务的用户文案取自 13.7 错误码（16.2）。
 *
 * 用 `messageForCode` 而不是 `errorDefinition`：库里的 `error_code` 是
 * `VARCHAR(60)`，可能是旧版本写入或改名后失效的码。查不到时返回 undefined，
 * 由 `stageMessage` 给兜底文案 —— 而不是把 `undefined` 拼进响应。
 */
function jobErrorMessage(errorCode: string | null): string | undefined {
  return errorCode === null ? undefined : messageForCode(errorCode);
}
