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
  normalizeStrictLlmOutput,
  stageMessage,
  travelPlanLlmOutputStrictJsonSchema,
  type JobStatus,
  type NormalizedTravelRequest,
  type PlanErrorCode,
  type TravelPlanContent,
  type TravelPlanLlmOutput,
} from '@tps/schemas';
import type { GenerationJobPayload } from '@tps/queue';
import { UsageMeter } from '@tps/billing';
import { uuidv7, type Logger, type UserType } from '@tps/shared';

import type { JobBilling } from './billing.js';
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
import { isUnrecoverable } from './retry-policy.js';
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
export type LlmClientFactory = (
  normalized: NormalizedTravelRequest,
  context: JobModelContext,
) => LlmClient | Promise<LlmClient>;

/**
 * 装配模型客户端时需要知道的任务身份。
 *
 * `tierLevel` 决定候选模型池（迁移 0009）。做成一个对象而不是两个位置参数：
 * 下一次要加维度（地域、A/B 分组）时不必再改一遍所有工厂的签名。
 */
export interface JobModelContext {
  readonly userType: UserType;
  readonly tierLevel: number;
}

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
   *
   * **可以是异步的**：候选模型池要查库（按 `tierLevel` 选池，迁移 0009）。
   * 同步签名的代价是把那次查询搬到进程启动时，而那样一来运营改配置就要
   * 重启 Worker 才生效 —— 池存在数据库里的意义正是不必重启。
   */
  readonly aiAssets?: (context: JobModelContext) => AiLayerDeps | Promise<AiLayerDeps>;

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

  /**
   * CR 结算（C-4）。
   *
   * 缺省时**完全不计费**，也不读钱包表 —— 与 API 侧的同名开关
   * （`CREDIT_BILLING_ENABLED`）成对：库还没迁到 0013 的部署里那些表不存在，
   * 而一次生成任务不该因为计费表缺失而失败。
   */
  readonly billing?: JobBilling;
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
  meter: UsageMeter,
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
      /*
       * 发 strict 兼容那一份，不是 `z.toJSONSchema()` 的原样产物。
       *
       * client.ts 发的是 `strict: true`（6.3 要求 schema 约束模式），而原样
       * schema 违反 OpenAI strict 的三条规则 —— 对 ofox 转发过去的
       * `openai/*` 模型是直接 400，不是「偶发不兼容」。转换的取舍与代价见
       * `travelPlanLlmOutputStrictJsonSchema` 的注释。
       */
      jsonSchema: { name: 'travel_plan', schema: travelPlanLlmOutputStrictJsonSchema },
      maxTokens,
      purpose,
      timeoutMs,
      /*
       * 任务剩余预算。`timeoutMs` 只约束**一次**调用，而候选链会串行发多次 ——
       * 一条 20 候选的链在剩 8 秒时仍会烧掉 20 次请求，全部落在 300 秒之后。
       * 候选数来自数据库（运营可改），单靠 env 算出的链预算约束不住它。
       *
       * 对单候选客户端这个 signal 与自己的超时取并集，行为不变；
       * 对故障转移客户端它的含义是「别再开新候选了」（见 wrapLlmFailover）。
       */
      signal: AbortSignal.timeout(Math.max(1, deadline.remainingMs())),
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

  /*
   * 计费打点（C-4）。与上面那次指标打点同一位置、同一理由：钱已经花了。
   *
   * 用 `result.model` 而不是 `llm.model`：故障转移下前者是**真正出活的那个
   * 候选**，而后者恒为主候选的名字（见 wrapLlmFailover）。价目表按模型定价，
   * 拿主候选的名字计费会让「主候选挂了、由更贵的备选顶上」被按主候选的价收。
   */
  meter.addLlm(result.model, result.usage.inputTokens, result.usage.outputTokens);

  /*
   * strict 不允许可选属性，所以 `total_budget` 的两个可选金额被改成了可空必填 ——
   * 模型用 `null` 表达「没有这一项」。这一步把那些 `null` 还原成「没给」，
   * 于是 Zod 的 `.optional()` 与「不扣除 + 记一条 assumption」的语义不变。
   */
  const parsed = TravelPlanLlmOutputSchema.safeParse(normalizeStrictLlmOutput(result.data));
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
  meter: UsageMeter,
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
    const result = await callModel(deps, llm, messages, maxTokens, 'plan', deadline, meter);
    outputs.push(result.output);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
  }

  return { output: mergeSegments(outputs), inputTokens, outputTokens };
}

/**
 * 一次生成任务。
 *
 * `meter` 由 `generatePlan` 创建并在结算时读取 —— 每任务一个实例，
 * 与 `AiImageBudget` / `ImageSearchBudget` 同一形态。共享实例的表现是
 * 「用户被收了别人的钱」。
 */
async function runJob(
  deps: GeneratePlanDeps,
  payload: GenerationJobPayload,
  meter: UsageMeter,
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
  // fake 模式需要按请求构造录制输出；真实客户端还要按 tier 选候选池
  const modelContext: JobModelContext = {
    userType: context.userType,
    tierLevel: context.tierLevel,
  };
  const llm: LlmClient =
    typeof deps.llm === 'function' ? await deps.llm(normalized, modelContext) : deps.llm;

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
    generated = await generateContent(deps, llm, normalized, retrieved.references, deadline, meter);
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
          meter,
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
   *
   * **UUIDv7 而不是 v4**（R-48，TP-6-10）：这个 ID 同时是 15.4 的
   * `content_id` —— 该次生成的全部产物（展示数据、素材绑定、导出文件、
   * 存储键、日志与 Trace）都以它为锚点。时间有序换来两件事：
   * 15.4 的存储路径可以从 ID 派生年月而不引入第二个时间来源，
   * 13.11 的时间范围检索可以在主键上做范围扫描而不需要新索引。
   */
  const versionId = uuidv7();

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

  /*
   * 两个预算实例提到 try 之外：它们的计数就是计费口径（见下面的 `meterAssets`），
   * 而编排抛异常时那些 AI 图已经生成、钱已经花了 —— catch 分支里读不到它们的话，
   * 「编排崩了」会变成「这次生成的图不要钱」。
   */
  let ai: AiLayerDeps | undefined;
  let licensedSource: LicensedSourceLayerDeps | undefined;

  /**
   * 素材侧的计费打点（C-4 的三处之一，另一处是 `callModel` 里的 token）。
   *
   * 读预算对象的 `used` 而不是在素材管线里再埋一层：`AiImageBudget` 的
   * `images` 恰好就是「真的生成出来的张数」—— 失败与同键去重都调了 `refund`，
   * 不计在内。这与 docs 里那条施工注意（打点必须挂在图真的生成成功处，
   * 不能挂在 `reserve`）说的是同一件事，而这里不需要改动素材管线就已经满足。
   */
  const meterAssets = (pages: number): void => {
    meter.addAiImages(ai?.budget.used.images ?? 0);
    meter.addImageSearches(licensedSource?.searchBudget.used.searches ?? 0);
    meter.addRenderPages(pages);
  };

  try {
    await step('BUILDING_PRESENTATION');

    const plan = {
      ...planContent,
      plan_id: context.planId,
      plan_version_id: saved.versionId,
      request_id: context.requestId,
    };

    await step('RESOLVING_ASSETS');
    ai = deps.aiAssets === undefined ? undefined : await deps.aiAssets(modelContext);
    licensedSource = deps.searchAssets?.();
    const result = await buildAndSavePresentations(
      {
        ...presentation,
        logger: log,
        ...(ai === undefined ? {} : { ai }),
        ...(licensedSource === undefined ? {} : { licensedSource }),
      },
      plan,
    );

    meterAssets(result.pages);

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
    /* 页数按 0：一页都没落库。但已经生成的 AI 图仍要计费，钱已经花了 */
    meterAssets(0);
    log.error(
      { stage: 'RESOLVING_ASSETS', plan_version_id: saved.versionId },
      `展示编排失败，计划仍可通过 13.3 读取：${String(error)}`,
    );
    return { outcome: 'saved', versionId: saved.versionId, status: finalStatus };
  }
}

/**
 * 任务终态的 CR 结算（C-4）。
 *
 * 单一出口：`runJob` 有十来个 return，逐个接结算迟早漏掉一条 ——
 * 而漏掉的表现是那条路径上的预留永远挂着，用户的钱冻到过期。
 *
 * ## 四条分支的口径
 *
 * ```text
 * saved              settle    用户拿到了计划（13.3 可读即算拿到）
 * rejected           release   队列不重试它（main.ts 只对 failed 抛错）→ 已是终态
 * failed 不可重试    release   重试也是同样的结论，不会再有下一次
 * failed 可重试      保留      预留留给重试，理由见 billing.ts 文件头
 * cancelled          release   用户主动放弃，不该为没要的东西付费
 * not_found          什么都不做  用户已被清理，钱包与预留随 FK 级联删除了
 * already_terminal   什么都不做  另一个消费者已经结过
 * ```
 *
 * ## 结算失败不改变任务结果
 *
 * 整段包在 try 里：计划已经生成、已经落库、用户已经能看到。此刻因为一次
 * 数据库抖动把任务判成失败，是拿一份做好的产物去换一条账目 ——
 * 而账目还能靠预留过期与对账补，产物补不回来。
 */
async function settleBilling(
  deps: GeneratePlanDeps,
  jobId: string,
  outcome: GenerateOutcome,
  meter: UsageMeter,
): Promise<void> {
  const billing = deps.billing;
  if (billing === undefined) return;

  const usage = meter.snapshot();
  try {
    switch (outcome.outcome) {
      case 'saved':
        await billing.settle({ jobId, usage });
        return;
      case 'rejected':
        await billing.release({ jobId, usage });
        return;
      case 'failed': {
        if (isUnrecoverable(outcome.errorCode)) {
          await billing.release({ jobId, usage });
          return;
        }
        const priced = await billing.priceOf({ jobId, usage });
        if (priced !== null) {
          deps.logger.info(
            {
              job_id: jobId,
              stage: 'billing',
              error_code: outcome.errorCode,
              burned_cr: priced.totalCr,
            },
            '可重试的失败：预留保留给重试，本次烧掉的成本只记日志',
          );
        }
        return;
      }
      case 'skipped':
        if (outcome.reason === 'cancelled') await billing.release({ jobId, usage });
        return;
    }
  } catch (error) {
    deps.logger.error(
      { job_id: jobId, stage: 'billing' },
      `CR 结算失败，任务结果不受影响（预留将由过期清理兜住）：${String(error)}`,
    );
  }
}

export async function generatePlan(
  deps: GeneratePlanDeps,
  payload: GenerationJobPayload,
): Promise<GenerateOutcome> {
  const meter = new UsageMeter();
  const outcome = await runJob(deps, payload, meter);
  /*
   * `runJob` 抛异常时**不**结算：那时任务不在终态，BullMQ 会重试，
   * 而预留正是要留给那次重试的（与「可重试的失败」同一条口径）。
   */
  await settleBilling(deps, payload.jobId, outcome, meter);
  return outcome;
}
