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
  it('清单长度与冻结常量一致', () => {
    /*
     * 5.1 原为「V1 冻结 24 项」，P8 扩到 46（R-55）。数量变化必须是显式动作
     * —— 改清单而忘了改常量（或反之）会让这条断言先红。
     *
     * 5.1 的冻结条款还要求「新增域必须同时更新 Prompt 模板」。P8 核实过
     * 那一条对本仓库不适用：`describeConditions` 是对 code 的泛型遍历，
     * 分域靠前缀而非写死的段落。见 conditions.ts 上 CONDITION_DOMAIN_VALUES
     * 的注释。
     */
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

  it('分域条目数逐行正确（5.1 + P8 的 R-55）', () => {
    /*
     * 逐域断言而不只断言总数：把一个 code 从 interest 挪到 transport 时
     * 总数不变，而 Prompt 的分域注入与素材检索的按域取偏好都会跟着变。
     *
     * 括号里是 P8 新增数（合计 +22，见 R-55）。
     */
    expect(
      Object.fromEntries(
        CONDITION_DOMAIN_VALUES.map((d) => [d, CONDITION_CODES_BY_DOMAIN[d].length]),
      ),
    ).toEqual({
      interest: 14, // 8 + 6
      transport: 6, // 4 + 2
      accommodation: 13, // 4 + 9
      budget: 3, // P8 新增域
      accessibility: 4, // 3 + 1
      diet: 4,
      schedule: 2, // 1 + 1
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

// ── P8：条件字典扩容（R-55）─────────────────────────────────

describe('P8：条件字典扩容（R-55）', () => {
  it('冻结数量为 46', () => {
    expect(CONDITION_CODE_VALUES).toHaveLength(CONDITION_CODE_COUNT);
    expect(CONDITION_CODE_COUNT).toBe(46);
  });

  it('新增 budget 域，且七个域都非空', () => {
    /*
     * 空域会让 Prompt 的分域注入产出一个空段落 —— 模型看到一个只有标题
     * 没有内容的小节，而那比不写这一段更容易被误解。
     */
    expect(CONDITION_DOMAIN_VALUES).toContain('budget');
    for (const domain of CONDITION_DOMAIN_VALUES) {
      expect(
        CONDITION_CODES_BY_DOMAIN[domain].length,
        `域 ${domain} 没有任何 code`,
      ).toBeGreaterThan(0);
    }
  });

  it('P8 新增的 code 采用正向命名，否定语义走 value:false', () => {
    /*
     * 反向命名的 code 与 `value: false` 组合会产生双重否定
     * （「不要（不要多人间）」），而 5.1 的 value 是 boolean ——
     * 读代码的人无法判断它是「要多人间」还是「不要不要多人间」。
     *
     * 白名单里的四个是 P8 之前就存在的。它们已写入历史 plan_json 的
     * constraint_report.satisfied，改名会让存量计划的条件比对静默错位，
     * 因此列入例外而不是修掉。
     */
    const LEGACY_NEGATIVE = [
      'transport.avoid_transfer',
      'accessibility.low_walking',
      'schedule.no_late_night',
      'diet.no_spicy',
    ];
    const negative = CONDITION_CODE_VALUES.filter(
      (code) => /\.(no|not|avoid|without|low)_/.test(code) && !LEGACY_NEGATIVE.includes(code),
    );
    expect(negative, '新增 code 不应含否定前缀').toEqual([]);
  });

  it('原型的 22 个新标签全部有 code', () => {
    const expected = [
      'interest.city_walk',
      'interest.cafe',
      'interest.hot_spring',
      'interest.theme_park',
      'interest.zoo_aquarium',
      'interest.light_hiking',
      'transport.cycling',
      'transport.rail',
      'accommodation.hotel',
      'accommodation.homestay',
      'accommodation.apartment',
      'accommodation.resort',
      'accommodation.hostel',
      'accommodation.breakfast',
      'accommodation.kitchen',
      'accommodation.shared_dorm',
      'accommodation.single_base',
      'budget.lodging_quality',
      'budget.unique_experience',
      'budget.transport_convenience',
      'schedule.daily_rest',
      'accessibility.child_car_seat',
    ] as const;

    expect(expected, '第二轮决策定的是 22 个新码').toHaveLength(22);
    for (const code of expected) {
      expect(isKnownConditionCode(code), `${code} 不在字典内`).toBe(true);
    }
    // 24 个既有 + 22 个新增
    expect(CONDITION_CODE_COUNT).toBe(24 + expected.length);
  });

  it('刻意不建的两个 code 确实不在字典里', () => {
    /*
     * 「混合交通」表达「没有约束」，V-30 要求每条 MUST 都出现在 satisfied
     * 里，而没有任何行程结构能「满足混合交通」。
     * 「不要多人间」的否定语义走 accommodation.shared_dorm + value:false。
     */
    expect(isKnownConditionCode('transport.mixed')).toBe(false);
    expect(isKnownConditionCode('accommodation.no_shared_dorm')).toBe(false);
  });
});
