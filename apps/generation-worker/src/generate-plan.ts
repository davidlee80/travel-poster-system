import { randomUUID } from 'node:crypto';

import type { TravelPlansRepository } from '@tps/db';
import type { EmbeddingClient, LlmClient } from '@tps/llm';
import {
  LlmTimeoutError,
  buildPlanPrompt,
  buildRepairPrompt,
  llmErrorCode,
  maxTokensForDays,
  mergeSegments,
  planSegments,
} from '@tps/llm';
import {
  addAssumption,
  buildRetrievalProjection,
  projectionToEmbeddingText,
  resolvePlan,
  type PlanViolation,
} from '@tps/planning';
import {
  JOB_STAGE_DISPLAY,
  NormalizedTravelRequestSchema,
  SCHEMA_VERSIONS,
  TravelPlanContentSchema,
  TravelPlanLlmOutputSchema,
  stageMessage,
  travelPlanLlmOutputJsonSchema,
  type JobStatus,
  type NormalizedTravelRequest,
  type PlanErrorCode,
  type TravelPlanContent,
  type TravelPlanLlmOutput,
} from '@tps/schemas';
import type { GenerationJobPayload } from '@tps/queue';
import type { Logger, UserType } from '@tps/shared';

import type { AiLayerDeps } from './assets/resolve-assets.js';
import type { LicensedSourceLayerDeps } from './assets/resolvers/licensed-source.js';
import {
  JOB_TIMEOUT_MS,
  createJobDeadline,
  queueWaitExceeded,
  type JobDeadline,
} from './job-deadline.js';
import { recordLlmCall } from './llm-metrics.js';
import {
  createPlanValidationObserver,
  jobMilestoneSeconds,
  jobTotal,
  totalDaysBucket,
} from './plan-metrics.js';
import {
  buildAndSavePresentations,
  type BuildPresentationDeps,
} from './presentation/build-presentation.js';
import { retrieveReferences, type RetrievalDeps } from './retrieval.js';
import { StageTimer } from './stage-timer.js';

/**
 * 生成任务的编排（TP-2-14，设计稿 3.2、16.1）。
 *
 * P2 覆盖状态机的前半段：
 * ```text
 * QUEUED → NORMALIZING → VALIDATING_REQUEST → RETRIEVING_REFERENCES
 *        → GENERATING_PLAN → VALIDATING_PLAN ⇄ REPAIRING_PLAN → SAVING_PLAN
 * ```
 *
 * P3 把它推进到 `RESOLVING_ASSETS`：
 * ```text
 * SAVING_PLAN → BUILDING_PRESENTATION → RESOLVING_ASSETS
 * ```
 *
 * **P3 的任务停在 `RESOLVING_ASSETS`，仍然不进入 `COMPLETED`。**
 * 16.1 的 `COMPLETED` 还要经过 `RENDERING_HTML`（渲染服务出 HTML 快照）
 * 与两个导出阶段，它们在 P4（TP-4-08 的完整状态机、TP-4-12 的导出）。
 * 理由与 P2 同一条：跳过去会在状态机上开一条非法边，而那条边一旦存在，
 * 「跳过渲染直接完成」就永远可走。
 *
 * 用户可见的效果不受影响：
 *   - `SAVING_PLAN` 完成即可读完整文字版计划（13.3）；
 *   - `RESOLVING_ASSETS` 完成即可读带图的展示数据（13.4），
 *     前端据此渲染信息图页面 —— 这正是 P3 门禁要的那个页面。
 */

/** 提示模板版本。落库到 `llm_prompt_version`，便于按版本回溯输出质量 */
export const PLAN_PROMPT_VERSION = 'plan_v1';

/**
 * 按请求构造模型客户端。
 *
 * 存在这个形态是为了 `LLM_MODE=fake`（默认模式）：录制输出必须与请求的
 * 天数、目的地、硬约束对得上，否则默认配置下的 Worker 处理不了任何请求
 * （见 fixture-plan.ts）。真实客户端与请求无关，直接传实例即可。
 */
export type LlmClientFactory = (normalized: NormalizedTravelRequest) => LlmClient;

export interface GeneratePlanDeps {
  readonly plans: TravelPlansRepository;
  readonly retrieval: RetrievalDeps;
  readonly llm: LlmClient | LlmClientFactory;
  readonly embedding: EmbeddingClient;
  readonly logger: Logger;
  readonly llmTimeoutMs: number;
  /** 注入以便测试超时；生产用 Date.now */
  readonly now?: () => number;
  /**
   * 展示编排与素材解析（P3）。
   *
   * 可选：缺省时任务停在 `SAVING_PLAN`，与 P2 的行为一致。
   * 这让「只想跑计划生成」的场景（如 P2 时期的测试、故障时的降级部署）
   * 不必装配对象存储与素材库依赖。
   *
   * `logger` 由本模块注入（带 job_id / user_id 的子 logger），因此这里排除它。
   * `ai` 同样排除：它含每任务一个实例的预算对象，见 `aiAssets`。
   */
  readonly presentation?: Omit<BuildPresentationDeps, 'logger' | 'ai' | 'licensedSource'>;

  /**
   * AI 兜底层的**工厂**（TP-4-02/03/17）。
   *
   * 是工厂而不是实例，因为 21.4 的单任务预算（3 张图、2 次 Hero）是
   * 每任务状态，而额度上限又取决于身份类型（匿名的 AI Hero 额度为 0）。
   * 放一个共享实例进依赖容器的表现是「第 4 个任务开始一张 AI 图都没有」——
   * 计数从来没被重置过。
   *
   * 缺省时降级链没有第 1 级（等价于 21.4 的全局熔断已打开）。
   */
  readonly aiAssets?: (userType: UserType) => AiLayerDeps;

  /**
   * 授权图源搜索层的**工厂**（TP-6-03/06）。
   *
   * 与 `aiAssets` 同样是工厂：9.6 的单任务 8 次与连续失败 2 次都是每任务
   * 状态，共享实例的表现是「第 2 个任务开始一次搜索都不发」——
   * 计数从来没被重置过。
   *
   * 不带 `userType` 参数：9.6 规定搜索额度匿名与注册同额（命中入库为全平台
   * 共享资产），因此这个工厂不需要身份。
   *
   * 缺省时降级链没有搜索层（等价于 9.6 的全局熔断已打开）。
   */
  readonly searchAssets?: () => LicensedSourceLayerDeps;
}

export type JobFailureCode = PlanErrorCode | 'JOB_TIMEOUT' | 'JOB_QUEUE_TIMEOUT';

export type GenerateOutcome =
  | {
      readonly outcome: 'saved';
      readonly versionId: string;
      readonly status: 'READY' | 'REPAIRED';
      /** 展示编排的结果。未装配或编排失败时缺省 */
      readonly presentation?: {
        readonly pages: number;
        readonly validationStatus: string;
        readonly bindings: number;
      };
    }
  | { readonly outcome: 'rejected'; readonly versionId: string; readonly errorCode: PlanErrorCode }
  | { readonly outcome: 'failed'; readonly errorCode: JobFailureCode }
  | {
      readonly outcome: 'skipped';
      readonly reason: 'not_found' | 'already_terminal' | 'cancelled';
    };

/**
 * 推进状态并写进度（16.1：状态与 progress 同一事务）。
 *
 * ## 返回值就是取消信号（TP-4-08）
 *
 * `updateJobState` 的 SQL 带 `AND status <> ALL(terminal)`，因此任务被取消
 * （`CANCELLED` 是终态）之后，任何一次状态推进都会改 0 行并返回 false。
 *
 * 这让协作式取消**不需要任何额外查询**：每个阶段边界本来就要写一次状态，
 * 那次写入的成败同时回答了「这个任务还该继续吗」。
 * 另起一个 `SELECT status` 去轮询的话，每个阶段多一次往返，
 * 而且查询与写入之间仍有窗口 —— 取消恰好落在窗口里就会被漏掉。
 */
async function advance(
  deps: GeneratePlanDeps,
  jobId: string,
  to: JobStatus,
  extra: {
    readonly errorCode?: string;
    readonly planVersionId?: string;
    readonly stageTimings?: Readonly<Record<string, number>>;
  } = {},
): Promise<boolean> {
  const display = JOB_STAGE_DISPLAY[to];
  return deps.plans.updateJobState({
    jobId,
    to,
    /*
     * `progress ?? 0` 只影响 FAILED / CANCELLED（表值为 null，表示保持原值），
     * 而 SQL 侧用 `GREATEST(progress, $3)` 写入 —— 传 0 等于「不改」。
     */
    progress: display.progress ?? 0,
    message: to === 'FAILED' ? null : stageMessage(to),
    ...extra,
  });
}

/**
 * 写入 `FAILED` 并结算指标（TP-5-01）。
 *
 * `finalize` 由调用方给出（`StageTimer.finish` 的结果与身份维度）——
 * 队列超时那一条分支发生在计时器建立之前，因此它是可选的。
 */
async function fail(
  deps: GeneratePlanDeps,
  jobId: string,
  errorCode: JobFailureCode,
  finalize: {
    readonly stageTimings?: Readonly<Record<string, number>>;
    readonly userType: UserType;
  },
  planVersionId?: string,
): Promise<GenerateOutcome> {
  await deps.plans.updateJobState({
    jobId,
    to: 'FAILED',
    progress: 0,
    // 16.2：FAILED 的文案取 13.7 错误码对应文案
    message: stageMessage('FAILED'),
    errorCode,
    ...(planVersionId === undefined ? {} : { planVersionId }),
    ...(finalize.stageTimings === undefined ? {} : { stageTimings: finalize.stageTimings }),
  });
  jobTotal.inc({ status: 'FAILED', error_code: errorCode, user_type: finalize.userType });
  return { outcome: 'failed', errorCode };
}

/**
 * 调一次模型并解析成 `TravelPlanLlmOutput`。
 *
 * schema 校验放在这里而不是留给业务规则：6.3 的结构化输出仍可能给出
 * 类型不符的字段，而那属于 `PLAN_SCHEMA_INVALID`（16.3 判定为阻断、
 * 计入重生成次数），与 3.2.1 的业务违规是两类问题。
 */
async function callModel(
  deps: GeneratePlanDeps,
  llm: LlmClient,
  messages: { readonly system: string; readonly user: string },
  maxTokens: number,
  purpose: 'plan' | 'repair',
  deadline: JobDeadline,
): Promise<{ output: TravelPlanLlmOutput; inputTokens: number; outputTokens: number }> {
  /*
   * 单次超时压到任务剩余预算内（16.3）。剩 8 秒时不该再发一个 30 秒超时的
   * 请求 —— 它一定在 300 秒边界之后才返回，而那时任务已经算超时，
   * 这次调用的钱白花。
   */
  const timeoutMs = deadline.remainingFor(deps.llmTimeoutMs);
  if (timeoutMs <= 0) throw new LlmTimeoutError(0);

  /*
   * 墙钟而不是 `deps.now`：后者在测试里是一个每次调用跳 400 秒的假时钟
   * （用于验证 300 秒预算），拿它算耗时会把 `travel_llm_duration_seconds`
   * 的样本全写成 400 秒。这个指标度量的是真实的外部调用延迟。
   */
  const startedAt = Date.now();
  let result;
  try {
    result = await llm.complete({
      system: messages.system,
      user: messages.user,
      jsonSchema: { name: 'travel_plan', schema: travelPlanLlmOutputJsonSchema },
      maxTokens,
      purpose,
      timeoutMs,
    });
  } catch (error) {
    recordLlmCall({
      model: llm.model,
      purpose,
      outcome: error instanceof LlmTimeoutError ? 'timeout' : 'failed',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  /*
   * token 在 schema 校验**之前**记：那次调用的钱已经花了。
   * 只在解析成功后计数会让「模型一直输出不合规内容」这类最烧钱的故障
   * 在成本报表上完全不可见。
   */
  recordLlmCall({
    model: llm.model,
    purpose,
    outcome: 'succeeded',
    durationMs: Date.now() - startedAt,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  const parsed = TravelPlanLlmOutputSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new PlanSchemaInvalidError(parsed.error.issues[0]?.message ?? '结构不符');
  }

  return {
    output: parsed.data,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}

export class PlanSchemaInvalidError extends Error {
  constructor(detail: string) {
    super(`模型输出不满足 TravelPlan 契约：${detail}`);
    this.name = 'PlanSchemaInvalidError';
  }
}

function errorCodeFor(error: unknown): PlanErrorCode {
  return error instanceof PlanSchemaInvalidError ? 'PLAN_SCHEMA_INVALID' : llmErrorCode(error);
}

/**
 * 6.3：> 7 天分段生成后合并。
 *
 * 分段串行而不是并发：同一任务的多段共享 21.4 的单任务成本上限，
 * 并发发出去的话，第一段就超预算时第二段已经在路上了 —— 钱已经花掉。
 */
async function generateContent(
  deps: GeneratePlanDeps,
  llm: LlmClient,
  normalized: NormalizedTravelRequest,
  references: Awaited<ReturnType<typeof retrieveReferences>>['references'],
  deadline: JobDeadline,
): Promise<{ output: TravelPlanLlmOutput; inputTokens: number; outputTokens: number }> {
  const segments = planSegments(normalized.total_days);
  const maxTokens = maxTokensForDays(normalized.total_days);

  const outputs: TravelPlanLlmOutput[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const segment of segments) {
    /*
     * 分段之间检查预算：8～14 天要串行调两次模型（各最多 30 秒）。
     * 第一段吃掉大半预算时，第二段发出去只会在中途撞上 300 秒上限 ——
     * 那时钱已经花了，任务照样失败。
     */
    if (deadline.expired()) throw new LlmTimeoutError(0);

    const messages = buildPlanPrompt({
      normalized,
      segment,
      totalSegments: segments.length,
      references: references.map((reference) => reference.projection),
    });
    const result = await callModel(deps, llm, messages, maxTokens, 'plan', deadline);
    outputs.push(result.output);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
  }

  return { output: mergeSegments(outputs), inputTokens, outputTokens };
}

export async function generatePlan(
  deps: GeneratePlanDeps,
  payload: GenerationJobPayload,
): Promise<GenerateOutcome> {
  const context = await deps.plans.findJobContext(payload.jobId);
  if (context === null) {
    /*
     * 任务不存在：多半是保留期清理删掉了用户，而队列里还留着消息。
     * 静默跳过而不是报错 —— 报错会让 BullMQ 重试一个永远不会存在的任务。
     */
    deps.logger.warn({ job_id: payload.jobId }, '任务上下文不存在，跳过');
    return { outcome: 'skipped', reason: 'not_found' };
  }
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(context.status)) {
    // 13.8 的 Worker 侧并发保护：重复投递时第二次消费直接退出
    return { outcome: 'skipped', reason: 'already_terminal' };
  }

  const log = deps.logger.child({ job_id: context.jobId, user_id: context.userId });
  const now = deps.now ?? Date.now;

  /*
   * 标准化结果在这里解析一次，供两处使用：`total_days` 分档（指标维度）与
   * 下面 NORMALIZING 阶段的形状校验。解析两次没有坏处但也没有意义 ——
   * 而分档必须在队列超时判定之前拿到，因为那条分支也要记 `travel_job_total`。
   */
  const normalizedParsed = NormalizedTravelRequestSchema.safeParse(context.normalizedRequest);
  const daysBucket = normalizedParsed.success
    ? totalDaysBucket(normalizedParsed.data.total_days)
    : /*
       * 库里的标准化结果形状不对时没有可信的天数。用 `unknown` 而不是猜一个
       * 分档：把它算进 `1-7` 会污染那一档的 SLA 分位数，而这类任务本来就
       * 不该出现在 SLA 统计里。
       */
      'unknown';

  /*
   * 16.3：队列等待上限 600 秒。判定放在消费的第一件事 ——
   * 等了 11 分钟的任务，用户早已离开页面，而生成它仍要花掉一次模型调用的钱。
   */
  const queueTiming = await deps.plans.findJobQueueTiming(context.jobId);
  if (queueTiming !== null && queueWaitExceeded(queueTiming.queuedForMs)) {
    log.warn(
      { stage: 'QUEUED', error_code: 'JOB_QUEUE_TIMEOUT' },
      `任务排队超过上限（入队于 ${queueTiming.createdAt.toISOString()}，` +
        `已等待 ${Math.round(queueTiming.queuedForMs / 1000)} 秒）`,
    );
    return fail(deps, context.jobId, 'JOB_QUEUE_TIMEOUT', { userType: context.userType });
  }

  /*
   * 里程碑的计时起点是**入队时刻**而不是开始消费的时刻（21.2）。
   * T1 的定义是「提交 → SAVING_PLAN 完成」，用户从点下按钮就开始等 ——
   * 排队那段时间同样是他的等待。用消费起点算会让队列积压时 SLA 看起来完好。
   *
   * 排队那段的长度由**数据库**算（R-40）：`created_at` 是数据库时钟的值，
   * 拿它跟进程的 `Date.now()` 相减是跨时钟比较 —— 实测中这让总耗时算出了
   * 负数。因此这里只做加法：数据库给的排队时长 + 进程内经过的时长。
   */
  const queuedForMs = queueTiming?.queuedForMs ?? 0;
  const consumeStartedMs = now();
  /** 从入队算起、到此刻为止的毫秒数（21.2 的里程碑口径） */
  const sinceQueued = (): number => queuedForMs + (now() - consumeStartedMs);

  // 16.3：整个生成任务 300 秒。协作式检查，理由见 job-deadline.ts
  const deadline = createJobDeadline(now(), JOB_TIMEOUT_MS, now);

  /*
   * 阶段计时（TP-5-01）。起点是入队时刻，与里程碑一致 ——
   * 理由见 stage-timer.ts。
   */
  const timer = new StageTimer(consumeStartedMs, now, daysBucket, queuedForMs);

  /** 推进状态并把上一阶段的耗时挂在同一次写入上 */
  const step = (
    to: JobStatus,
    extra: { readonly errorCode?: string; readonly planVersionId?: string } = {},
  ): Promise<boolean> =>
    advance(deps, context.jobId, to, { ...extra, stageTimings: timer.enter(to) });

  const failJob = (code: JobFailureCode, planVersionId?: string): Promise<GenerateOutcome> =>
    fail(
      deps,
      context.jobId,
      code,
      { stageTimings: timer.finish('failed'), userType: context.userType },
      planVersionId,
    );

  /**
   * 阶段边界的取消检查。`advance` 返回 false 说明任务已进入终态 ——
   * 在这条路径上只可能是用户取消（失败由本函数自己写入）。
   *
   * 取消时不再写 `stage_timings`：那次 UPDATE 一定改 0 行（`CANCELLED` 是终态，
   * 而 SQL 带非终态谓词）。耗时因此少最后一段，这是可接受的 ——
   * 被取消的任务不参与任何性能统计。
   */
  const cancelled = (stage: JobStatus): GenerateOutcome => {
    timer.finish('cancelled');
    jobTotal.inc({
      status: 'CANCELLED',
      error_code: 'JOB_CANCELLED',
      user_type: context.userType,
    });
    log.info({ stage }, '任务已被取消，停止后续处理');
    return { outcome: 'skipped', reason: 'cancelled' };
  };

  // ── NORMALIZING：标准化结果已在同步路径算好，这里只读回并校验形状 ──
  if (!(await step('NORMALIZING'))) return cancelled('NORMALIZING');
  if (!normalizedParsed.success) {
    /*
     * 库里的 normalized_request 形状不对，只可能是标准化规则改版后
     * 老行被重放。它不是用户能修的问题，也不是重试能好的问题。
     */
    log.error({ stage: 'NORMALIZING' }, '标准化结果不满足当前契约');
    return failJob('PLAN_SCHEMA_INVALID');
  }
  const normalized = normalizedParsed.data;
  // fake 模式需要按请求构造录制输出；真实客户端与请求无关
  const llm: LlmClient = typeof deps.llm === 'function' ? deps.llm(normalized) : deps.llm;

  /*
   * VALIDATING_REQUEST：3.1.2 的 N-01～N-12 已在 API 的同步路径执行过
   * （失败直接 4xx，不入队）。这里只推进状态，不重跑 ——
   * 重跑会让「入队后到消费前跨过了午夜」的任务因 N-01（出发日期在过去）
   * 失败，而那不是用户的错。
   */
  if (!(await step('VALIDATING_REQUEST'))) {
    return cancelled('VALIDATING_REQUEST');
  }

  // ── RETRIEVING_REFERENCES（3.2.4）──
  if (!(await step('RETRIEVING_REFERENCES'))) {
    return cancelled('RETRIEVING_REFERENCES');
  }
  const retrieved = await retrieveReferences(deps.retrieval, {
    normalized,
    excludePlanId: context.planId,
  });
  log.info(
    {
      stage: 'RETRIEVING_REFERENCES',
      outcome: retrieved.outcome,
      count: retrieved.references.length,
    },
    '历史参考检索完成',
  );

  // ── GENERATING_PLAN（6.3）──
  if (deadline.expired()) {
    log.warn({ stage: 'GENERATING_PLAN', error_code: 'JOB_TIMEOUT' }, '任务超过 300 秒上限，中止');
    return failJob('JOB_TIMEOUT');
  }

  /*
   * 取消检查放在**发出模型调用之前**：这是整条链路上唯一一次「不检查就会
   * 白花钱」的边界。用户点取消的动机多数就是「我填错了」，
   * 而此刻停下来能省掉一次完整的生成成本。
   */
  if (!(await step('GENERATING_PLAN'))) return cancelled('GENERATING_PLAN');
  let generated;
  try {
    generated = await generateContent(deps, llm, normalized, retrieved.references, deadline);
  } catch (error) {
    const code = errorCodeFor(error);
    log.error({ stage: 'GENERATING_PLAN', error_code: code }, '计划生成失败');
    return failJob(code);
  }

  // ── VALIDATING_PLAN ⇄ REPAIRING_PLAN（3.2.1、3.2.2）──
  await step('VALIDATING_PLAN');

  const injected: TravelPlanContent = {
    ...generated.output,
    schema_version: SCHEMA_VERSIONS.travelPlan,
    // 状态由校验与修复流程决定，模型无从判断（6.3）
    status: 'READY',
  };

  let repairing = false;
  const resolved = await resolvePlan(
    injected,
    { normalized },
    {
      observer: createPlanValidationObserver(),
      regenerate: async ({ violations, plan, attempt }) => {
        if (!repairing) {
          repairing = true;
          await step('REPAIRING_PLAN');
        }
        const messages = buildRepairPrompt({
          normalized,
          violations: violations.map((violation: PlanViolation) => ({
            rule: violation.rule,
            path: violation.path,
            detail: violation.detail,
          })),
          previous: TravelPlanLlmOutputSchema.parse({
            ...plan,
            schema_version: undefined,
            status: undefined,
          }),
          attempt,
        });
        const result = await callModel(
          deps,
          llm,
          messages,
          maxTokensForDays(normalized.total_days),
          'repair',
          deadline,
        );
        generated.inputTokens += result.inputTokens;
        generated.outputTokens += result.outputTokens;
        return { ...result.output, schema_version: SCHEMA_VERSIONS.travelPlan, status: 'READY' };
      },
    },
  );

  /*
   * 3.2.4 / TP-2-24：无历史参考这件事对用户可见。
   * 在 resolvePlan **之后**追加：它会 structuredClone 输入，
   * 提前写进去也会被带过来，但那样就依赖了「克隆」这个实现细节。
   */
  for (const assumption of retrieved.assumptions) {
    addAssumption(resolved.plan, assumption.code, assumption.text, null);
  }

  const finalStatus = resolved.status;
  const planContent = TravelPlanContentSchema.parse({ ...resolved.plan, status: finalStatus });

  // ── SAVING_PLAN（TP-2-14）──
  /*
   * 这里**不检查超时**。计划已经生成并通过校验，落库只差一次 INSERT ——
   * 此刻因为超了 300 秒而丢弃它，等于把已经花掉的模型成本连同用户的全部
   * 等待一起扔掉，而重试要从零开始再花一遍。超时的意义是「别再启动新的
   * 昂贵工作」，不是「把做好的东西扔掉」。
   */
  await step('SAVING_PLAN');

  /*
   * 版本 ID 在这里生成，而不是交给数据库默认值：`plan_json` 里必须含
   * `plan_version_id`（六章的 TravelPlan 三个 ID 都是必填）。
   * 等插入后再补的话，库里会短暂存在一份 `TravelPlanSchema` 读不回来的
   * 计划 —— 而 13.3 正是用它解析后返回。
   */
  const versionId = randomUUID();

  /*
   * 投影与向量都由**最终落库的**计划算出。
   * 用修复前的版本算会让检索召回一份与库里内容不一致的行程结构。
   */
  const projection = buildRetrievalProjection(planContent);
  let embedding: number[] | null = null;
  try {
    const [vector] = await deps.embedding.embed([projectionToEmbeddingText(projection)]);
    embedding = vector ?? null;
  } catch (error) {
    /*
     * 向量化失败不阻断保存：计划本身完全可用，只是暂时不参与他人的
     * 历史检索（检索侧要求 `plan_embedding IS NOT NULL`）。
     * 反过来让它阻断，会因为一个纯粹的「提高别人生成质量」的功能
     * 而丢掉用户已经生成好的计划。
     */
    log.warn({ stage: 'SAVING_PLAN' }, `向量化失败，该版本不参与历史检索：${String(error)}`);
  }

  let saved;
  try {
    saved = await deps.plans.savePlanVersion({
      planId: context.planId,
      status: finalStatus,
      versionId,
      planJson: {
        ...planContent,
        plan_id: context.planId,
        plan_version_id: versionId,
        request_id: context.requestId,
      },
      constraintReport: planContent.constraint_report,
      retrievalProjection: projection,
      destinationPlaceId: normalized.destination_place_id ?? null,
      totalDays: normalized.total_days,
      planEmbedding: embedding,
      title: planContent.title,
      llmModel: llm.model,
      llmPromptVersion: PLAN_PROMPT_VERSION,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      repairIterations: resolved.deterministicRounds,
      regenerationCount: resolved.regenerations,
    });
  } catch (error) {
    log.error({ stage: 'SAVING_PLAN' }, `持久化失败：${String(error)}`);
    return failJob('PLAN_PERSIST_FAILED');
  }

  if (finalStatus === 'REJECTED') {
    /*
     * 3.2.2：修复失败的计划只落库供排查，不成为可展示版本。
     * 先落库再置 FAILED，顺序不能反 —— 反了的话排查时拿不到那份草稿，
     * 而它是唯一能说明「模型到底写了什么」的证据。
     */
    const code = resolved.errorCode ?? 'PLAN_REPAIR_EXHAUSTED';
    log.warn({ stage: 'SAVING_PLAN', error_code: code }, '计划未通过校验，落库为 REJECTED');
    await failJob(code, saved.versionId);
    return { outcome: 'rejected', versionId: saved.versionId, errorCode: code };
  }

  await deps.plans.updateJobState({
    jobId: context.jobId,
    to: 'SAVING_PLAN',
    progress: JOB_STAGE_DISPLAY.SAVING_PLAN.progress ?? 60,
    message: stageMessage('SAVING_PLAN'),
    planVersionId: saved.versionId,
  });

  /*
   * ── T1 计划可读（21.2 措施一，TP-4-14）──
   *
   * 这一刻用户就能通过 13.3 读到完整文字版计划。里程碑写在这里而不是
   * 任务结束时：客户端据此**提前**切换到「显示文字计划」，
   * 而不是等 `status === 'COMPLETED'` —— 那要再等素材解析与渲染。
   */
  await deps.plans.markMilestone(context.jobId, 't1');
  jobMilestoneSeconds.observe(
    {
      milestone: 't1',
      total_days_bucket: totalDaysBucket(normalized.total_days),
      user_type: context.userType,
    },
    sinceQueued() / 1000,
  );

  log.info(
    {
      stage: 'SAVING_PLAN',
      plan_version_id: saved.versionId,
      status: finalStatus,
      repair_iterations: resolved.deterministicRounds,
      regenerations: resolved.regenerations,
    },
    '计划已保存',
  );

  /*
   * ── BUILDING_PRESENTATION → RESOLVING_ASSETS（TP-3-03～TP-3-16）──
   *
   * 展示编排缺失不该让「已经生成好的计划」变成失败：13.3 的文字版计划
   * 此刻已经可读，用户手里有一份完整的行程。因此这一段的异常只记
   * `warnings` 级别的日志并把任务留在 `SAVING_PLAN`，
   * 而不是 `FAILED`（16.3：只有「页面核心结构无法生成」才阻断，
   * 而那要等到 P4 接上真实渲染才能判定）。
   */
  const presentation = deps.presentation;
  if (presentation === undefined) {
    log.warn({ stage: 'SAVING_PLAN' }, '未装配展示编排依赖，任务停在 SAVING_PLAN');
    return { outcome: 'saved', versionId: saved.versionId, status: finalStatus };
  }

  try {
    await step('BUILDING_PRESENTATION');

    const plan = {
      ...planContent,
      plan_id: context.planId,
      plan_version_id: saved.versionId,
      request_id: context.requestId,
    };

    await step('RESOLVING_ASSETS');
    const ai = deps.aiAssets?.(context.userType);
    const licensedSource = deps.searchAssets?.();
    const result = await buildAndSavePresentations(
      {
        ...presentation,
        logger: log,
        ...(ai === undefined ? {} : { ai }),
        ...(licensedSource === undefined ? {} : { licensedSource }),
      },
      plan,
    );

    log.info(
      {
        stage: 'RESOLVING_ASSETS',
        plan_version_id: saved.versionId,
        status: result.validationStatus,
        warnings: [...result.warnings],
      },
      `展示数据已保存：${result.pages} 页、${result.bindings} 个素材绑定` +
        (result.omitted > 0 ? `，${result.omitted} 条内容因限额未展示` : ''),
    );

    /*
     * TP-4-09：非阻断告警落库。写在状态推进之后、返回之前 ——
     * 13.2 会把 warnings 返回给客户端，它应当与任务的当前状态一致。
     */
    if (result.warnings.length > 0) {
      await deps.plans.appendJobWarnings(context.jobId, result.warnings);
    }

    if (result.budgetMismatch) {
      // 12.1：预算数字对不上是用户可见的严重错误，V-20 定为 REPAIRABLE
      log.warn(
        { stage: 'RESOLVING_ASSETS', rule_id: 'V-20' },
        '预算明细之和与总计不一致，展示以明细之和为准',
      );
    }

    /*
     * ── T2 页面可看（21.2 措施一）──
     *
     * 13.4 此刻能读到带图的展示数据，前端可以切换到完整信息图页面。
     */
    await deps.plans.markMilestone(context.jobId, 't2');
    jobMilestoneSeconds.observe(
      {
        milestone: 't2',
        total_days_bucket: totalDaysBucket(normalized.total_days),
        user_type: context.userType,
      },
      sinceQueued() / 1000,
    );

    /*
     * ── RENDERING_HTML → COMPLETED（16.1，TP-4-08）──
     *
     * ## R-35：这个系统的 HTML 页面不是「产物」，因此没有快照可生成
     *
     * 16.1 把 `RENDERING_HTML` 描述为「渲染服务出 HTML 快照」。但 17.1 的
     * 渲染路由是**按 `plan_version_id` 实时从库里取 ViewModel 渲染**的
     * （见 apps/web 的 presentation-source.ts）—— 页面在展示数据落库的那一刻
     * 就已经可访问，没有中间产物需要生成。
     *
     * 生成一份快照 HTML 存起来反而有害：ViewModel 与快照会各自演化，
     * 而「页面显示的内容」从此有两个真相源；模板改版后旧快照还在，
     * 用户看到的是一个月前的排版。
     *
     * 因此这一阶段的实质工作是**确认页面可渲染**：
     *   - ViewModel 通过 `TravelPosterViewModelSchema`（已在编排时保证）；
     *   - 必需槽位有产物或有到底的降级（`validation_status`）。
     * 两者都成立即推进 `RENDERING_HTML → COMPLETED`。
     *
     * 17.3 的溢出检查与模板异常需要真的开一个浏览器，那发生在**导出链路**
     * 上（render-worker 的 renderPage 已经做了）。而 16.1 明确导出失败
     * 不阻断（「重试一次后跳到下一状态，最终仍为 COMPLETED」），
     * 因此把它放在导出侧不会让阻断判定丢失 —— 丢失的只有「排版拥挤」这类
     * 降级信号，而它本来就是非阻断的（R-24 的 RENDER_OVERFLOW_UNRESOLVED）。
     *
     * `EXPORTING_PNG` / `EXPORTING_PDF` 两个状态在 16.1 里是「可跳过」的
     * （`generate_png` / `generate_pdf` 为 false 时），而 V1 的导出是**用户
     * 主动发起**的独立任务（13.5），不属于生成任务的一部分。因此生成任务
     * 从 `RENDERING_HTML` 直接到 `COMPLETED` —— 这条边在 16.1 的转移表里
     * 本来就存在。
     */
    if (result.validationStatus === 'INVALID') {
      /*
       * 16.3：`RENDER_CORE_ASSET_MISSING` 是阻断类。走到这里说明必需槽位
       * （Hero / 路线图）连降级链都没兜住 —— 而那两条链都有到底的兜底
       * （渐变背景 / 文字路线），因此这是代码缺陷而不是数据问题。
       */
      log.error(
        { stage: 'RENDERING_HTML', error_code: 'RENDER_CORE_ASSET_MISSING' },
        '必需素材的降级链未兜住，页面核心结构无法生成',
      );
      await failJob('PLAN_PERSIST_FAILED', saved.versionId);
      return { outcome: 'saved', versionId: saved.versionId, status: finalStatus };
    }

    if (!(await step('RENDERING_HTML'))) {
      return cancelled('RENDERING_HTML');
    }
    /*
     * 终态用 `finish` 而不是 `enter`：`total` 那一项必须搭这最后一次 UPDATE
     * 落库。之后再写就写不进去了 —— `updateJobState` 带非终态谓词，
     * 而这一行此刻已经是 `COMPLETED`。
     */
    if (!(await advance(deps, context.jobId, 'COMPLETED', { stageTimings: timer.finish('ok') }))) {
      return cancelled('COMPLETED');
    }
    jobTotal.inc({ status: 'COMPLETED', error_code: 'none', user_type: context.userType });

    return {
      outcome: 'saved',
      versionId: saved.versionId,
      status: finalStatus,
      presentation: {
        pages: result.pages,
        validationStatus: result.validationStatus,
        bindings: result.bindings,
      },
    };
  } catch (error) {
    log.error(
      { stage: 'RESOLVING_ASSETS', plan_version_id: saved.versionId },
      `展示编排失败，计划仍可通过 13.3 读取：${String(error)}`,
    );
    return { outcome: 'saved', versionId: saved.versionId, status: finalStatus };
  }
}
