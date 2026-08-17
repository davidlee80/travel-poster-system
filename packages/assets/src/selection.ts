import {
  SCORE_ACCEPT_IMMEDIATELY,
  SCORE_MINIMUM,
  scoreAsset,
  type ScoreBreakdown,
  type ScoringCandidate,
  type ScoringRequirement,
} from './scoring.js';

/**
 * 检索终止条件（TP-3-08，设计稿 10.2）。
 *
 * ```text
 * 1. 向量检索取 Top 30 候选（带 entity/destination 预过滤）
 * 2. 逐一算 final_score，按分降序
 * 3. 终止：出现 >= 0.80 立即采用；否则算完 30 个取最高分
 * 4. 最高分 >= 0.65 采用；< 0.65 进入下一层来源
 * 5. 单槽位检索总耗时上限 800 毫秒，超时按「未命中」处理
 * ```
 *
 * ## 为什么「立即采用」值得单独实现
 *
 * 30 个候选的打分本身很快（纯计算），省下的不是 CPU 而是**尾部延迟**：
 * 打分函数将来若引入任何 IO（比如按需补算向量），提前退出就是 800 毫秒
 * 预算内外的差别。把它写成显式的终止规则，也让「继续查找」这句话
 * 有了确定含义 —— 10.2 存在的原因正是 V1.0 那句话没有边界。
 *
 * ## 超时不是「取消检索」
 *
 * 800 毫秒的上限由**调用方**用 `deadline` 传入，本函数在每个候选之前检查。
 * 超时时返回已算出的最好结果（若达阈值）而不是直接放弃 ——
 * 已经算出的分数是真实的，丢掉它去做 AI 生成既慢又贵。
 */

/** 10.2 第 1 步：候选集上界 */
export const CANDIDATE_LIMIT = 30;
/** 10.2 第 5 步：单槽位检索耗时上限 */
export const SELECTION_BUDGET_MS = 800;

export interface ScoredCandidate {
  readonly candidate: ScoringCandidate;
  readonly score: ScoreBreakdown;
}

export type SelectionOutcome =
  /** 最高分 >= 0.65，采用 */
  | { readonly kind: 'accepted'; readonly best: ScoredCandidate; readonly reason: SelectionReason }
  /** 达不到阈值或没有候选，进入下一层来源 */
  | {
      readonly kind: 'below_threshold';
      readonly best: ScoredCandidate | null;
      readonly reason: SelectionReason;
    };

export type SelectionReason =
  /** 出现 >= 0.80 的候选，提前退出 */
  | 'immediate'
  /** 候选全部算完 */
  | 'exhausted'
  /** 超出 800 毫秒预算 */
  | 'timeout'
  /** 没有候选 */
  | 'empty';

export interface SelectOptions {
  /** 单调时钟。默认 `Date.now`；测试注入假时钟 */
  readonly now?: () => number;
  /** 绝对截止时刻（毫秒）。缺省为 `now() + 800` */
  readonly deadline?: number;
  readonly candidateLimit?: number;
}

export interface SelectionResult {
  readonly outcome: SelectionOutcome;
  /** 实际参与打分的候选数（用于打点与容量评估） */
  readonly evaluated: number;
}

export function selectBestCandidate(
  requirement: ScoringRequirement,
  candidates: readonly ScoringCandidate[],
  options: SelectOptions = {},
): SelectionResult {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + SELECTION_BUDGET_MS;
  const limit = options.candidateLimit ?? CANDIDATE_LIMIT;

  const pool = candidates.slice(0, limit);
  if (pool.length === 0) {
    return { outcome: { kind: 'below_threshold', best: null, reason: 'empty' }, evaluated: 0 };
  }

  let best: ScoredCandidate | null = null;
  let evaluated = 0;
  let reason: SelectionReason = 'exhausted';

  for (const candidate of pool) {
    /*
     * 预算检查放在打分**之前**：放在之后的话，最后一个候选一定会被算完，
     * 超时上限就变成「800 毫秒 + 一次打分」。差值很小，但同样的写法
     * 出现在带 IO 的循环里就是超时形同虚设。
     */
    if (now() >= deadline) {
      reason = 'timeout';
      break;
    }

    const score = scoreAsset(requirement, candidate);
    evaluated += 1;

    if (best === null || score.final > best.score.final) {
      best = { candidate, score };
    }

    if (score.final >= SCORE_ACCEPT_IMMEDIATELY) {
      return {
        outcome: { kind: 'accepted', best: { candidate, score }, reason: 'immediate' },
        evaluated,
      };
    }
  }

  if (best !== null && best.score.final >= SCORE_MINIMUM) {
    return { outcome: { kind: 'accepted', best, reason }, evaluated };
  }

  return { outcome: { kind: 'below_threshold', best, reason }, evaluated };
}
