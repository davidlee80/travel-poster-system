import { SLA_BUCKETS, createCounter, createHistogram } from '@tps/observability';
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
 * 21.3 的 `travel_job_milestone_seconds`（TP-4-14）。
 *
 * 这是**验证 21.2 分段 SLA 的唯一数据来源**：T1 < 75 秒、T2 < 110 秒，
 * 以及 21.3 的「SLA 违约」告警（T1 的 P95 持续 15 分钟超 75 秒）。
 *
 * `total_days_bucket` 是必须的维度：T3 按天数分档（≤7 天 240 秒、
 * 8～14 天 420 秒），而 T1/T2 同样与天数相关（8～14 天要分段调两次模型）。
 * 不分档的话，一个全是 14 天请求的时段会让 P95 看起来在违约，
 * 而它其实符合那一档的目标。
 *
 * `user_type` 是 R-13 的通用维度（分身份观察 SLA）。
 */
export const jobMilestoneSeconds = createHistogram({
  name: 'travel_job_milestone_seconds',
  help: '分段交付里程碑耗时（21.2 的 T1/T2/T3）',
  labelNames: ['milestone', 'total_days_bucket', 'user_type'],
  buckets: [...SLA_BUCKETS],
});

/**
 * 21.3 的 `travel_job_duration_seconds`（TP-5-01）。
 *
 * 与 `generation_jobs.stage_timings` 同源 —— 同一个 `StageTimer` 既观测这里
 * 又写库（见 stage-timer.ts）。`stage` 的取值是 `JobStatus` 全集加一个
 * `total`（聚合项）。
 *
 * 与 `travel_job_milestone_seconds` 的分工：里程碑指标回答「用户等了多久
 * 才看到东西」（T1/T2 两个用户可感知的点），这个指标回答「时间花在哪个
 * 阶段」。前者用于 SLA 告警，后者用于优化时定位瓶颈 —— 合成一个指标的话，
 * 任何一个用途都要靠猜。
 */
export const jobDurationSeconds = createHistogram({
  name: 'travel_job_duration_seconds',
  help: '生成任务各阶段耗时（stage=total 为整体）',
  labelNames: ['stage', 'total_days_bucket', 'outcome'],
  buckets: [...SLA_BUCKETS],
});

/**
 * 21.3 的 `travel_job_total`：成功率与错误分布。
 *
 * `error_code` 在成功时取 `none` 而不是省略标签：Prometheus 没有「标签缺失」
 * 的概念，省略会产出一条标签值为空串的序列，而空串在 PromQL 里既不等于
 * 任何具体值也不好过滤（`error_code!=""` 才能排除，很容易写错）。
 * 显式的 `none` 让「成功的任务」在查询里是一个可读的条件。
 */
export const jobTotal = createCounter({
  name: 'travel_job_total',
  help: '生成任务终局计数（按状态、错误码、身份类型）',
  labelNames: ['status', 'error_code', 'user_type'],
});

/**
 * 天数分档。与 21.2 的两档目标一致（≤7 天 / 8～14 天）。
 *
 * 用字符串而不是数字：标签值必须是有界小集合（21.3），
 * 而 `total_days` 有 14 个取值 —— 分成两档后图上才能直接对着目标读。
 */
export function totalDaysBucket(totalDays: number): string {
  return totalDays <= 7 ? '1-7' : '8-14';
}

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

/**
 * 21.3：3.2.4 全局检索命中率（TP-2-25）。
 *
 * `source` 区分 `versions`（在线计划的投影）与 `knowledge`
 * （匿名数据清理后沉淀的脱敏知识，15.1）。分开统计是因为后者是否真的
 * 被检索到，是「清理个人数据但保留行程知识」那套设计成立与否的唯一证据 ——
 * 合成一个指标的话，知识库完全没被用到也看不出来。
 */
export const retrievalReferenceTotal = createCounter({
  name: 'travel_retrieval_reference_total',
  help: '全局历史检索的命中情况（按结局与来源）',
  labelNames: ['outcome', 'source'],
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
