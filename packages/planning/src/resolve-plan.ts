import type {
  NormalizedTravelRequest,
  PlanErrorCode,
  PlanStatus,
  TravelPlanContent,
} from '@tps/schemas';

import {
  hasBlocking,
  validatePlan,
  type PlanValidationContext,
  type PlanViolation,
} from './plan-rules.js';
import { addAssumption, degradeToAssumption, repairPlan } from './repair-plan.js';

/**
 * 两级修复的编排（TP-2-13，设计稿 3.2.2）。
 *
 * ```text
 * 第一级 程序化修复   ≤ 3 轮／每次进入，纯函数，无模型调用
 * 第二级 LLM 定向重生成 ≤ 2 次，全任务累计
 * ```
 *
 * ## 为什么重生成是注入的回调而不是直接依赖 LlmClient
 *
 * `@tps/planning` 是零 IO 的纯逻辑包（与 `@tps/schemas`、`@tps/presentation`
 * 一致）。把 LLM 客户端拉进来会让这个包获得网络依赖，随之而来的是
 * 「测收敛性必须起一个 mock server」。注入回调后，收敛性测试可以用一个
 * 同步的假重生成函数跑 100 个随机违规计划，而生产代码在
 * `apps/generation-worker` 里把它接到真实客户端（TP-2-10）。
 */

/** 3.2.2：程序化修复最大轮次 */
export const MAX_DETERMINISTIC_ROUNDS = 3;
/** 3.2.2：LLM 定向重生成最大次数（全任务累计，不是每天 2 次） */
export const MAX_REGENERATIONS = 2;

export interface RegenerationRequest {
  readonly normalized: NormalizedTravelRequest;
  /** 上一版计划。3.2.2 要求把「上一版该日内容」一并作为输入 */
  readonly plan: TravelPlanContent;
  /** 触发重生成的违规清单（只含 BLOCKING 才有意义，但完整传递便于提示构造） */
  readonly violations: readonly PlanViolation[];
  /** 第几次重生成，1 起 */
  readonly attempt: number;
}

/**
 * 定向重生成。
 *
 * 约定返回**完整的** `TravelPlanContent`：只重生成受影响的天是实现细节，
 * 由调用方（LLM 客户端）负责把局部结果合回整体。编排层若也参与合并，
 * 「哪几天被替换了」这个知识就分散在两处，而它只有构造提示的那一方清楚。
 *
 * 抛错视为本次失败并计入次数（3.2.2：单次重生成超时 30 秒，超时按失败计）。
 */
export type RegeneratePlan = (request: RegenerationRequest) => Promise<TravelPlanContent>;

export interface ResolvePlanSummary {
  readonly status: PlanStatus;
  /** 累计的程序化修复轮次（跨重生成累加），用于 `travel_plan_repair_iterations` */
  readonly deterministicRounds: number;
  readonly regenerations: number;
  readonly errorCode: PlanErrorCode | null;
}

export interface ResolvePlanObserver {
  /**
   * 每跑完一次全量规则调用一次（含首轮原始输出）。
   *
   * 供 `travel_validation_violations_total{rule_id, severity}` 打点。
   * 刻意每轮都打而不是只打首轮：修复动作本身可能引入新违规
   * （V-12 的平移会撞 V-13 的收尾时间），只统计首轮会让这类连锁完全不可见，
   * 而它恰恰是「规则集是否过严」最直接的证据（21.3 的「修复异常」告警）。
   */
  readonly onValidated?: (violations: readonly PlanViolation[]) => void;
  /** 结束时调用一次 */
  readonly onSettled?: (summary: ResolvePlanSummary) => void;
}

export interface ResolvePlanOptions {
  readonly regenerate?: RegeneratePlan;
  readonly observer?: ResolvePlanObserver;
  readonly maxDeterministicRounds?: number;
  readonly maxRegenerations?: number;
}

export interface ResolvePlanResult<T extends TravelPlanContent> extends ResolvePlanSummary {
  readonly plan: T;
  /** 收尾时仍然存在的违规（`REJECTED` 时含 BLOCKING，其余只含 ADVISORY） */
  readonly violations: readonly PlanViolation[];
}

/**
 * 把 3.1.1 标准化阶段产生的假设带入计划。
 *
 * `NormalizedTravelRequest.assumptions` 是字符串数组（「自定义需求已截断」
 * 之类），而用户看到的假设清单是 `constraint_report.assumptions`。
 * 不在这里合并，标准化阶段那些假设就只存在于 `normalized_request` 里，
 * 用户永远看不到 —— 而 5.1 要求截断必须可见。
 */
function carryRequestAssumptions(
  plan: TravelPlanContent,
  normalized: NormalizedTravelRequest,
): void {
  for (const text of normalized.assumptions) {
    addAssumption(plan, 'REQUEST_ASSUMPTION', text, null);
  }
}

/**
 * 执行两级修复，返回可落库的计划与状态。
 *
 * `status` 的判定：
 *   - `READY`     首轮全量规则零违规，原样通过；
 *   - `REPAIRED`  经过修复或降级记录后无 `BLOCKING`；
 *   - `REJECTED`  迭代耗尽仍有 `BLOCKING`。按 3.2.2，这份计划只落库供排查，
 *                 `GET /api/v1/travel-plans/{plan_id}` 不返回它。
 */
export async function resolvePlan<T extends TravelPlanContent>(
  input: T,
  ctx: PlanValidationContext,
  options: ResolvePlanOptions = {},
): Promise<ResolvePlanResult<T>> {
  const maxRounds = options.maxDeterministicRounds ?? MAX_DETERMINISTIC_ROUNDS;
  const maxRegenerations = options.maxRegenerations ?? MAX_REGENERATIONS;
  const { regenerate, observer } = options;

  // 不改调用方的对象：编排过程中要写 assumptions，原地改会让上游的
  // 「模型原始输出」被污染，而排查 REJECTED 时需要的正是那份原文
  let current = structuredClone(input);
  carryRequestAssumptions(current, ctx.normalized);

  let violations = validatePlan(current, ctx);
  observer?.onValidated?.(violations);

  const pristine = violations.length === 0;
  let totalRounds = 0;
  let regenerations = 0;

  for (;;) {
    // ── 第一级：程序化修复 ──
    let rounds = 0;
    while (rounds < maxRounds && violations.length > 0) {
      const result = repairPlan(current, ctx);
      rounds += 1;
      totalRounds += 1;
      current = result.plan;

      // 不动点：再修也不会变，继续跑满 3 轮只是浪费时间
      if (!result.changed) break;

      violations = validatePlan(current, ctx);
      observer?.onValidated?.(violations);
    }

    if (!hasBlocking(violations)) break;

    // ── 第二级：LLM 定向重生成 ──
    if (regenerate === undefined || regenerations >= maxRegenerations) break;

    regenerations += 1;
    try {
      const regenerated = await regenerate({
        normalized: ctx.normalized,
        plan: current,
        violations,
        attempt: regenerations,
      });
      /*
       * 用展开合并而不是直接替换：`T` 可能带程序注入的
       * `plan_id` / `plan_version_id` / `request_id`（6.3 明确规定模型不产出
       * 这些字段），直接替换会把它们丢掉。
       */
      current = { ...current, ...regenerated };
      violations = validatePlan(current, ctx);
      observer?.onValidated?.(violations);
    } catch {
      // 3.2.2：超时／失败都计入次数，不无限重试
    }
  }

  let status: PlanStatus;
  let errorCode: PlanErrorCode | null = null;

  if (hasBlocking(violations)) {
    status = 'REJECTED';
    /*
     * 16.3 把 `PLAN_HARD_CONSTRAINT_UNSATISFIABLE` 定为「立即 FAILED，不重试」，
     * 而 3.2.1 又要求 V-30/V-31 先走 LLM 重生成。两者并不矛盾：先按 3.2.2
     * 用完重生成次数，仍然满足不了才断定「硬约束不可满足」——
     * 这时重试确实不会改变结果，必须由用户放宽条件，因此该码 retryable=false。
     */
    const mustUnsatisfiable = violations.some((v) => v.rule === 'V-30' || v.rule === 'V-31');
    errorCode = mustUnsatisfiable ? 'PLAN_HARD_CONSTRAINT_UNSATISFIABLE' : 'PLAN_REPAIR_EXHAUSTED';
  } else if (pristine) {
    status = 'READY';
  } else {
    status = 'REPAIRED';
    // 3.2.2：修不掉的 REPAIRABLE 降级为 assumptions 后放行
    for (const violation of violations) {
      if (violation.severity === 'REPAIRABLE') {
        degradeToAssumption(current, violation);
      }
    }
  }

  const summary: ResolvePlanSummary = {
    status,
    deterministicRounds: totalRounds,
    regenerations,
    errorCode,
  };
  observer?.onSettled?.(summary);

  return { ...summary, plan: current, violations };
}
