import type { PlannerFieldId } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { fieldState } from './field-state';
import { buildSummary, formatAnswer, shortQuestion } from './summary';
import { buildSnapshot } from './step-state';
import {
  INITIAL_PLANNER_STATE,
  hasValue,
  isAnswered,
  plannerReducer,
  type PlannerAnswerPatch,
  type PlannerState,
} from './state';

function answer(
  state: PlannerState,
  entries: readonly [PlannerFieldId, PlannerAnswerPatch][],
): PlannerState {
  return entries.reduce(
    (acc, [fieldId, patch]) => plannerReducer(acc, { type: 'answer', fieldId, patch }),
    state,
  );
}

const SKELETON: readonly [PlannerFieldId, PlannerAnswerPatch][] = [
  ['PV2-01-001', { trip: { origin: { text: '上海', country: '中国' } } }],
  ['PV2-01-002', { trip: { destination_status: 'CONFIRMED' } }],
  ['PV2-01-003', { trip: { destinations: [{ text: '杭州', country: '中国' }] } }],
  ['PV2-01-004', { trip: { dates: { start_date: '2026-09-01', end_date: '2026-09-04' } } }],
  ['PV2-02-001', { travelers: { count: 2 } }],
  [
    'PV2-02-002',
    {
      travelers: {
        profiles: [
          { relation: 'SELF', age_band: 'ADULT' },
          { relation: 'PARTNER', age_band: 'ADULT' },
        ],
      },
    },
  ],
];

describe('hasValue 的五种包装形状', () => {
  it('空多选是空，带「其他」文字的空多选不是空', () => {
    expect(hasValue({ values: [] })).toBe(false);
    expect(hasValue({ values: [], other_text: '纪念日' })).toBe(true);
    expect(hasValue({ values: ['LEISURE'] })).toBe(true);
  });

  it('关掉的开关不是空 —— 用户明确关掉了它', () => {
    expect(hasValue({ enabled: false })).toBe(true);
    expect(hasValue({ enabled: true, amount: 30_000 })).toBe(true);
  });

  it('自报型要递归进去看', () => {
    expect(hasValue({ user_reported: undefined })).toBe(false);
    expect(hasValue({ user_reported: 'HELD' })).toBe(true);
  });

  it('空数组、空串、全空对象都是空', () => {
    expect(hasValue([])).toBe(false);
    expect(hasValue('   ')).toBe(false);
    expect(hasValue({ a: undefined, b: [] })).toBe(false);
  });

  it('0 与 false 不是空', () => {
    expect(hasValue(0)).toBe(true);
    expect(hasValue(false)).toBe(true);
  });
});

describe('Field State（规范 5.1）', () => {
  it('明确选择“无”的空数组算已回答，且无需进入外部核验', () => {
    const state = answer(INITIAL_PLANNER_STATE, [
      ['PV2-07-002', { food: { dietary_requirements: { values: [] } } }],
      ['PV2-08-003', { special: { high_risk_activities: [] } }],
    ]);

    expect(isAnswered(state, 'PV2-07-002')).toBe(true);
    expect(isAnswered(state, 'PV2-08-003')).toBe(true);
    expect(fieldState(state, 'PV2-07-002')).toBe('answered');
    expect(fieldState(state, 'PV2-08-003')).toBe('answered');

    const snapshot = buildSnapshot(state);
    expect(snapshot.blockers).not.toContain('PV2-07-002');
    expect(snapshot.blockers).not.toContain('PV2-08-003');
  });

  it('旧草稿只有空数组但没有 touched 时仍是未回答', () => {
    const restored: PlannerState = {
      ...INITIAL_PLANNER_STATE,
      answers: { special: { high_risk_activities: [] } },
    };
    expect(isAnswered(restored, 'PV2-08-003')).toBe(false);
    expect(fieldState(restored, 'PV2-08-003')).toBe('unanswered');
  });

  it('未触发且无草稿是 hidden，未触发但有草稿是 inactive', () => {
    const base = answer(INITIAL_PLANNER_STATE, SKELETON);
    expect(fieldState(base, 'PV2-07-004')).toBe('hidden');

    /* 先声明过敏并填详情，再改回「没有」—— 草稿保留，字段转 inactive */
    const withDraft = answer(base, [
      ['PV2-07-003', { food: { has_allergies: 'YES' } }],
      [
        'PV2-07-004',
        {
          food: {
            allergy_details: {
              allergens: [
                { allergen: '花生', severity: 'SEVERE', avoid_cross_contamination: true },
              ],
            },
          },
        },
      ],
      ['PV2-07-003', { food: { has_allergies: 'NO' } }],
    ]);
    expect(fieldState(withDraft, 'PV2-07-004')).toBe('inactive');
  });

  it('校验失败优先于「有值」—— 订单卡缺地点时是 invalid 而不是 answered', () => {
    const state = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-01-008', { trip: { locked_order_types: ['LODGING'] } }],
      [
        'PV2-01-009',
        {
          trip: {
            locked_orders: [
              {
                type: 'LODGING',
                name: '某酒店',
                datetime_text: '9/1 入住',
                place_text: '',
                changeability: 'NON_REFUNDABLE',
              },
            ],
          },
        },
      ],
    ]);
    expect(fieldState(state, 'PV2-01-009')).toBe('invalid');
  });

  it('VERIFY 字段答完之后是 verify_pending 而不是 answered（规范 4.3）', () => {
    const state = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-01-003', { trip: { destinations: [{ text: '东京', country: '日本' }] } }],
      ['PV2-08-007', { documents: { visa_status: { user_reported: { status: 'HELD' } } } }],
    ]);
    expect(fieldState(state, 'PV2-08-007')).toBe('verify_pending');
  });

  it('普通字段答完是 answered', () => {
    const state = answer(INITIAL_PLANNER_STATE, SKELETON);
    expect(fieldState(state, 'PV2-01-001')).toBe('answered');
  });
});

describe('Step State（规范 5.2）', () => {
  it('没碰过的步骤是 untouched', () => {
    const snapshot = buildSnapshot(INITIAL_PLANNER_STATE);
    expect(snapshot.stepStates.get('04')).toBe('untouched');
  });

  it('第 1 步填完骨架后不再是 untouched', () => {
    const snapshot = buildSnapshot(answer(INITIAL_PLANNER_STATE, SKELETON));
    expect(snapshot.stepStates.get('01')).not.toBe('untouched');
  });

  it('存在 invalid 时是 needs-attention，且不要求用户碰过这一步', () => {
    /*
     * 跨境条件由第 1 步的目的地自动触发，用户可能从没打开过第 8 步 ——
     * 而那里已经有三个阻塞的证件问题。要求 touched 才报警会让红点永远不亮。
     */
    const international = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-01-003', { trip: { destinations: [{ text: '东京', country: '日本' }] } }],
    ]);
    const snapshot = buildSnapshot(international);
    expect(snapshot.blockers).toContain('PV2-08-006');
    expect(snapshot.stepStates.get('08')).not.toBe('complete');
  });

  it('上游回改能让已完成的步骤退回（规范 5.2 与 S10）', () => {
    const filled = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-06-002', { lodging: { rooms_count: 1 } }],
      [
        'PV2-06-003',
        { lodging: { room_configuration: [{ room_index: 1, bed_type: 'DOUBLE', capacity: 2 }] } },
      ],
    ]);
    expect(buildSnapshot(filled).stepStates.get('06')).not.toBe('needs-attention');

    /* 人数从 2 加到 4，房间只能容纳 2 人 → 第 6 步转 needs-attention */
    const moreTravelers = answer(filled, [['PV2-02-001', { travelers: { count: 4 } }]]);
    expect(buildSnapshot(moreTravelers).stepStates.get('06')).toBe('needs-attention');
  });
});

describe('Trip State 与三个指标（规范 5.3、17.1）', () => {
  it('什么都没填时是 draft，不是 blocked', () => {
    /* 一个刚打开页面的用户不该看到一份 11 项的问题清单 */
    expect(buildSnapshot(INITIAL_PLANNER_STATE).tripState).toBe('draft');
  });

  it('有输入但缺阻塞项时是 blocked', () => {
    const partial = answer(INITIAL_PLANNER_STATE, [SKELETON[0]!]);
    expect(buildSnapshot(partial).tripState).toBe('blocked');
  });

  it('缺授权时仍然是 blocked（规范 15：授权不预勾选）', () => {
    const noConsent = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-06-002', { lodging: { rooms_count: 1 } }],
      [
        'PV2-06-003',
        { lodging: { room_configuration: [{ room_index: 1, bed_type: 'DOUBLE', capacity: 2 }] } },
      ],
      ['PV2-07-002', { food: { dietary_requirements: { values: [] } } }],
      ['PV2-07-003', { food: { has_allergies: 'NO' } }],
      ['PV2-07-006', { interests: { tags: ['interest.food'] } }],
    ]);
    expect(buildSnapshot(noConsent).tripState).toBe('blocked');
  });

  it('三个指标各自独立 —— 完整度是百分比、可生成是枚举、待核验是计数', () => {
    const snapshot = buildSnapshot(answer(INITIAL_PLANNER_STATE, SKELETON));
    expect(snapshot.completeness).toBeGreaterThan(0);
    expect(snapshot.completeness).toBeLessThanOrEqual(100);
    expect(['draft', 'ready-for-plan', 'research-needed', 'blocked']).toContain(snapshot.tripState);
    expect(snapshot.verifyCount).toBe(0);
  });

  it('用户已回答后，系统待核验只计数，不阻碍生成流程', () => {
    const international = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-01-003', { trip: { destinations: [{ text: '东京', country: '日本' }] } }],
      ['PV2-06-002', { lodging: { rooms_count: 1 } }],
      [
        'PV2-06-003',
        { lodging: { room_configuration: [{ room_index: 1, bed_type: 'DOUBLE', capacity: 2 }] } },
      ],
      ['PV2-07-002', { food: { dietary_requirements: { values: [] } } }],
      ['PV2-07-003', { food: { has_allergies: 'NO' } }],
      ['PV2-08-001', { special: { has_health_or_accessibility_needs: 'NO' } }],
      ['PV2-08-003', { special: { high_risk_activities: [] } }],
      ['PV2-08-004', { special: { medication_status: { user_reported: 'NO' } } }],
      [
        'PV2-08-005',
        { documents: { nationality_residency: { nationality: '中国', residency: '中国' } } },
      ],
      [
        'PV2-08-006',
        {
          documents: {
            passport_status: {
              user_reported: { status: 'VALID', expiry_date: '2030-01-01' },
            },
          },
        },
      ],
      ['PV2-08-007', { documents: { visa_status: { user_reported: { status: 'MAYBE_EXEMPT' } } } }],
      ['PV2-08-008', { insurance: { status: { user_reported: 'WILL_BUY' } } }],
      [
        'PV2-09-001',
        { review: { constraints_snapshot: { acknowledged_groups: ['SKELETON', 'MUST'] } } },
      ],
      ['PV2-09-005', { privacy: { trip_processing_consent: true } }],
    ]);
    const snapshot = buildSnapshot(international);
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.verifyCount).toBeGreaterThan(0);
    expect(snapshot.stepStates.get('08')).not.toBe('needs-attention');
    expect(snapshot.tripState).toBe('research-needed');
  });

  it('未触发的字段不拉低完整度（规范 6）', () => {
    const domestic = buildSnapshot(answer(INITIAL_PLANNER_STATE, SKELETON));
    const international = buildSnapshot(
      answer(INITIAL_PLANNER_STATE, [
        ...SKELETON,
        ['PV2-01-003', { trip: { destinations: [{ text: '东京', country: '日本' }] } }],
      ]),
    );
    /* 跨境多触发了国籍/护照/签证等字段，因此同样的填写量下完整度更低 */
    expect(international.triggered.length).toBeGreaterThan(domestic.triggered.length);
    expect(international.completeness).toBeLessThan(domestic.completeness);
  });
});

describe('右侧画像五组（规范 17）', () => {
  it('分组顺序固定，且只收已触发且已回答的字段', () => {
    const state = answer(INITIAL_PLANNER_STATE, SKELETON);
    const sections = buildSummary(state, buildSnapshot(state));
    expect(sections.map((s) => s.group)).toEqual([
      'SKELETON',
      'MUST',
      'PREFER',
      'EXCLUDE',
      'VERIFY',
    ]);
    const skeleton = sections[0]!;
    expect(skeleton.chips.map((c) => c.fieldId)).toContain('PV2-01-001');
    /* 没填的目的地状态之外的字段不出现 */
    expect(skeleton.chips.map((c) => c.fieldId)).not.toContain('PV2-01-005');
  });

  it('高度敏感字段只显示抽象状态，不显示具体值', () => {
    const state = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-07-003', { food: { has_allergies: 'YES' } }],
      [
        'PV2-07-004',
        {
          food: {
            allergy_details: {
              allergens: [
                { allergen: '花生', severity: 'ANAPHYLAXIS', avoid_cross_contamination: true },
              ],
            },
          },
        },
      ],
    ]);
    const chips = buildSummary(state, buildSnapshot(state)).flatMap((s) => s.chips);
    const texts = chips.map((c) => c.text).join(' ');
    expect(texts).not.toContain('花生');
    expect(texts).toContain('过敏');
  });

  it('已有订单派生 LOCKED 而不是普通 HARD（规范 4 章的注）', () => {
    const state = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-01-008', { trip: { locked_order_types: ['LODGING'] } }],
      [
        'PV2-01-009',
        {
          trip: {
            locked_orders: [
              {
                type: 'LODGING',
                name: '某酒店',
                datetime_text: '9/1 入住',
                place_text: '西湖边',
                changeability: 'NON_REFUNDABLE',
              },
            ],
          },
        },
      ],
    ]);
    const chips = buildSummary(state, buildSnapshot(state)).flatMap((s) => s.chips);
    const locked = chips.filter((c) => c.kind === 'locked');
    expect(locked.length).toBeGreaterThan(0);
  });

  it('待核验统一归入“系统待核验”，不再标记阻塞等级', () => {
    const state = answer(INITIAL_PLANNER_STATE, [
      ...SKELETON,
      ['PV2-01-003', { trip: { destinations: [{ text: '东京', country: '日本' }] } }],
      ['PV2-08-008', { insurance: { status: { user_reported: 'WILL_BUY' } } }],
      ['PV2-08-007', { documents: { visa_status: { user_reported: { status: 'NOT_APPLIED' } } } }],
    ]);
    const verify = buildSummary(state, buildSnapshot(state)).find((s) => s.group === 'VERIFY');
    expect(verify?.title).toBe('系统待核验');
    expect(verify?.chips.every((chip) => chip.kind === 'verify')).toBe(true);
    expect(verify?.chips.map((chip) => chip.fieldId)).toEqual(
      expect.arrayContaining(['PV2-08-007', 'PV2-08-008']),
    );
  });

  it('每个 chip 都带回跳所需的来源字段与步骤（规范 17.2）', () => {
    const state = answer(INITIAL_PLANNER_STATE, SKELETON);
    for (const chip of buildSummary(state, buildSnapshot(state)).flatMap((s) => s.chips)) {
      expect(chip.fieldId).toMatch(/^PV2-\d{2}-\d{3}$/);
      expect(chip.step).toBe(chip.fieldId.slice(4, 6));
    }
  });
});

describe('答案渲染', () => {
  it('三态标签带出态 —— 「必须公共交通」与「不要公共交通」是两件事', () => {
    expect(formatAnswer({ code: 'transport.public_transit', stance: 'EXCLUDE' })).toContain('不要');
    expect(formatAnswer({ code: 'transport.public_transit', stance: 'REQUIRE' })).toContain('必须');
  });

  it('条件码转成中文而不是显示机器码', () => {
    expect(formatAnswer('interest.hot_spring')).toBe('温泉体验');
  });

  it('渲染不出来时返回 null，让调用方不产出空 chip', () => {
    expect(formatAnswer(undefined)).toBeNull();
    expect(formatAnswer([])).toBeNull();
    expect(formatAnswer({ values: [] })).toBeNull();
  });

  it('区间类值渲染成范围', () => {
    expect(formatAnswer({ min: 800, max: 1500 })).toBe('800～1500');
    expect(formatAnswer({ start: '09:00', end: '21:30' })).toBe('09:00–21:30');
    expect(formatAnswer({ start_date: '2026-09-01', end_date: '2026-09-04' })).toBe(
      '2026-09-01 至 2026-09-04',
    );
  });

  it('问句压成短标签', () => {
    expect(shortQuestion('是否有会影响旅行安排的健康、行动或无障碍需求？')).toBe(
      '会影响旅行安排的健康、行动或无障碍需求',
    );
    expect(shortQuestion('出发地/常住地')).toBe('出发地/常住地');
  });
});
