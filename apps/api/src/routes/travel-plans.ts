import { captureTraceContext, type PlanQueue } from '@tps/queue';
import { prepareTravelRequest } from '@tps/planning';
import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  computeIdempotencyKey,
  decideFeature,
  type FeatureFlags,
  type IdempotencyLock,
  type QuotaDecision,
  type QuotaGuard,
} from '@tps/shared';
import {
  UniqueViolationError,
  type ExistingGeneration,
  type PlannerConfigRepository,
  type PresentationsRepository,
  type TravelPlansRepository,
} from '@tps/db';
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
import { ALL_FEATURES_ON, featureGateTotal } from '../feature-gate.js';
import { recordCreditGate } from '../credits/metrics.js';
import type { CreditsService, JobCreditCheck } from '../credits/service.js';
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

/** 13.4 的可选版本参数。UUID 形态在仓储层由 `::uuid` 转换兜住 */
const PresentationQuerySchema = z.object({
  plan_version_id: z.string().uuid().optional(),
});

export const DEFAULT_LIST_LIMIT = 20;

/**
 * 这个配置选项装的是不是条件机器码。
 *
 * ## 这个判定为什么这么要紧
 *
 * `conflicts.ts` 那一行是
 * `allowedConditionCodes?.has(code) ?? isKnownConditionCode(code)`，是 `??`
 * 而不是并集 —— 一旦库里有已发布配置，`CONDITION_CODE_VALUES` 这份内置字典
 * 就完全不参与判断。因此**这个函数漏掉一个码，那个码就被 N-08 拒**，
 * 而界面上那个标签看起来完全正常：用户点它、勾它、提交，
 * 然后收到一句「存在暂不支持的偏好条件」。
 *
 * 本地开发与单测通常不装配置中心（`plannerConfig` 为 undefined），
 * 因此这类缺陷在开发期完全看不见，只能靠 `planner-config-coverage.test.ts`。
 *
 * ## 为什么从「field_key 以 tags 结尾」改成读 metadata
 *
 * 后缀约定有两个问题，第二个是致命的：
 *
 * 1. 0012 起 field_key 是**载荷路径**（`transport.intercity_modes`、
 *    `lodging.amenities`），装条件码的路径一个都不以 tags 结尾。
 * 2. 更要紧的是它从来不够用 —— 61 个条件码里有 18 个**界面上没有标签**
 *    （由前端 `request.ts` 从枚举答案投影出来：饮食要求 → `diet.*`、
 *    行动能力 → `accessibility.*`）。它们必须进白名单，却挂不到任何
 *    界面路径下，因此不可能靠「哪个界面字段以 tags 结尾」找到它们。
 *    0012 把它们放在 `conditions.projected` 下。
 *
 * 于是判据变成显式声明：`metadata.value_kind === 'CONDITION_CODE'`。
 *
 * ## 未标注的行回退到旧后缀约定
 *
 * 0010 / 0011 插入的行没有 `value_kind`。迁移是前向的，而 API 与数据库的部署
 * **不是原子的** —— 「新 API 已上线、库还停在 0011」这个中间态如果让白名单
 * 变成空集，那一段时间里**所有**带条件码的请求都会被拒。
 * 因此未标注时沿用旧判据，等 0012 应用后这条分支自然不再被走到。
 */
export function isConditionCodeOption(
  fieldKey: string,
  metadata: Readonly<Record<string, unknown>>,
): boolean {
  const kind = metadata['value_kind'];
  if (typeof kind === 'string') return kind === 'CONDITION_CODE';
  return fieldKey.endsWith('tags');
}

export interface TravelPlanRoutesDeps extends IdentityContextDeps {
  readonly plans: TravelPlansRepository;
  /** 13.4 的展示数据（P3 起） */
  readonly presentations: PresentationsRepository;
  readonly quota: QuotaGuard;
  readonly queue: PlanQueue;
  readonly idempotencyLock: IdempotencyLock;
  /**
   * 灰度开关（TP-5-10）。缺省视为全开 —— 未装配开关的部署
   * （本地开发、P2～P4 时期的测试）不该因此拒绝服务。
   */
  readonly featureFlags?: FeatureFlags;
  /** 注入以便测试可控时间 */
  readonly now: () => Date;
  /** 提供时，条件机器码必须存在于当前发布配置；测试缺省仍用内置字典。 */
  readonly plannerConfig?: PlannerConfigRepository;
  /**
   * CR 计费（C-3）。**未提供时生成完全不计费** —— 这是刻意的：
   * `CREDIT_BILLING_ENABLED` 关闭、或库还没迁到 0013 的部署里，
   * 钱包表不存在，任何一次读它都会 500。
   *
   * 也让本文件的既有测试不必全部装配钱包：它们测的是幂等编排，与钱无关。
   */
  readonly credits?: CreditsService;
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  extra?: {
    readonly field?: string;
    readonly retryAfterSeconds?: number | null;
    readonly details?: Readonly<Record<string, number>>;
  },
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
      ...(extra?.details === undefined ? {} : { details: extra.details }),
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
  const { plans, presentations, quota, queue, idempotencyLock } = deps;

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

    /*
     * ── 灰度判定（TP-5-10）──
     *
     * 放在身份解析**之后**、校验之前。之后是因为放量按 user_id 分桶，
     * 需要先有身份；之前是因为一个被关闭的功能不该继续做任何工作 ——
     * 校验一份注定不会被生成的请求只是浪费 CPU，而在紧急关停时那点 CPU
     * 乘上全部流量并不小。
     *
     * 现场建号已经发生了（上面那一步），这是有意的：用户下次放量命中时
     * 身份还在，历史也在。
     */
    const gate = decideFeature(
      deps.featureFlags ?? ALL_FEATURES_ON,
      'generation',
      resolved.identity.userId,
    );
    if (!gate.allowed) {
      request.log.info(
        { stage: 'QUEUED', reason_code: gate.reason ?? 'disabled' },
        '生成功能当前不可用（灰度开关）',
      );
      featureGateTotal.inc({ event: 'generation', reason_code: gate.reason ?? 'disabled' });
      return fail(request, reply, 'SYS_FEATURE_DISABLED');
    }

    const parsed = TravelRequestUISchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.') ?? 'body';
      /*
       * 不记录请求值，只记录 Zod 的结构化路径与错误类型。否则前端仅显示
       * REQ_SCHEMA_INVALID 时，服务端也无法判断究竟是哪一个表单字段失配；
       * 直接记录 request.body 又会把健康、证件等敏感答案写进日志。
       */
      request.log.warn(
        {
          error_code: 'REQ_SCHEMA_INVALID',
          field,
          issue_code: issue?.code ?? 'unknown',
        },
        '旅行攻略生成请求格式校验失败',
      );
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field,
      });
    }

    let allowedConditionCodes: ReadonlySet<string> | undefined;
    if (deps.plannerConfig !== undefined) {
      const plannerConfig = await deps.plannerConfig.getPublished();
      if (plannerConfig === null) return fail(request, reply, 'SYS_DEPENDENCY_UNAVAILABLE');
      allowedConditionCodes = new Set(
        Object.entries(plannerConfig.fields).flatMap(([fieldKey, options]) =>
          options
            .filter((option) => isConditionCodeOption(fieldKey, option.metadata))
            .map((option) => option.key),
        ),
      );
    }
    const prepared = prepareTravelRequest(parsed.data, {
      now: deps.now(),
      ...(allowedConditionCodes === undefined ? {} : { allowedConditionCodes }),
    });
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

    /*
     * ── CR 预检（C-3）──
     *
     * 位置有两条讲究：
     *
     * **在配额之后。** 反过来的话，一个余额为 0 的账号可以无限次触发
     * 「解析 + 校验 + 读价目 + 读余额」，因为拦住它的那两层（每分钟 3 次、
     * 每 IP 每日）都在配额里。代价是一次 402 会消耗一格日配额 ——
     * 可以接受：CR 才是产品意义上的限额，次数配额已被提到很高的兜底值。
     *
     * **在建任务行之前。** 这一步只是预检，真正的闸门是下面那次原子预留；
     * 但把绝大多数「余额不够」挡在这里，是为了不留下垃圾：建了行之后再拒，
     * 会留下一条 QUEUED 任务和一个被占用的幂等键，而用户充值后拿同一份
     * 表单重试会命中那个幂等键，拿到一个永远不会跑的任务。
     */
    /* `null` = 未装配计费。用 null 而不是一个假的 `free`，免得读的人去找那个理由 */
    const credits = deps.credits ?? null;
    let creditCheck: JobCreditCheck | null = null;
    if (credits !== null) {
      creditCheck = await credits.checkJob({
        userId: resolved.identity.userId,
        totalDays: normalized.total_days,
      });
      if (creditCheck.kind === 'insufficient') {
        recordCreditGate('generate', 'insufficient');
        return fail(request, reply, 'AUTH_INSUFFICIENT_CREDITS', {
          details: { required_cr: creditCheck.requiredCr, balance_cr: creditCheck.balanceCr },
        });
      }
      /*
       * `free` 也要记：那条路径下**所有生成都不收费**（没有价目表、
       * 或算出 0 CR），而除了这条曲线之外没有任何迹象。
       */
      if (creditCheck.kind === 'free') recordCreditGate('generate', 'free');
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

    /*
     * ── 原子预留（C-3）──
     *
     * **这一步才是闸门**：`UPDATE ... WHERE balance_cr >= $n` 让「查余额」与
     * 「扣余额」之间没有窗口，因此并发请求不会超发（见 credit-wallet.ts）。
     * 上面那次预检只是为了让常见情形不留垃圾行。
     *
     * 在入队**之前**。反过来的话，worker 可能在预留落库前就跑完并结算，
     * 而结算找不到预留 = 那次生成免费。
     *
     * 走到 402 说明预检之后余额被另一个并发请求抢走了。这时任务行已经建好，
     * 因此把它取消 —— 留一行永远不会跑的 QUEUED 任务会让用户在列表里
     * 看到一份卡住的计划。
     */
    if (credits !== null && creditCheck?.kind === 'chargeable') {
      const reserved = await credits.reserve({
        userId: resolved.identity.userId,
        jobId: handles.jobId,
        holdCr: creditCheck.holdCr,
        priceVersion: creditCheck.priceVersion,
      });
      if (reserved.kind === 'insufficient') {
        recordCreditGate('generate', 'insufficient');
        await plans.cancelJob(handles.jobId, resolved.identity.userId);
        request.log.info(
          { stage: 'billing', required_cr: reserved.requiredCr, balance_cr: reserved.balanceCr },
          '并发争抢导致余额不足，已取消刚建立的任务',
        );
        return fail(request, reply, 'AUTH_INSUFFICIENT_CREDITS', {
          details: { required_cr: reserved.requiredCr, balance_cr: reserved.balanceCr },
        });
      }
      recordCreditGate('generate', 'allowed');
    }

    await queue.enqueue({
      jobId: handles.jobId,
      requestId: handles.requestId,
      planId: handles.planId,
      userId: resolved.identity.userId,
      /*
       * 21.3：trace context 随消息透传（TP-5-03）。
       *
       * 不带的话链路在这一行断开 —— 而用户等待的大头全在入队之后
       * （排队 + 生成 + 素材 + 渲染）。api 侧的 span 只覆盖这几十毫秒，
       * 排查「为什么等了两分钟」时看到的是「40 毫秒完成」。
       *
       * 未装配 OTel SDK 时 `captureTraceContext()` 返回 undefined，
       * 该字段不出现在消息里。
       */
      ...(() => {
        const traceContext = captureTraceContext();
        return traceContext === undefined ? {} : { traceContext };
      })(),
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
        /*
         * 13.7 的非阻断告警码（TP-4-09）。它们**不是错误** —— 任务仍会
         * `COMPLETED`，只是某些素材走了降级。返回给客户端是为了让前端能提示
         * 「部分配图使用了默认样式」，而不是让用户对着一张占位图困惑。
         */
        warnings: Array.isArray(job.warnings) ? job.warnings : [],
        /*
         * 21.2 措施一的两个里程碑（R-34 补的列，此前只被指标消费）。
         *
         * `milestones.plan_readable` 为真 ⇒ 13.3 已能读到完整文字版计划；
         * `page_viewable` 为真 ⇒ 13.4 已能读到带图的展示数据。
         *
         * 用布尔而不是时刻：客户端要的是「现在能看什么」，
         * 而时刻只对 SLA 统计有意义 —— 给它两个 ISO 字符串会让每个前端
         * 各自写一遍「非 null 即达成」的判断，而那正是服务端该给的结论。
         */
        milestones: {
          plan_readable: job.t1At !== null,
          page_viewable: job.t2At !== null,
        },
      });
    },
  );

  /**
   * 取消任务（16.1「任意非终态 → CANCELLED」，TP-4-08）。
   *
   * ## R-33：16.1 定义了 CANCELLED，十三章却没有取消端点
   *
   * 16.1 明确「`CANCELLED` 新增于 V1.1 —— 20～60 秒的生成过程用户必然会想
   * 中断」，13.7 也给了 `JOB_CANCELLED` 码。但十三章的 API 清单里没有任何
   * 能到达这个状态的入口 —— 于是这个状态在设计上存在、在运行时不可达，
   * 而「用户必然会想中断」这个需求没有任何落地。
   *
   * 路径沿用 13.2 的 `/generation-jobs/{job_id}` 前缀而不是新起一套。
   *
   * ## 幂等：已终态返回 200 而不是 409
   *
   * 用户点「取消」的那一刻任务可能刚好完成。返回 409 会让前端弹一个
   * 「操作冲突」，而用户想要的结果（任务不再继续）**已经达成**。
   * 因此返回 200 + 当前状态，前端照常刷新。
   */
  app.post<{ Params: { job_id: string } }>(
    '/api/v1/generation-jobs/:job_id/cancel',
    async (request, reply) => {
      const resolved = await resolveIdentity(deps, request, reply, {
        allowAnonymousCreation: false,
      });
      if (resolved === null) return reply;

      const outcome = await plans.cancelJob(request.params.job_id, resolved.identity.userId);
      // 他人的任务与不存在的任务返回同一个 404（13.0）
      if (outcome === 'not_found') return fail(request, reply, 'JOB_NOT_FOUND');

      const job = await plans.findJobForUser(request.params.job_id, resolved.identity.userId);
      const status = (job?.status ?? 'CANCELLED') as JobStatus;

      return reply.code(200).send({
        job_id: request.params.job_id,
        status,
        progress: job?.progress ?? 0,
        message: stageMessage(status, jobErrorMessage(job?.errorCode ?? null)),
        /*
         * `cancelled` 告诉前端「本次调用真的改变了状态」。
         * 少了它，前端无法区分「我取消成功了」与「它本来就已经结束了」——
         * 而两种情况下要不要提示用户是不同的。
         */
        cancelled: outcome === 'cancelled',
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

  /**
   * 13.4 获取展示数据。
   *
   *   GET /api/v1/travel-plans/{plan_id}/presentations/{day_number}
   *   GET /api/v1/travel-plans/{plan_id}/presentations/full
   *
   * 两个端点默认返回**最新的有效版本**，带 `?plan_version_id=` 时返回指定版本；
   * `REJECTED` 版本一律 404（验收标准 15，仓储层的谓词保证）。
   *
   * 完整页是**一次请求**返回全部天数（13.4 的 R-04 补充）——
   * 前端渲染完整计划页不必对 14 天发起 14 次调用。
   */
  async function sendPresentation(
    request: FastifyRequest<{
      Params: { plan_id: string; day_number?: string };
      Querystring: Record<string, unknown>;
    }>,
    reply: FastifyReply,
    pageType: 'DAILY_POSTER' | 'FULL_PLAN',
  ): Promise<FastifyReply> {
    const resolved = await resolveIdentity(deps, request, reply, {
      allowAnonymousCreation: false,
    });
    if (resolved === null) return reply;

    const query = PresentationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: query.error.issues[0]?.path.join('.') ?? 'query',
      });
    }

    let dayNumber: number | undefined;
    if (pageType === 'DAILY_POSTER') {
      const parsed = Number(request.params.day_number);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 14) {
        // 天号不是 1～14 的整数：不存在这样的页面，与「计划不存在」同一个 404
        return fail(request, reply, 'PLAN_NOT_FOUND');
      }
      dayNumber = parsed;
    }

    const presentation = await presentations.findPresentation({
      planId: request.params.plan_id,
      userId: resolved.identity.userId,
      pageType,
      ...(dayNumber === undefined ? {} : { dayNumber }),
      ...(query.data.plan_version_id === undefined
        ? {}
        : { planVersionId: query.data.plan_version_id }),
    });

    /*
     * 一个 404 覆盖五种情况：计划不存在、不属于你、版本是 REJECTED、
     * 该天不存在、编排还没跑完。最后一种是**正常的时序**（16.1 的
     * BUILDING_PRESENTATION 在 SAVING_PLAN 之后），前端据 13.2 的进度判断
     * 该不该重试 —— 给它一个独立错误码会让「还没好」看起来像「出错了」。
     */
    if (presentation === null) return fail(request, reply, 'PLAN_NOT_FOUND');

    return reply.code(200).send({
      plan_id: request.params.plan_id,
      plan_version_id: presentation.planVersionId,
      template_id: presentation.templateId,
      page_type: presentation.pageType,
      day_number: presentation.dayNumber,
      /*
       * `validation_status` 一并返回：DEGRADED 表示存在降级槽位但可渲染
       * （十五章）。前端据此决定是否提示「部分图片暂不可用」——
       * 不返回的话，用户只会看到几个占位块而不知道原因。
       */
      validation_status: presentation.validationStatus,
      view_model: presentation.viewModel,
    });
  }

  app.get<{ Params: { plan_id: string }; Querystring: Record<string, unknown> }>(
    '/api/v1/travel-plans/:plan_id/presentations/full',
    (request, reply) => sendPresentation(request, reply, 'FULL_PLAN'),
  );

  app.get<{
    Params: { plan_id: string; day_number: string };
    Querystring: Record<string, unknown>;
  }>('/api/v1/travel-plans/:plan_id/presentations/:day_number', (request, reply) =>
    sendPresentation(request, reply, 'DAILY_POSTER'),
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
        // 封面取当前版本第 1 天的 Hero 缩略图（TP-3-15 的绑定）。
        // 没有绑定时为 null，前端渲染渐变占位 —— 键必须存在，
        // 省略会让前端读到 undefined 并渲染出破图
        cover_url: item.coverUrl,
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
