import { PLANNER_FIELDS, plannerField, type PlannerFieldId } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { isPlannerFieldGenerationRequired } from './generation-requirement';
import {
  ALWAYS_VISIBLE_DESPITE_TRIGGER,
  CONDITIONAL_FIELD_IDS,
  TRIGGER_REASON,
  buildTriggerContext,
  isTriggered,
  triggeredFields,
  unresolvedBlockers,
} from './triggers';
import {
  INITIAL_PLANNER_STATE,
  plannerReducer,
  type PlannerAnswerPatch,
  type PlannerState,
} from './state';

/** 连续写入若干答案，返回最终状态。测试里用它拼场景 */
function answer(
  state: PlannerState,
  entries: readonly [PlannerFieldId, PlannerAnswerPatch][],
): PlannerState {
  return entries.reduce(
    (acc, [fieldId, patch]) => plannerReducer(acc, { type: 'answer', fieldId, patch }),
    state,
  );
}

const DOMESTIC_TWO_ADULTS = answer(INITIAL_PLANNER_STATE, [
  ['PV2-01-001', { trip: { origin: { text: '上海', city: '上海', country: '中国' } } }],
  ['PV2-01-002', { trip: { destination_status: 'CONFIRMED' } }],
  ['PV2-01-003', { trip: { destinations: [{ text: '杭州', city: '杭州', country: '中国' }] } }],
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
]);

describe('触发表的完整性', () => {
  it('生成必填完全由 required + blocking 配置决定，而不是由 HARD 类型决定', () => {
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-01-001'))).toBe(true);
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-02-004'))).toBe(true);
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-03-001'))).toBe(true);
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-06-001'))).toBe(false);
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-01-005'))).toBe(false);
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-09-002'))).toBe(false);
    expect(isPlannerFieldGenerationRequired(plannerField('PV2-10-001'))).toBe(false);
  });

  it('场景必填读取自己的触发条件，而不是复用页面显隐', () => {
    const money = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-03-001', { budget: { mode: 'TOTAL' } }],
    ]);
    expect(unresolvedBlockers(money)).toContain('PV2-03-002');
    expect(unresolvedBlockers(money)).toContain('PV2-03-003');
    expect(unresolvedBlockers(money)).toContain('PV2-03-006');

    const unknown = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-03-001', { budget: { mode: 'UNKNOWN' } }],
    ]);
    expect(unresolvedBlockers(unknown)).not.toContain('PV2-03-002');
    expect(unresolvedBlockers(unknown)).not.toContain('PV2-03-004');

    const customRooms = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-06-002', { lodging: { rooms_count: 2 } }],
    ]);
    expect(unresolvedBlockers(customRooms)).toContain('PV2-06-003');
  });

  it('高风险活动要求回答保险状态，但已回答后的系统核验不阻止生成', () => {
    const highRisk = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-08-003', { special: { high_risk_activities: ['SCUBA_DIVING'] } }],
    ]);
    expect(unresolvedBlockers(highRisk)).toContain('PV2-08-008');

    const answered = answer(highRisk, [
      ['PV2-08-008', { insurance: { status: { user_reported: 'UNSURE' } } }],
    ]);
    expect(unresolvedBlockers(answered)).not.toContain('PV2-08-008');
  });

  it('元数据里 trigger 不是「始终显示」的字段，都被显式处理过', () => {
    /*
     * 这条断言是触发表「只写有条件的那些」这个设计的唯一保护。
     * 键打错时那个字段会静默变成恒显示 —— 而恒显示的条件字段意味着
     * 国内游用户被问护照有效期，或者过敏详情在没有过敏时就展开。
     */
    const handled = new Set(CONDITIONAL_FIELD_IDS);
    const unhandled = PLANNER_FIELDS.filter(
      (spec) =>
        spec.trigger !== '始终显示' &&
        spec.level !== 'POST_PLAN' &&
        !ALWAYS_VISIBLE_DESPITE_TRIGGER.includes(spec.field_id) &&
        !handled.has(spec.field_id),
    ).map((spec) => `${spec.field_id} ${spec.api_key}（${spec.trigger}）`);
    expect(unhandled).toEqual([]);
  });

  it('触发表里没有多余条目 —— 多出来的条目会把一个恒显示字段悄悄藏起来', () => {
    const extra = CONDITIONAL_FIELD_IDS.filter(
      (fieldId) => plannerField(fieldId).trigger === '始终显示',
    );
    expect(extra).toEqual([]);
  });

  it('白名单里的六个字段确实恒显示，且都在元数据里有非「始终显示」的 trigger', () => {
    for (const fieldId of ALWAYS_VISIBLE_DESPITE_TRIGGER) {
      expect(isTriggered(INITIAL_PLANNER_STATE, fieldId), `${fieldId} 应恒显示`).toBe(true);
      expect(plannerField(fieldId).trigger, `${fieldId} 不需要进白名单`).not.toBe('始终显示');
    }
  });

  it('第 10 步的字段在主问卷里永不显示', () => {
    for (const spec of PLANNER_FIELDS.filter((f) => f.level === 'POST_PLAN')) {
      expect(isTriggered(DOMESTIC_TWO_ADULTS, spec.field_id), `${spec.field_id}`).toBe(false);
    }
    expect(triggeredFields(DOMESTIC_TWO_ADULTS).some((id) => id.startsWith('PV2-10'))).toBe(false);
  });

  it('每个会原位展开的二级追问都有一句「为什么问你这个」（规范 6）', () => {
    /*
     * 范围是「在触发表里 **且** 层级是条件触发」，两个条件都必要：
     *
     *   - 只看层级会把 `PV2-06-008` 算进来 —— 它层级是条件触发但恒显示
     *     （见白名单），一个恒显示的区块不需要解释自己为什么出现；
     *   - 只看触发表会把预算模式那一组算进来（`PV2-03-002/003/004/005`）——
     *     它们是主流程字段，切换模式换的是**输入形式**而不是追加一个新问题。
     *     规范 6 的原文是「二级/三级追问首次出现时」，模式切换不属于它。
     */
    const missing = CONDITIONAL_FIELD_IDS.filter(
      (fieldId) =>
        plannerField(fieldId).level === 'CONDITIONAL' && TRIGGER_REASON[fieldId] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('没有指向恒显示字段的解释文案 —— 那句话永远不会被显示', () => {
    const handled = new Set(CONDITIONAL_FIELD_IDS);
    const dead = Object.keys(TRIGGER_REASON).filter(
      (fieldId) => !handled.has(fieldId as PlannerFieldId),
    );
    expect(dead).toEqual([]);
  });
});

describe('S1 普通国内双人（规范 24）', () => {
  it('不出现跨境、儿童、自驾、过敏分支', () => {
    const shown = new Set(triggeredFields(DOMESTIC_TWO_ADULTS));
    /* 跨境三件套 */
    expect(shown.has('PV2-08-005')).toBe(false);
    expect(shown.has('PV2-08-006')).toBe(false);
    expect(shown.has('PV2-08-007')).toBe(false);
    /* 儿童 */
    expect(shown.has('PV2-02-003')).toBe(false);
    expect(shown.has('PV2-02-005')).toBe(false);
    /* 自驾 */
    expect(shown.has('PV2-05-006')).toBe(false);
    /* 过敏详情 */
    expect(shown.has('PV2-07-004')).toBe(false);
    /* 三人以上才问的分组需求 */
    expect(shown.has('PV2-02-006')).toBe(false);
  });

  it('旅行者档案在人数 > 0 时出现', () => {
    expect(isTriggered(DOMESTIC_TWO_ADULTS, 'PV2-02-002')).toBe(true);
  });
});

describe('旧草稿里的目的地未定值', () => {
  const undecided = answer(INITIAL_PLANNER_STATE, [
    ['PV2-01-002', { trip: { destination_status: 'UNDECIDED' } }],
  ]);

  it('不能绕过目的地必填：具体目的地仍显示并阻塞', () => {
    expect(isTriggered(undecided, 'PV2-01-003')).toBe(true);
    expect(unresolvedBlockers(undecided)).toContain('PV2-01-003');
  });

  it('不锁住其余步骤，用户可以继续编辑后再回来补目的地', () => {
    expect(isTriggered(undecided, 'PV2-03-001')).toBe(true);
    expect(isTriggered(undecided, 'PV2-04-001')).toBe(true);
  });
});

describe('S3 带儿童家庭（D-01 同行人链）', () => {
  const family = answer(DOMESTIC_TWO_ADULTS, [
    ['PV2-02-001', { travelers: { count: 3 } }],
    [
      'PV2-02-002',
      {
        travelers: {
          profiles: [
            { relation: 'SELF', age_band: 'ADULT' },
            { relation: 'PARTNER', age_band: 'ADULT' },
            { relation: 'CHILD', age_band: 'CHILD', age: 6 },
          ],
        },
      },
    ],
  ]);

  it('监护人、儿童需求、分组需求同时出现', () => {
    expect(isTriggered(family, 'PV2-02-003')).toBe(true);
    expect(isTriggered(family, 'PV2-02-005')).toBe(true);
    expect(isTriggered(family, 'PV2-02-006')).toBe(true);
  });

  it('儿童需求含固定午睡后，第 4 步的午休窗口才出现', () => {
    expect(isTriggered(family, 'PV2-04-006')).toBe(false);
    const withNap = answer(family, [
      ['PV2-02-005', { travelers: { child_needs: { values: ['FIXED_NAP'] } } }],
    ]);
    expect(isTriggered(withNap, 'PV2-04-006')).toBe(true);
  });

  it('用户主动开启也能展开午休窗口', () => {
    const optedIn = plannerReducer(family, { type: 'toggleOptIn', fieldId: 'PV2-04-006' });
    expect(isTriggered(optedIn, 'PV2-04-006')).toBe(true);
  });

  it('少年（TEEN）算未成年人但不算儿童', () => {
    const teen = answer(DOMESTIC_TWO_ADULTS, [
      [
        'PV2-02-002',
        { travelers: { profiles: [{ relation: 'CHILD', age_band: 'TEEN', age: 15 }] } },
      ],
    ]);
    const ctx = buildTriggerContext(teen.answers);
    expect(ctx.hasMinor).toBe(true);
    expect(ctx.hasChild).toBe(false);
    expect(isTriggered(teen, 'PV2-02-003')).toBe(true);
    expect(isTriggered(teen, 'PV2-02-005')).toBe(false);
  });
});

describe('S4 国际旅行（D-02 跨境链）', () => {
  const international = answer(DOMESTIC_TWO_ADULTS, [
    ['PV2-01-003', { trip: { destinations: [{ text: '东京', city: '东京', country: '日本' }] } }],
  ]);

  it('国籍、护照、签证三件套出现', () => {
    expect(isTriggered(international, 'PV2-08-005')).toBe(true);
    expect(isTriggered(international, 'PV2-08-006')).toBe(true);
    expect(isTriggered(international, 'PV2-08-007')).toBe(true);
  });

  it('跨境同时意味着涉及航空 —— 航班约束与舱等出现', () => {
    expect(isTriggered(international, 'PV2-05-002')).toBe(true);
    expect(isTriggered(international, 'PV2-05-003')).toBe(true);
  });

  it('用户明确排除飞机时，跨境不再强行认定涉及航空（4.1 的优先级）', () => {
    const noFlight = answer(international, [
      [
        'PV2-05-001',
        { transport: { intercity_modes: [{ code: 'transport.flight', stance: 'EXCLUDE' }] } },
      ],
    ]);
    expect(buildTriggerContext(noFlight.answers).involvesAir).toBe(false);
    expect(isTriggered(noFlight, 'PV2-05-002')).toBe(false);
  });

  it('国家未知时不触发跨境 —— 误触发会让国内游用户被问护照', () => {
    const unknownCountry = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-01-003', { trip: { destinations: [{ text: '某地' }] } }],
    ]);
    expect(buildTriggerContext(unknownCountry.answers).isInternational).toBe(false);
    expect(isTriggered(unknownCountry, 'PV2-08-006')).toBe(false);
  });

  it('跨境或健康需求都能触发用药问题', () => {
    expect(isTriggered(international, 'PV2-08-004')).toBe(true);
    const health = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-08-001', { special: { has_health_or_accessibility_needs: 'YES' } }],
    ]);
    expect(isTriggered(health, 'PV2-08-004')).toBe(true);
  });
});

describe('S5 自驾（D-03 自驾链）', () => {
  it('跨城或当地任一处选自驾都展开自驾详情', () => {
    const intercity = answer(DOMESTIC_TWO_ADULTS, [
      [
        'PV2-05-001',
        { transport: { intercity_modes: [{ code: 'transport.self_drive', stance: 'REQUIRE' }] } },
      ],
    ]);
    expect(isTriggered(intercity, 'PV2-05-006')).toBe(true);

    const local = answer(DOMESTIC_TWO_ADULTS, [
      [
        'PV2-05-005',
        { transport: { local_modes: [{ code: 'transport.self_drive', stance: 'PREFER' }] } },
      ],
    ]);
    expect(isTriggered(local, 'PV2-05-006')).toBe(true);
  });

  it('把自驾标成「不要」不展开自驾详情', () => {
    const excluded = answer(DOMESTIC_TWO_ADULTS, [
      [
        'PV2-05-001',
        { transport: { intercity_modes: [{ code: 'transport.self_drive', stance: 'EXCLUDE' }] } },
      ],
    ]);
    expect(isTriggered(excluded, 'PV2-05-006')).toBe(false);
  });
});

describe('S6 严重过敏（D-04 过敏链）', () => {
  it('过敏=有才展开详情；「不确定」不展开', () => {
    const yes = answer(DOMESTIC_TWO_ADULTS, [['PV2-07-003', { food: { has_allergies: 'YES' } }]]);
    expect(isTriggered(yes, 'PV2-07-004')).toBe(true);

    const unsure = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-07-003', { food: { has_allergies: 'UNSURE' } }],
    ]);
    expect(isTriggered(unsure, 'PV2-07-004')).toBe(false);
  });
});

describe('D-07 预算链', () => {
  it('模式决定显示金额还是档次', () => {
    const total = answer(DOMESTIC_TWO_ADULTS, [['PV2-03-001', { budget: { mode: 'TOTAL' } }]]);
    expect(isTriggered(total, 'PV2-03-003')).toBe(true);
    expect(isTriggered(total, 'PV2-03-004')).toBe(false);

    const tier = answer(DOMESTIC_TWO_ADULTS, [['PV2-03-001', { budget: { mode: 'TIER' } }]]);
    expect(isTriggered(tier, 'PV2-03-003')).toBe(false);
    expect(isTriggered(tier, 'PV2-03-004')).toBe(true);
  });

  it('「暂无明确预算」时不问币种与硬上限，但要问档次', () => {
    const unknown = answer(DOMESTIC_TWO_ADULTS, [['PV2-03-001', { budget: { mode: 'UNKNOWN' } }]]);
    expect(isTriggered(unknown, 'PV2-03-002')).toBe(false);
    expect(isTriggered(unknown, 'PV2-03-005')).toBe(false);
    expect(isTriggered(unknown, 'PV2-03-004')).toBe(true);
  });

  it('切换模式不清值（规范 9）', () => {
    const filled = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-03-001', { budget: { mode: 'TOTAL' } }],
      ['PV2-03-003', { budget: { target_range: { min: 20_000, max: 30_000 } } }],
      ['PV2-03-001', { budget: { mode: 'TIER' } }],
    ]);
    expect(filled.answers.budget?.target_range?.min).toBe(20_000);
  });

  it('住宿每晚预算只在预算可细分时出现', () => {
    const tier = answer(DOMESTIC_TWO_ADULTS, [['PV2-03-001', { budget: { mode: 'TIER' } }]]);
    expect(isTriggered(tier, 'PV2-06-004')).toBe(false);
    const perPerson = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-03-001', { budget: { mode: 'PER_PERSON' } }],
    ]);
    expect(isTriggered(perPerson, 'PV2-06-004')).toBe(true);
  });
});

describe('D-08 兴趣链', () => {
  it('已选兴趣不足 3 项时不要求排序', () => {
    const two = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-07-006', { interests: { tags: ['interest.food', 'interest.nature'] } }],
    ]);
    expect(isTriggered(two, 'PV2-07-007')).toBe(false);

    const three = answer(two, [
      [
        'PV2-07-006',
        { interests: { tags: ['interest.food', 'interest.nature', 'interest.cafe'] } },
      ],
    ]);
    expect(isTriggered(three, 'PV2-07-007')).toBe(true);
  });

  it('兴趣含购物时展开购物计划', () => {
    const shopping = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-07-006', { interests: { tags: ['interest.shopping'] } }],
    ]);
    expect(isTriggered(shopping, 'PV2-07-010')).toBe(true);
  });
});

describe('D-06 订单链与阻塞项', () => {
  it('选了订单类型才展开订单卡，且它成为阻塞项', () => {
    const locked = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-01-008', { trip: { locked_order_types: ['LODGING'] } }],
    ]);
    expect(isTriggered(locked, 'PV2-01-009')).toBe(true);
    expect(unresolvedBlockers(locked)).toContain('PV2-01-009');
  });

  it('没选订单类型时订单卡不显示也不阻塞', () => {
    expect(unresolvedBlockers(DOMESTIC_TWO_ADULTS)).not.toContain('PV2-01-009');
  });

  it('未触发的条件 blocker 不计入缺失（规范 6）', () => {
    const blockers = unresolvedBlockers(DOMESTIC_TWO_ADULTS);
    expect(blockers).not.toContain('PV2-08-006');
    expect(blockers).not.toContain('PV2-05-006');
    expect(blockers).not.toContain('PV2-07-004');
  });

  it('未填写的可选硬约束不阻塞生成', () => {
    const blockers = unresolvedBlockers(DOMESTIC_TWO_ADULTS);
    expect(blockers).not.toContain('PV2-03-005');
    expect(blockers).not.toContain('PV2-07-008');
  });

  it('可选字段即使有校验提示也不阻塞，但配置为生成必填的无效字段会阻塞', () => {
    const invalidOptional = answer(DOMESTIC_TWO_ADULTS, [
      ['PV2-03-001', { budget: { mode: 'TOTAL' } }],
      ['PV2-03-005', { budget: { hard_cap: { enabled: true } } }],
    ]);
    expect(unresolvedBlockers(invalidOptional)).toContain('PV2-03-005');

    const invalidRequired = answer(DOMESTIC_TWO_ADULTS, [
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
    expect(unresolvedBlockers(invalidRequired)).toContain('PV2-01-009');
  });

  it('阻塞清单不含 PV2-09-002 —— 它的触发条件就是这份清单，会无限递归', () => {
    expect(unresolvedBlockers(INITIAL_PLANNER_STATE)).not.toContain('PV2-09-002');
  });

  it('存在未完成阻塞项时第 9 步的补答列表才出现', () => {
    expect(isTriggered(INITIAL_PLANNER_STATE, 'PV2-09-002')).toBe(true);
    /* 空状态下 PV2-01-001 等必填项就是阻塞项，因此列表出现 */
    expect(unresolvedBlockers(INITIAL_PLANNER_STATE).length).toBeGreaterThan(0);
  });
});

describe('S10 上游回改后依赖失效', () => {
  it('删掉唯一的儿童后，儿童需求与监护人问题一起消失', () => {
    const family = answer(DOMESTIC_TWO_ADULTS, [
      [
        'PV2-02-002',
        { travelers: { profiles: [{ relation: 'CHILD', age_band: 'CHILD', age: 6 }] } },
      ],
      ['PV2-02-005', { travelers: { child_needs: { values: ['CAR_SEAT'] } } }],
    ]);
    expect(isTriggered(family, 'PV2-02-005')).toBe(true);

    const removed = answer(family, [
      ['PV2-02-002', { travelers: { profiles: [{ relation: 'SELF', age_band: 'ADULT' }] } }],
    ]);
    expect(isTriggered(removed, 'PV2-02-005')).toBe(false);
    expect(isTriggered(removed, 'PV2-02-003')).toBe(false);
    /* 草稿仍在 —— 规范 6 的「值保留」，重新加回儿童时能恢复 */
    expect(removed.answers.travelers?.child_needs?.values).toEqual(['CAR_SEAT']);
  });
});
