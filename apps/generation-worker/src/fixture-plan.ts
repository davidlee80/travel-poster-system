import {
  makeTravelPlanFixture,
  type NormalizedTravelRequest,
  type TravelPlanLlmOutput,
} from '@tps/schemas';

/**
 * `LLM_MODE=fake` 时的录制输出（TP-2-10）。
 *
 * ## 为什么要按请求生成，而不是一份写死的 JSON
 *
 * 写死一份 5 天杭州计划的话，`fake` 模式只对「恰好 5 天、恰好杭州、
 * 恰好没有硬约束」的请求可用；其余请求会走到 V-01（天数不符）或
 * V-30（硬约束未满足）的 `BLOCKING`，重生成两次仍是同一份，最终 `REJECTED`。
 * 而 `fake` 是**默认模式** —— 那等于默认配置下的 Worker 处理不了任何请求。
 *
 * 因此这里按请求构造：天数、出发日期、目的地、人数取自请求，
 * 并把请求里的硬约束逐条写进 `constraint_report.satisfied`。
 *
 * ## 它不是「假装有个模型」
 *
 * 产出的行程内容是固定的几个杭州 POI —— 目的地写着「北京」时，
 * 里面仍然是拱宸桥。这一点不掩饰：`fake` 模式的用途是**打通链路**
 * （提交 → 入队 → 校验 → 修复 → 落库 → 读取），不是产出可用的行程。
 * 真实模型接入见 `LLM_MODE=direct|gateway`。
 */
export function fixturePlanFor(normalized: NormalizedTravelRequest): TravelPlanLlmOutput {
  const plan = makeTravelPlanFixture({
    totalDays: Math.max(1, Math.min(14, normalized.total_days)),
    startDate: normalized.start_date,
  });

  const {
    schema_version: _schemaVersion,
    status: _status,
    plan_id: _planId,
    plan_version_id: _planVersionId,
    request_id: _requestId,
    ...content
  } = plan;

  return {
    ...content,
    title: `${normalized.destination_name}${normalized.total_days}日行程（示例数据）`,
    destination: {
      name: normalized.destination_name,
      place_id: normalized.destination_place_id ?? null,
    },
    traveler_count: normalized.traveler_count,
    currency: normalized.budget.currency,
    days: content.days.map((day) => ({ ...day, city: normalized.destination_name })),
    constraint_report: {
      /*
       * V-30 要求每个 `must_conditions` 都出现在 satisfied 中。
       * 这里逐条写入 —— 不写的话默认模式下每个带硬约束的请求都会 REJECTED。
       *
       * `evidence` 明说是示例数据：约束报告会展示给用户，
       * 编一句「已为你安排带电梯的住宿」是在假数据上再加一层假承诺。
       */
      satisfied: normalized.must_conditions.map((condition) => ({
        code: condition.code,
        mode: condition.mode,
        evidence: '示例数据未实际核验该条件。',
      })),
      violated: [],
      assumptions: [
        {
          code: 'FIXTURE_PLAN',
          text: '当前使用示例数据生成，行程内容不代表真实推荐。',
          rule_id: null,
        },
      ],
    },
  };
}
