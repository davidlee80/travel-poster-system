import { metricsText } from '@tps/observability';
import { makeValidContext, makeValidPlan, resolvePlan } from '@tps/planning';
import type { TravelPlan } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { createPlanValidationObserver } from './plan-metrics.js';

/**
 * TP-2-12 的验收项之一：`travel_validation_violations_total` 按 `rule_id` 打点。
 *
 * 断言落在**导出的指标文本**上而不是内部计数器对象：前者是 Prometheus 真正
 * 抓到的东西。指标注册成功但标签名写错时，计数器对象看起来一切正常，
 * 而抓取到的序列少了维度 —— 21.3 的「定位最常违规的规则」也就无从谈起。
 */

describe('校验与修复指标', () => {
  it('违规按 rule_id 与 severity 打点，修复轮次进直方图', async () => {
    const plan = makeValidPlan() as TravelPlan & Record<string, any>;
    plan.days[0]!.city = '苏州';
    plan.days[2]!.route_recommendations[0]!.nodes = ['拱宸桥'];

    const result = await resolvePlan(plan, makeValidContext(), {
      observer: createPlanValidationObserver(),
    });
    expect(result.status).toBe('REPAIRED');

    const text = await metricsText();

    expect(text).toContain(
      'travel_validation_violations_total{rule_id="V-04",severity="REPAIRABLE"}',
    );
    expect(text).toContain(
      'travel_validation_violations_total{rule_id="V-43",severity="REPAIRABLE"}',
    );
    expect(text).toContain('travel_plan_repair_iterations_bucket{le="3",outcome="repaired"}');
  });

  it('指标标签里没有任何高基数字段', async () => {
    /*
     * 二十章：指标标签不得使用 user_id、plan_id 一类字段。
     * 该约束由 @tps/observability 的类型系统在编译期强制，这里做一次
     * 运行期兜底 —— 未来若有人用动态标签名绕过类型检查，这条会失败。
     */
    const text = await metricsText();
    const planMetricLines = text
      .split('\n')
      .filter((line) => line.startsWith('travel_validation_') || line.startsWith('travel_plan_'));

    expect(planMetricLines.length).toBeGreaterThan(0);
    for (const line of planMetricLines) {
      for (const forbidden of ['user_id=', 'plan_id=', 'job_id=', 'request_id=', 'destination=']) {
        expect(line, `指标行含禁用标签 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
