import { resolveCandidates, type ModelPoolKind, type ModelPoolsRepository } from '@tps/db';
import {
  wrapImageFailover,
  wrapLlmFailover,
  type FailoverOutcome,
  type ImageClient,
  type LlmClient,
} from '@tps/llm';
import type { Logger } from '@tps/shared';

import { JOB_TIMEOUT_MS } from '../job-deadline.js';

import { aiFailoverTotal, aiPoolClampedTotal, failoverPositionLabel } from './asset-metrics.js';

/**
 * 按用户等级挑选候选模型并装配故障转移客户端（多模型 failover 计划的任务 4）。
 *
 * ## 为什么这一层单独存在
 *
 * 候选是**每任务**决定的（取决于 `users.tier_level`），而客户端的构造需要
 * 进程级的东西（fake 渲染函数、fetch 实现）。放在 `main.ts` 里就没法测 ——
 * 那个模块一被 import 就会连库、起 Worker。因此这里只做「等级 → 候选序列 →
 * 包好的客户端」，构造单个客户端的方式由调用方以 `build` 注入。
 *
 * ## 读配置失败一律回落，不让任务失败
 *
 * 两张表为空、映射查不到、甚至数据库此刻抖了 —— 结果都是回落到 env 的单模型。
 * 相反的做法（读不到配置就失败）会让一个**可选**特性变成新的单点：
 * 池是用来提高成功率的，它自己不该成为失败原因。
 *
 * ## 两侧都会被截断，但预算的来源不同
 *
 * 图像受 21.2 的素材窗口约束（`IMAGE_JOB_AI_BUDGET_MS`）；文本受 16.3 的
 * 300 秒任务上限约束，份额见 `LLM_CHAIN_BUDGET_MS`。两侧都走
 * `resolveCandidates`，因此「配了 10 个而预算只够 2 个」在两侧都会被截断
 * 并报 `travel_ai_pool_clamped_total` —— 静默截断会让运营以为配置生效了。
 *
 * 文本侧曾经不截断，理由是「`callModel` 已经把单次超时压到任务剩余预算内，
 * 300 秒天然兜住最坏情况」。那句话只对**单次调用**成立：一条链会串行发
 * 多个请求，每个都拿着同一个剩余预算，于是 20 个候选能把 deadline 超出
 * 二十倍。真正兜住它的是 `callModel` 传下来的 signal（让链停止开新候选），
 * 而截断负责的是另一件事 —— 让「配了却试不到」这件事可见。
 */

export interface PoolSelectionBase {
  /** 缺省（null）表示本部署没有装配池仓储，直接走 env 单模型 */
  readonly pools: ModelPoolsRepository | null;
  readonly tierLevel: number;
  readonly logger: Logger;
}

export interface SelectedClient<T> {
  readonly client: T;
  /** 实际用上的模型名，按尝试顺序。空数组表示回落到了 env 单模型 */
  readonly candidates: readonly string[];
  /** 命中的池名。null 表示无配置 */
  readonly poolName: string | null;
  /** 配置的候选数被时延预算削过（只可能发生在图像侧） */
  readonly clamped: boolean;
}

/** 无配置时的结果：原样使用 env 客户端 */
function fallbackTo<T>(client: T): SelectedClient<T> {
  return { client, candidates: [], poolName: null, clamped: false };
}

/**
 * 读一次池配置。任何失败都当作「无配置」，并留下一条 warn。
 *
 * 不用 `logger.error`：这不是错误而是降级 —— 系统照 env 的单模型继续工作，
 * 与迁移后未配置任何池的部署走同一条路径。
 */
async function readPool(
  input: PoolSelectionBase,
  kind: 'LLM' | 'IMAGE',
): Promise<{
  readonly poolName: string;
  readonly models: readonly string[];
  readonly maxCandidates: number | null;
} | null> {
  if (input.pools === null) return null;

  try {
    const selection = await input.pools.select(kind, input.tierLevel);
    if (selection === null) return null;

    if (selection.models.length === 0) {
      /*
       * 映射存在、池也存在，但 `models` 里没有一个字符串项 —— 迁移 0009 的
       * CHECK 只验「是非空数组」，验不了元素类型，直接写 `[1,2,3]` 就会到这里。
       *
       * 处置与「没有配置」相同（回落 env），但**必须能区分**：前者是配错了。
       * 不留痕的话运营从 `--list` 能看到空的 `[]`，而运行时没有任何信号，
       * 于是「为什么配了池却没生效」查不出来。
       */
      input.logger.warn(
        {
          kind,
          tier_level: input.tierLevel,
          pool_name: selection.poolName,
          reason_code: 'MODEL_POOL_EMPTY_AFTER_FILTER',
        },
        `候选池 ${selection.poolName} 没有合法的模型名（非字符串项已被过滤），回落到单模型`,
      );
      return null;
    }

    return selection;
  } catch (error) {
    input.logger.warn(
      { kind, tier_level: input.tierLevel, reason_code: 'MODEL_POOL_READ_FAILED' },
      `读取模型候选池失败，回落到单模型：${String(error)}`,
    );
    return null;
  }
}

/**
 * 一条候选链落定后的指标与日志。
 *
 * 放在这一层而不是让调用方各自实现：`kind` 与位次的有界化只有这里知道，
 * 而两个调用点（图像的每任务工厂、文本的每任务工厂）需要的处置完全相同。
 * 交给调用方的结果会是「图像侧记了指标、文本侧只记了日志」这种不对称。
 */
function outcomeReporter(kind: ModelPoolKind, logger: Logger): (outcome: FailoverOutcome) => void {
  return (outcome) => {
    aiFailoverTotal.inc({
      kind,
      position: failoverPositionLabel(outcome.position),
      outcome: outcome.ok ? 'success' : 'failed',
    });

    // 主模型直接胜出是常态，不记日志（否则每次生成都留一行噪音）
    if (outcome.position === 0) return;

    logger.warn(
      {
        kind,
        reason_code: 'AI_MODEL_FAILOVER',
        position: outcome.position,
        attempts: outcome.attemptsStarted,
      },
      outcome.ok
        ? `${kind} 主模型未胜出，采用第 ${outcome.position + 1} 个候选`
        : `${kind} 候选链全部失败（发出 ${outcome.attemptsStarted} 个请求）`,
    );
  };
}

export interface ImageSelectionInput extends PoolSelectionBase {
  /** 无池配置时使用的客户端（由 `IMAGE_MODEL` 构造） */
  readonly fallback: ImageClient;
  readonly build: (model: string) => ImageClient;
  /** `IMAGE_TIMEOUT_MS` */
  readonly perAttemptMs: number;
  /** `IMAGE_JOB_AI_BUDGET_MS` */
  readonly totalBudgetMs: number;
}

export async function selectImageClient(
  input: ImageSelectionInput,
): Promise<SelectedClient<ImageClient>> {
  const pool = await readPool(input, 'IMAGE');
  if (pool === null) return fallbackTo(input.fallback);

  const { candidates, clamped } = resolveCandidates({
    models: pool.models,
    maxCandidates: pool.maxCandidates,
    perAttemptMs: input.perAttemptMs,
    totalBudgetMs: input.totalBudgetMs,
  });

  if (clamped) {
    /*
     * 必须可见：静默截断会让运营以为把候选数调到 10 生效了，
     * 而实际只试 2 个 —— 于是「为什么成功率没上去」查不出原因。
     */
    aiPoolClampedTotal.inc({ kind: 'IMAGE' });
    input.logger.warn(
      {
        kind: 'IMAGE',
        pool_name: pool.poolName,
        reason_code: 'MODEL_POOL_CLAMPED',
        configured: pool.maxCandidates,
        effective: candidates.length,
      },
      `图像候选数被时延预算削到 ${candidates.length}：` +
        `${input.perAttemptMs} 毫秒/候选 × 配置值超过了 ${input.totalBudgetMs} 毫秒的任务预算`,
    );
  }

  return {
    // 单候选时 wrapImageFailover 原样返回底层客户端（零开销，见 failover.ts）
    client: wrapImageFailover(candidates.map(input.build), {
      perAttemptMs: input.perAttemptMs,
      totalBudgetMs: input.totalBudgetMs,
      onOutcome: outcomeReporter('IMAGE', input.logger),
    }),
    candidates,
    poolName: pool.poolName,
    clamped,
  };
}

/**
 * 一条文本候选链允许占用的总时长。
 *
 * 文本没有图像那样的独立窗口（21.2 的素材窗口），它的硬约束是 16.3 的
 * 300 秒任务上限。而一个任务最多**串行**调三次模型：14 天分两段
 * （`planSegments`）加一次修复（`repair`）—— 每一次都可能是一条完整的链。
 * 因此一条链的份额取三分之一，超出的候选配了也试不到。
 *
 * 不做成 env：它不是可调参数，而是从 `JOB_TIMEOUT_MS` 与「最多三次调用」
 * 推出来的。做成 env 会让两个本该联动的数字各自漂移。
 */
export const LLM_CHAIN_BUDGET_MS = Math.floor(JOB_TIMEOUT_MS / 3);

export interface LlmSelectionInput extends PoolSelectionBase {
  readonly fallback: LlmClient;
  readonly build: (model: string) => LlmClient;
  /** `LLM_TIMEOUT_MS` */
  readonly perAttemptMs: number;
}

export async function selectLlmClient(
  input: LlmSelectionInput,
): Promise<SelectedClient<LlmClient>> {
  const pool = await readPool(input, 'LLM');
  if (pool === null) return fallbackTo(input.fallback);

  /*
   * 与图像侧走同一个 `resolveCandidates`。
   *
   * 曾经这里是手写的 `slice(0, min(max, size))` 且 `clamped` 恒为 false，
   * 于是 `travel_ai_pool_clamped_total{kind="LLM"}` 永不增长 —— 运营把
   * `max_candidates` 配成 20 时没有任何信号，而实际只会试到任务预算耗尽。
   * 「配置看起来生效了，实际没有」正是那个指标存在的理由。
   *
   * CLI 的 `--list` 也调这个函数，因此两处不可能给出不同的候选数。
   */
  const { candidates, clamped } = resolveCandidates({
    models: pool.models,
    maxCandidates: pool.maxCandidates,
    perAttemptMs: input.perAttemptMs,
    totalBudgetMs: LLM_CHAIN_BUDGET_MS,
  });

  if (clamped) {
    aiPoolClampedTotal.inc({ kind: 'LLM' });
    input.logger.warn(
      {
        kind: 'LLM',
        pool_name: pool.poolName,
        reason_code: 'MODEL_POOL_CLAMPED',
        configured: pool.maxCandidates,
        effective: candidates.length,
      },
      `文本候选数被链预算削到 ${candidates.length}：` +
        `${input.perAttemptMs} 毫秒/候选 × 配置值超过了 ${LLM_CHAIN_BUDGET_MS} 毫秒的单链预算`,
    );
  }

  return {
    client: wrapLlmFailover(candidates.map(input.build), {
      perAttemptMs: input.perAttemptMs,
      /*
       * 链预算 = 单次超时 × 候选数，即「每个候选都等满」的最坏情况。
       * 不额外压缩：`callModel` 会再把单次超时压到任务剩余预算内，
       * 两层都压的话超时会被削两次，表现是「明明配了 30 秒却 10 秒就超时」。
       *
       * 任务预算的兜底不在这个数里，而在 `callModel` 传下来的 signal ——
       * 它让链在 deadline 到时停止开新候选（见 wrapLlmFailover）。
       */
      totalBudgetMs: input.perAttemptMs * Math.max(1, candidates.length),
      onOutcome: outcomeReporter('LLM', input.logger),
    }),
    candidates,
    poolName: pool.poolName,
    clamped,
  };
}
