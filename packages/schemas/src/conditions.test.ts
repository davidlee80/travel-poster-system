import { describe, expect, it } from 'vitest';

import {
  CONDITION_CODES_BY_DOMAIN,
  CONDITION_CODE_COUNT,
  CONDITION_CODE_VALUES,
  CONDITION_DOMAIN_VALUES,
  TravelConditionSchema,
  conditionDomain,
  isKnownConditionCode,
} from './conditions.js';

describe('条件字典（5.1）', () => {
  it('冻结 24 项', () => {
    // 5.1 明确「V1 冻结以下 24 项」。数量变化必须是显式动作，
    // 因为新增 code 需要同时更新 LLM Prompt 模板
    expect(CONDITION_CODE_VALUES).toHaveLength(CONDITION_CODE_COUNT);
  });

  it('无重复 code', () => {
    expect(new Set(CONDITION_CODE_VALUES).size).toBe(CONDITION_CODE_VALUES.length);
  });

  it('每个 code 都是 <域>.<项> 两段式，且域在字典内', () => {
    for (const code of CONDITION_CODE_VALUES) {
      const parts = code.split('.');
      expect(parts, `${code} 不是两段式`).toHaveLength(2);
      expect(CONDITION_DOMAIN_VALUES, `${code} 的域未注册`).toContain(parts[0]);
      expect(parts[1]!.length).toBeGreaterThan(0);
    }
  });

  it('分域表与扁平清单一致', () => {
    /*
     * 分域表是派生的，本条断言它没在派生过程中丢或多。
     * 漂移的表现是「某个 code 通过了校验但没进 Prompt」——
     * 条件静默失效，没有任何报错。
     */
    const flatFromGroups = CONDITION_DOMAIN_VALUES.flatMap(
      (domain) => CONDITION_CODES_BY_DOMAIN[domain],
    );
    expect([...flatFromGroups].sort()).toEqual([...CONDITION_CODE_VALUES].sort());
  });

  it('每个域至少有一项', () => {
    // 空域说明域集合里有个多余条目，或某个域的 code 前缀写错了
    for (const domain of CONDITION_DOMAIN_VALUES) {
      expect(CONDITION_CODES_BY_DOMAIN[domain].length, `${domain} 为空`).toBeGreaterThan(0);
    }
  });

  it('5.1 表格的分域条目数逐行正确', () => {
    expect(
      Object.fromEntries(
        CONDITION_DOMAIN_VALUES.map((d) => [d, CONDITION_CODES_BY_DOMAIN[d].length]),
      ),
    ).toEqual({
      interest: 8,
      transport: 4,
      accommodation: 4,
      accessibility: 3,
      diet: 4,
      schedule: 1,
    });
  });

  it('conditionDomain 取出正确的域', () => {
    expect(conditionDomain('interest.history_culture')).toBe('interest');
    expect(conditionDomain('schedule.no_late_night')).toBe('schedule');
  });

  it('isKnownConditionCode 拒绝字典外的 code', () => {
    /*
     * 5.1：不在字典内时返回 REQ_CONDITION_CODE_UNKNOWN，**不做静默丢弃**。
     * 拼错的 accessibility.wheelchar 若被丢弃，轮椅需求凭空消失，
     * 而生成的计划看起来完全正常。
     */
    expect(isKnownConditionCode('accessibility.wheelchair')).toBe(true);
    expect(isKnownConditionCode('accessibility.wheelchar')).toBe(false);
    expect(isKnownConditionCode('interest.history_culture ')).toBe(false);
    expect(isKnownConditionCode('')).toBe(false);
  });
});

describe('TravelConditionSchema', () => {
  it('接受合法条件', () => {
    expect(
      TravelConditionSchema.safeParse({
        code: 'diet.halal',
        mode: 'MUST',
        value: true,
      }).success,
    ).toBe(true);
  });

  it('拒绝字典外的 code', () => {
    expect(
      TravelConditionSchema.safeParse({ code: 'diet.kosher', mode: 'MUST', value: true }).success,
    ).toBe(false);
  });

  it('value 必须是布尔', () => {
    // V1 六个域的 value 类型都是 boolean。用 unknown 兜住会把
    // 「值类型写错」推迟到运行期，而那时它已经进了 Prompt
    expect(
      TravelConditionSchema.safeParse({ code: 'diet.halal', mode: 'MUST', value: 'yes' }).success,
    ).toBe(false);
  });
});
