import { createCounter, createHistogram } from '@tps/observability';
import {
  MAX_DETERMINISTIC_ROUNDS,
  MAX_REGENERATIONS,
  type ResolvePlanObserver,
} from '@tps/planning';

/**
 * 业务规则校验与修复的指标（TP-2-12、TP-2-13，设计稿 21.3）。
 *
 * ## 为什么指标在 worker 里，规则在 @tps/planning 里
 *
 * `@tps/planning` 是零 IO 的纯逻辑包。把 prom-client 拉进去会让「跑一遍
 * 28 条规则」变成「顺带写一个全局注册表」—— 单测之间因此共享可变状态，
 * 一个测试的计数会漏进另一个的断言。因此规则层只提供
 * `ResolvePlanObserver` 回调，由这里接到注册表上。
 */

/**
 * 21.3：定位最常违规的规则。
 *
 * `rule_id` 有 28 个取值、`severity` 有 3 个 —— 都是有界小集合，
 * 因此可以作标签（白名单见 @tps/observability 的 ALLOWED_LABELS）。
 */
export const validationViolationsTotal = createCounter({
  name: 'travel_validation_violations_total',
  help: '业务规则违规计数（3.2.1 的 V-01～V-45，按规则与级别）',
  labelNames: ['rule_id', 'severity'],
});

/**
 * 21.3：校验规则集是否过严。
 *
 * 桶边界压着 3.2.2 的上限布置：3 是单次进入第一级的上限，
 * 9 是「3 轮 × (1 次主生成 + 2 次重生成)」的理论最大值。
 * P95 贴到 3 就意味着规则集把大量正常输出判成了违规（21.3 的「修复异常」告警）。
 */
export const planRepairIterations = createHistogram({
  name: 'travel_plan_repair_iterations',
  help: '程序化修复轮次分布',
  labelNames: ['outcome'],
  buckets: [
    0,
    1,
    2,
    MAX_DETERMINISTIC_ROUNDS,
    4,
    6,
    MAX_DETERMINISTIC_ROUNDS * (1 + MAX_REGENERATIONS),
  ],
});

/** 21.3：LLM 定向重生成次数，直接对应成本 */
export const planRegenerationsTotal = createCounter({
  name: 'travel_plan_regenerations_total',
  help: 'LLM 定向重生成次数（按最终结局）',
  labelNames: ['outcome'],
});

/**
 * 把 `resolvePlan` 的回调接到指标上。
 *
 * `onValidated` 每轮都会被调用，因此计数含**修复后重跑**的那几轮 ——
 * 这是有意的：修复动作本身可能引入新违规（V-12 的平移会撞 V-13 的收尾时间），
 * 只统计首轮会让这类连锁完全不可见，而它恰恰是判断规则集是否互相打架的
 * 唯一证据。代价是绝对值不能读成「模型犯了多少错」，只能读成
 * 「哪条规则最常触发」—— 而 21.3 要的正是后者。
 */
export function createPlanValidationObserver(): ResolvePlanObserver {
  return {
    onValidated: (violations) => {
      for (const violation of violations) {
        validationViolationsTotal.inc({
          rule_id: violation.rule,
          severity: violation.severity,
        });
      }
    },
    onSettled: (summary) => {
      const outcome = summary.status.toLowerCase();
      planRepairIterations.observe({ outcome }, summary.deterministicRounds);
      if (summary.regenerations > 0) {
        planRegenerationsTotal.inc({ outcome }, summary.regenerations);
      }
    },
  };
}
