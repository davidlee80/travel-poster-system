import { TravelRequestUISchema, conditionDomain, type ConditionCode } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  INITIAL_FORM_STATE,
  buildTravelRequest,
  missingRequiredFields,
  type TravelRequestFormState,
} from './travel-request-form.js';

/**
 * 表单 → 请求体（TP-2-17）。
 *
 * 这些断言守的是**界面看不出来的字段**：`mode`（硬约束还是软约束）、
 * `flexibility_days`、`allow_multiple_destinations`。它们错了界面完全正常，
 * 而后果分别是「轮椅需求被当成偏好」「请求被 N-09/N-10 拒绝」。
 */

const options = { clientRequestId: 'web-test-1', timezone: 'Asia/Shanghai' };

function filled(overrides: Partial<TravelRequestFormState> = {}): TravelRequestFormState {
  return {
    ...INITIAL_FORM_STATE,
    origin: '上海',
    destination: '杭州',
    startDate: '2026-04-10',
    endDate: '2026-04-14',
    ...overrides,
  };
}

describe('请求体构造', () => {
  it('产物满足 TravelRequestUISchema', () => {
    expect(TravelRequestUISchema.safeParse(buildTravelRequest(filled(), options)).success).toBe(
      true,
    );
  });

  it('去除地名首尾空白', () => {
    // NonEmptyStringSchema 会 trim，但带空格的值会先通过 min(1) 再被 trim ——
    // 「   」这种全空白输入应当在这里就变成空串并被 schema 拒绝
    const request = buildTravelRequest(filled({ origin: '  上海  ' }), options);
    expect(request.trip.origin.text).toBe('上海');
  });

  it('V1 的两个固定值：不支持弹性日期与多目的地', () => {
    /*
     * 写成表单项会让用户能填出必然被 N-09 / N-10 拒绝的请求 ——
     * 而那两条错误的文案是「暂不支持」，用户会觉得系统坏了。
     */
    const request = buildTravelRequest(filled(), options);
    expect(request.trip.dates.flexibility_days).toBe(0);
    expect(request.trip.destination.allow_multiple_destinations).toBe(false);
    expect(request.trip.destination.mode).toBe('FIXED');
  });

  it('儿童按年龄数组展开，长者只记人数', () => {
    const request = buildTravelRequest(filled({ childAges: [7, 10], seniorCount: 2 }), options);
    expect(request.travelers.children).toEqual([{ age: 7 }, { age: 10 }]);
    // 年龄在生成里只用于「是否收紧步行上限」（V-14），只需要「有没有长者」
    expect(request.travelers.seniors).toEqual([{}, {}]);
  });

  it('无障碍与饮食条件发出 MUST，其余发 SHOULD', () => {
    /*
     * 5.1：`mode` 决定是硬约束还是软约束，而 V-30 只校验前者。
     * 勾了轮椅却发 SHOULD 的话，生成的计划可能根本无法使用，
     * 而界面上两者都只是一个勾。
     */
    const conditions: ConditionCode[] = [
      'accessibility.wheelchair',
      'diet.halal',
      'interest.history_culture',
      'transport.public_transit',
    ];
    const request = buildTravelRequest(filled({ conditions }), options);

    const modeByCode = Object.fromEntries(
      request.conditions.map((condition) => [condition.code, condition.mode]),
    );
    expect(modeByCode['accessibility.wheelchair']).toBe('MUST');
    expect(modeByCode['diet.halal']).toBe('MUST');
    expect(modeByCode['interest.history_culture']).toBe('SHOULD');
    expect(modeByCode['transport.public_transit']).toBe('SHOULD');
  });

  it('未勾选任何条件时 conditions 为空数组', () => {
    // undefined 会让 schema 拒绝整个请求
    expect(buildTravelRequest(filled(), options).conditions).toEqual([]);
  });

  it('每个域的默认 mode 与 MUST_BY_DEFAULT_DOMAINS 一致', () => {
    const request = buildTravelRequest(
      filled({
        conditions: [
          'interest.nature',
          'transport.self_drive',
          'accommodation.elevator',
          'accessibility.stroller',
          'diet.no_spicy',
          'schedule.no_late_night',
        ],
      }),
      options,
    );

    for (const condition of request.conditions) {
      const domain = conditionDomain(condition.code);
      const expected = domain === 'accessibility' || domain === 'diet' ? 'MUST' : 'SHOULD';
      expect(condition.mode, `${condition.code} 的 mode 不符`).toBe(expected);
    }
  });

  it('币种固定 CNY，included_items 非空', () => {
    // included_items 空数组会被 schema 拒绝（min(1)）
    const request = buildTravelRequest(filled(), options);
    expect(request.budget.currency).toBe('CNY');
    expect(request.budget.included_items.length).toBeGreaterThan(0);
  });

  it('client_request_id 与时区由调用方传入', () => {
    // 13.8：每次提交必须换新 client_request_id，否则会拿回旧结果 ——
    // 因此它不能是组件状态的一部分
    const request = buildTravelRequest(filled(), {
      clientRequestId: 'web-abc',
      timezone: 'Asia/Tokyo',
    });
    expect(request.client_request_id).toBe('web-abc');
    expect(request.timezone).toBe('Asia/Tokyo');
  });

  it('补充说明去空白后原样带上，不在前端截断', () => {
    /*
     * 5.1 的 500 字截断由标准化阶段做，并记入 assumptions（对用户可见）。
     * 前端悄悄截断会让「系统替你删了一半需求」这件事永远没人知道。
     */
    const long = '博'.repeat(800);
    expect(
      buildTravelRequest(filled({ customText: ` ${long} ` }), options).custom_requirements.raw_text,
    ).toHaveLength(800);
  });
});

describe('提交前的本地检查', () => {
  it('缺必填项时逐项列出', () => {
    expect(missingRequiredFields(INITIAL_FORM_STATE)).toEqual([
      '出发地',
      '目的地',
      '出发日期',
      '返回日期',
    ]);
  });

  it('填齐后无缺项', () => {
    expect(missingRequiredFields(filled())).toEqual([]);
  });

  it('全空白的地名算缺项', () => {
    expect(missingRequiredFields(filled({ destination: '   ' }))).toEqual(['目的地']);
  });

  it('不重复实现 N-01～N-12', () => {
    /*
     * 日期倒置、预算区间非法、天数超限都**不**在这里拦 —— 那是服务端的职责，
     * 且错误码与 `field` 都由它给出（13.7）。前端复制一份业务规则，
     * 两处必然逐渐分叉，而分叉的表现是「前端说没问题，后端说不行」。
     */
    const inverted = filled({ startDate: '2026-04-14', endDate: '2026-04-10' });
    expect(missingRequiredFields(inverted)).toEqual([]);

    const badBudget = filled({ budgetMin: 9_000, budgetMax: 100 });
    expect(missingRequiredFields(badBudget)).toEqual([]);
  });
});
