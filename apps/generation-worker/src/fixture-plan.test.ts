import { makeValidContext } from '@tps/planning';
import { TravelPlanLlmOutputSchema } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { fixturePlanFor } from './fixture-plan.js';

/**
 * `LLM_MODE=fake` 的录制输出（TP-2-10）。
 *
 * 这些断言的目的只有一个：**默认配置下的 Worker 能把任何合法请求跑通**。
 * 写死一份 5 天杭州计划的话，其余请求会因 V-01（天数不符）或
 * V-30（硬约束未满足）走到 REJECTED —— 而 fake 是默认模式。
 */

describe('按请求构造', () => {
  it('产物满足模型输出契约（不含任何 ID 与 schema_version）', () => {
    const output = fixturePlanFor(makeValidContext().normalized);
    const parsed = TravelPlanLlmOutputSchema.safeParse(output);

    expect(parsed.success).toBe(true);
    expect(output).not.toHaveProperty('plan_id');
    expect(output).not.toHaveProperty('schema_version');
    expect(output).not.toHaveProperty('status');
  });

  it.each([1, 5, 7, 14])('天数跟随请求（%i 天）', (days) => {
    const normalized = makeValidContext({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: {
          start_date: '2026-04-10',
          end_date: `2026-04-${String(9 + days).padStart(2, '0')}`,
          flexibility_days: 0,
        },
      },
    }).normalized;

    expect(normalized.total_days).toBe(days);
    expect(fixturePlanFor(normalized).days).toHaveLength(days);
  });

  it('目的地与城市跟随请求', () => {
    const normalized = makeValidContext({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '苏州',
          place_id: 'cn-suzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      },
    }).normalized;

    const output = fixturePlanFor(normalized);
    expect(output.destination).toEqual({ name: '苏州', place_id: 'cn-suzhou' });
    expect(output.days.every((day) => day.city === '苏州')).toBe(true);
  });

  it('硬约束逐条写进 satisfied（否则 V-30 必然 REJECTED）', () => {
    const normalized = makeValidContext({
      conditions: [
        { code: 'accessibility.wheelchair', mode: 'MUST', value: true },
        { code: 'diet.halal', mode: 'MUST', value: true },
        { code: 'interest.nature', mode: 'SHOULD', value: true },
      ],
    }).normalized;

    const codes = fixturePlanFor(normalized).constraint_report.satisfied.map((e) => e.code);
    expect(codes).toEqual(['accessibility.wheelchair', 'diet.halal']);
  });

  it('日期锚定请求的出发日期（否则 V-03 每天都报违规）', () => {
    const normalized = makeValidContext().normalized;
    const output = fixturePlanFor(normalized);

    expect(output.days[0]!.date).toBe(normalized.start_date);
    expect(output.start_date).toBe(normalized.start_date);
  });

  it('明说是示例数据，不假装真实推荐', () => {
    /*
     * 约束报告与标题都会展示给用户。fake 模式产出的 POI 是固定的几个杭州地点
     * —— 目的地写「北京」时里面仍然是拱宸桥。不标注的话，
     * 本地演示的截图会被当成真实效果。
     */
    const output = fixturePlanFor(makeValidContext().normalized);
    expect(output.title).toContain('示例数据');
    expect(output.constraint_report.assumptions.map((a) => a.code)).toContain('FIXTURE_PLAN');
    for (const entry of output.constraint_report.satisfied) {
      expect(entry.evidence).toContain('示例数据');
    }
  });

  it('人数与币种跟随请求', () => {
    // V-21 按 traveler_count 折算总额；不跟随会让预算校验基于错误的人数
    const normalized = makeValidContext({
      travelers: { adults: 4, children: [], seniors: [] },
    }).normalized;

    const output = fixturePlanFor(normalized);
    expect(output.traveler_count).toBe(4);
    expect(output.currency).toBe('CNY');
  });
});
