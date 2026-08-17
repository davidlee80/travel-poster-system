import { randomUUID } from 'node:crypto';

import type { TravelPlansRepository } from '@tps/db';
import type { EmbeddingClient, LlmClient } from '@tps/llm';
import {
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
import type { Logger } from '@tps/shared';

import { createPlanValidationObserver } from './plan-metrics.js';
import { retrieveReferences, type RetrievalDeps } from './retrieval.js';

/**
 * 生成任务的编排（TP-2-14，设计稿 3.2、16.1）。
 *
 * P2 覆盖状态机的前半段：
 * ```text
 * QUEUED → NORMALIZING → VALIDATING_REQUEST → RETRIEVING_REFERENCES
 *        → GENERATING_PLAN → VALIDATING_PLAN ⇄ REPAIRING_PLAN → SAVING_PLAN
 * ```
 *
 * **P2 的任务停在 `SAVING_PLAN`，不进入 `COMPLETED`。** 这是有意的：
 * 16.1 的 `COMPLETED` 必须经过 `BUILDING_PRESENTATION` → `RESOLVING_ASSETS`
 * → `RENDERING_HTML`，而那三段在 P3 交付。让 P2 直接跳到 `COMPLETED`
 * 会在状态机上开一条非法边，而那条边一旦存在，P3 接上真实渲染后
 * 「跳过渲染直接完成」的路径仍然可走 —— 用户会拿到一个没有图的「已完成」。
 *
 * 用户可见的效果不受影响：计划在 `SAVING_PLAN` 完成的那一刻就能通过
 * `GET /api/v1/travel-plans/{plan_id}` 读到完整文字版（13.3），
 * 这正是 TP-2-17 要的那个页面。
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
}

export type GenerateOutcome =
  | { readonly outcome: 'saved'; readonly versionId: string; readonly status: 'READY' | 'REPAIRED' }
  | { readonly outcome: 'rejected'; readonly versionId: string; readonly errorCode: PlanErrorCode }
  | { readonly outcome: 'failed'; readonly errorCode: PlanErrorCode }
  | { readonly outcome: 'skipped'; readonly reason: 'not_found' | 'already_terminal' };

/** 推进状态并写进度（16.1：状态与 progress 同一事务） */
async function advance(
  deps: GeneratePlanDeps,
  jobId: string,
  to: JobStatus,
  extra: { readonly errorCode?: string; readonly planVersionId?: string } = {},
): Promise<void> {
  const display = JOB_STAGE_DISPLAY[to];
  await deps.plans.updateJobState({
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

async function fail(
  deps: GeneratePlanDeps,
  jobId: string,
  errorCode: PlanErrorCode,
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
  });
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
): Promise<{ output: TravelPlanLlmOutput; inputTokens: number; outputTokens: number }> {
  const result = await llm.complete({
    system: messages.system,
    user: messages.user,
    jsonSchema: { name: 'travel_plan', schema: travelPlanLlmOutputJsonSchema },
    maxTokens,
    purpose,
    timeoutMs: deps.llmTimeoutMs,
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
): Promise<{ output: TravelPlanLlmOutput; inputTokens: number; outputTokens: number }> {
  const segments = planSegments(normalized.total_days);
  const maxTokens = maxTokensForDays(normalized.total_days);

  const outputs: TravelPlanLlmOutput[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const segment of segments) {
    const messages = buildPlanPrompt({
      normalized,
      segment,
      totalSegments: segments.length,
      references: references.map((reference) => reference.projection),
    });
    const result = await callModel(deps, llm, messages, maxTokens, 'plan');
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

  // ── NORMALIZING：标准化结果已在同步路径算好，这里只读回并校验形状 ──
  await advance(deps, context.jobId, 'NORMALIZING');
  const normalizedParsed = NormalizedTravelRequestSchema.safeParse(context.normalizedRequest);
  if (!normalizedParsed.success) {
    /*
     * 库里的 normalized_request 形状不对，只可能是标准化规则改版后
     * 老行被重放。它不是用户能修的问题，也不是重试能好的问题。
     */
    log.error({ stage: 'NORMALIZING' }, '标准化结果不满足当前契约');
    return fail(deps, context.jobId, 'PLAN_SCHEMA_INVALID');
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
  await advance(deps, context.jobId, 'VALIDATING_REQUEST');

  // ── RETRIEVING_REFERENCES（3.2.4）──
  await advance(deps, context.jobId, 'RETRIEVING_REFERENCES');
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
  await advance(deps, context.jobId, 'GENERATING_PLAN');
  let generated;
  try {
    generated = await generateContent(deps, llm, normalized, retrieved.references);
  } catch (error) {
    const code = errorCodeFor(error);
    log.error({ stage: 'GENERATING_PLAN', error_code: code }, '计划生成失败');
    return fail(deps, context.jobId, code);
  }

  // ── VALIDATING_PLAN ⇄ REPAIRING_PLAN（3.2.1、3.2.2）──
  await advance(deps, context.jobId, 'VALIDATING_PLAN');

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
          await advance(deps, context.jobId, 'REPAIRING_PLAN');
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
  await advance(deps, context.jobId, 'SAVING_PLAN');

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
    return fail(deps, context.jobId, 'PLAN_PERSIST_FAILED');
  }

  if (finalStatus === 'REJECTED') {
    /*
     * 3.2.2：修复失败的计划只落库供排查，不成为可展示版本。
     * 先落库再置 FAILED，顺序不能反 —— 反了的话排查时拿不到那份草稿，
     * 而它是唯一能说明「模型到底写了什么」的证据。
     */
    const code = resolved.errorCode ?? 'PLAN_REPAIR_EXHAUSTED';
    log.warn({ stage: 'SAVING_PLAN', error_code: code }, '计划未通过校验，落库为 REJECTED');
    await fail(deps, context.jobId, code, saved.versionId);
    return { outcome: 'rejected', versionId: saved.versionId, errorCode: code };
  }

  /*
   * 停在 SAVING_PLAN，不推进到 COMPLETED —— 见文件头说明。
   * 计划此刻已可通过 13.3 读到。
   */
  await deps.plans.updateJobState({
    jobId: context.jobId,
    to: 'SAVING_PLAN',
    progress: JOB_STAGE_DISPLAY.SAVING_PLAN.progress ?? 60,
    message: stageMessage('SAVING_PLAN'),
    planVersionId: saved.versionId,
  });

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

  return { outcome: 'saved', versionId: saved.versionId, status: finalStatus };
}
