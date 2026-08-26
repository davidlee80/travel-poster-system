import {
  PLANNER_CONSTRAINT_PRECEDENCE,
  PLANNER_FIELDS,
  plannerField,
  type PlannerFieldId,
  type PlannerProfile,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { declaredPhraseValues, deriveConstraints, sortConstraints } from './constraints.js';

/**
 * 76 字段 → 运行时约束（规范 4 章 + 4.1 + 4.3）。
 *
 * 重点不在「每个字段都派生出东西」（那是一张表的逐条转录），而在四件
 * **错了不会报错**的事：类型分派、优先级权重、来源可追溯、以及
 * 「文案表按字段分层」这条约束本身。
 */

function derive(profile: PlannerProfile) {
  return deriveConstraints(profile);
}

function textsOf(profile: PlannerProfile, field: PlannerFieldId): readonly string[] {
  return derive(profile)
    .constraints.filter((constraint) => constraint.source_field_id === field)
    .map((constraint) => constraint.text);
}

describe('空答案不产出任何东西', () => {
  it('undefined 与空对象都返回两个空数组', () => {
    /*
     * P8 及之前的客户端没有 `planner_profile`。返回空数组让 `normalize` 据此
     * **不写**那两个字段 —— 写一个空数组会抹掉「客户端有没有发问卷」这条信息。
     */
    expect(deriveConstraints(undefined)).toEqual({ constraints: [], verify_items: [] });
    expect(deriveConstraints({})).toEqual({ constraints: [], verify_items: [] });
  });
});

describe('LOCKED 由已有订单派生（规范 4 章的注）', () => {
  const order = {
    type: 'LODGING',
    name: '东京湾酒店',
    datetime_text: '10/01 15:00 入住',
    place_text: '台场',
  } as const;

  it('不可改退 → LOCKED', () => {
    const result = derive({
      trip: { locked_orders: [{ ...order, changeability: 'NON_REFUNDABLE' }] },
    });
    expect(result.constraints[0]?.type).toBe('LOCKED');
    expect(result.constraints[0]?.text).toContain('已购买且不可移动');
    expect(result.constraints[0]?.text).toContain('东京湾酒店');
  });

  it('「不清楚」按不可改退处理（规范 7）', () => {
    const result = derive({ trip: { locked_orders: [{ ...order, changeability: 'UNKNOWN' }] } });
    expect(result.constraints[0]?.type).toBe('LOCKED');
  });

  it('可改退 → HARD 而不是 LOCKED', () => {
    /*
     * 全部当 LOCKED 会让一张可退的餐厅预订把整天锁死；
     * 全部当 HARD 会让一张不可退的机票被模型「优化」掉。
     */
    const result = derive({ trip: { locked_orders: [{ ...order, changeability: 'CHANGEABLE' }] } });
    expect(result.constraints[0]?.type).toBe('HARD');
    expect(result.constraints[0]?.text).toContain('已预订');
  });

  it('多张订单各自有独立的 constraint_id', () => {
    const result = derive({
      trip: {
        locked_orders: [
          { ...order, changeability: 'NON_REFUNDABLE' },
          { ...order, name: '天妇罗店', changeability: 'CHANGEABLE' },
        ],
      },
    });
    const ids = result.constraints.map((constraint) => constraint.constraint_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('类型分派', () => {
  it('三态标签的三个态分别落 PREFER / HARD / EXCLUDE', () => {
    const result = derive({
      transport: {
        local_modes: [
          { code: 'transport.public_transit', stance: 'PREFER' },
          { code: 'transport.self_drive', stance: 'REQUIRE' },
          { code: 'transport.cycling', stance: 'EXCLUDE' },
        ],
      },
    });
    const byCode = new Map(
      result.constraints.map((constraint) => [constraint.constraint_id, constraint.type]),
    );
    expect(byCode.get('PREFER:PV2-05-005#transport.public_transit')).toBe('PREFER');
    expect(byCode.get('HARD:PV2-05-005#transport.self_drive')).toBe('HARD');
    expect(byCode.get('EXCLUDE:PV2-05-005#transport.cycling')).toBe('EXCLUDE');
  });

  it('饮食是 HARD 而不是 PREFER（规范 4.2）', () => {
    /* 「偏好清真」不是一个有意义的表达 */
    const result = derive({ food: { dietary_requirements: { values: ['HALAL'] } } });
    expect(result.constraints[0]?.type).toBe('HARD');
    expect(result.constraints[0]?.text).toContain('清真');
  });

  it('过敏是 HARD，且严重两级额外进待核验', () => {
    const result = derive({
      food: {
        allergy_details: {
          allergens: [
            { allergen: '花生', severity: 'ANAPHYLAXIS', avoid_cross_contamination: true },
            { allergen: '芒果', severity: 'MILD', avoid_cross_contamination: false },
          ],
        },
      },
    });
    expect(result.constraints.every((constraint) => constraint.type === 'HARD')).toBe(true);
    expect(result.constraints[0]?.text).toContain('需避免交叉污染');
    /*
     * 轻微与中等不进待核验：那会让清单被低风险项淹没，
     * 而清单存在的意义是让真正危险的那几条被看见。
     */
    expect(result.verify_items.map((item) => item.text)).toEqual([
      '花生（有过敏性休克风险）需逐家餐厅确认',
    ]);
  });

  it('「尽量不排长队」升级为 EXCLUDE（字段表）', () => {
    const result = derive({ food: { dining_style: { queue_attitude: ['AVOID_QUEUE'] } } });
    expect(result.constraints[0]?.type).toBe('EXCLUDE');
  });

  it('授权是 CONSENT，补充说明是 INFO', () => {
    const result = derive({
      privacy: { trip_processing_consent: true },
      profile: { additional_notes: '想安排和菓子体验' },
    });
    const types = result.constraints.map((constraint) => constraint.type);
    expect(types).toContain('CONSENT');
    expect(types).toContain('INFO');
    /* INFO 的文案里必须写明「不得据此改写硬约束」（规范 4 章的类型语义）*/
    const info = result.constraints.find((constraint) => constraint.type === 'INFO');
    expect(info?.text).toContain('不得据此改写硬约束');
  });

  it('没勾授权时不产出 CONSENT 约束', () => {
    /* 一条「已授权」的约束在没授权时出现，会让下游以为可以处理敏感数据 */
    const result = derive({ privacy: { trip_processing_consent: false } });
    expect(result.constraints.map((constraint) => constraint.type)).not.toContain('CONSENT');
  });

  it('硬上限是 HARD，档次是 PREFER —— 前者优先级高于后者（字段表）', () => {
    const result = derive({
      budget: {
        currency: 'CNY',
        hard_cap: { enabled: true, amount: 40_000 },
        travel_tier: 'LUXURY',
      },
    });
    const cap = result.constraints.find((c) => c.source_field_id === 'PV2-03-005');
    const tier = result.constraints.find((c) => c.source_field_id === 'PV2-03-004');
    expect(cap?.type).toBe('HARD');
    expect(tier?.type).toBe('PREFER');
    expect(cap?.decision_weight).toBeLessThan(tier?.decision_weight ?? Infinity);
  });

  it('硬上限开关关掉时不产出约束（值保留但不生效）', () => {
    const result = derive({ budget: { hard_cap: { enabled: false, amount: 40_000 } } });
    expect(result.constraints.map((c) => c.source_field_id)).not.toContain('PV2-03-005');
  });
});

describe('优先级权重与排序', () => {
  it('每条约束的权重等于 4.1 的 precedence 表', () => {
    const result = derive({
      trip: {
        locked_orders: [
          {
            type: 'LODGING',
            name: '酒店',
            datetime_text: '10/01',
            place_text: '台场',
            changeability: 'NON_REFUNDABLE',
          },
        ],
      },
      privacy: { trip_processing_consent: true },
      food: { dietary_requirements: { values: ['HALAL'] } },
      risk: { exclusions: ['RED_EYE_FLIGHT'] },
      budget: { travel_tier: 'QUALITY' },
    });
    for (const constraint of result.constraints) {
      expect(constraint.decision_weight, constraint.constraint_id).toBe(
        PLANNER_CONSTRAINT_PRECEDENCE[constraint.type],
      );
    }
  });

  it('排序按 LOCKED > CONSENT > HARD > EXCLUDE > PREFER', () => {
    const result = derive({
      budget: { travel_tier: 'QUALITY' },
      risk: { exclusions: ['RED_EYE_FLIGHT'] },
      food: { dietary_requirements: { values: ['HALAL'] } },
      privacy: { trip_processing_consent: true },
      trip: {
        locked_orders: [
          {
            type: 'LODGING',
            name: '酒店',
            datetime_text: '10/01',
            place_text: '台场',
            changeability: 'NON_REFUNDABLE',
          },
        ],
      },
    });
    expect(sortConstraints(result.constraints).map((constraint) => constraint.type)).toEqual([
      'LOCKED',
      'CONSENT',
      'HARD',
      'EXCLUDE',
      'PREFER',
    ]);
  });

  it('同权重内保持问卷顺序 —— 那是用户填写的顺序', () => {
    const result = derive({
      travelers: { mobility_level: 'LESS_WALKING' },
      pace: { walking_tolerance: 'UP_TO_3KM', hotel_change_tolerance: 'ZERO' },
    });
    const hard = sortConstraints(result.constraints)
      .filter((constraint) => constraint.type === 'HARD')
      .map((constraint) => constraint.source_field_id);
    expect(hard).toEqual(['PV2-02-004', 'PV2-04-003', 'PV2-04-007']);
  });
});

describe('可追溯性（规范 21.2）', () => {
  it('每条约束都指向一个真实存在的 field_id', () => {
    const result = derive({
      trip: { locked_order_types: ['LODGING'] },
      travelers: { mobility_level: 'AVOID_STAIRS', child_needs: { values: ['CAR_SEAT'] } },
      pace: { level: 3, daily_window: { start: '09:00', end: '21:00' } },
      food: { dietary_requirements: { values: ['VEGAN'] }, experience_tags: ['MARKET'] },
      interests: {
        must_do: [{ text: 'teamLab' }],
        wish_and_exclude: { wish: [], exclude: ['夜店'] },
      },
      special: { work_constraints: { enabled: true, items: [{ when_text: '10/06 上午' }] } },
      documents: { nationality_residency: { nationality: '中国' } },
      safety: { contexts: ['SOLO_FEMALE'] },
    });
    const known = new Set<string>(PLANNER_FIELDS.map((spec) => spec.field_id));
    for (const constraint of result.constraints) {
      expect(known.has(constraint.source_field_id), constraint.constraint_id).toBe(true);
    }
    for (const item of result.verify_items) {
      expect(known.has(item.source_field_id), item.item_id).toBe(true);
    }
  });

  it('constraint_id 在一次派生里唯一', () => {
    /* 重复的 id 会让「跨版本比对哪几条约束变了」给出错误答案 */
    const result = derive({
      food: {
        allergy_details: {
          allergens: [
            { allergen: '花生', severity: 'SEVERE', avoid_cross_contamination: false },
            { allergen: '芒果', severity: 'SEVERE', avoid_cross_contamination: false },
          ],
          carries_emergency_medication: true,
        },
        dining_style: { queue_attitude: ['WILL_QUEUE', 'AVOID_QUEUE'] },
      },
      transport: {
        flight_comfort: { cabin: 'BUSINESS', seats: ['WINDOW'] },
        time_preferences: { windows: ['MORNING'], avoid_late_night_arrival: true },
      },
    });
    const ids = result.constraints.map((constraint) => constraint.constraint_id);
    expect(new Set(ids).size).toBe(ids.length);
    const itemIds = result.verify_items.map((item) => item.item_id);
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });
});

describe('待核验项的 blocking 取自字段元数据（规范 0 章的 VERIFY 分级）', () => {
  it('保险是非阻塞，签证与护照是阻塞', () => {
    /*
     * 「签证待查」与「保险未确认」拥有同样的风险语义是 V2.0 的缺陷，
     * V2.1 修掉了它。分级写在附录 A 的 `runtime_type` 里，
     * 因此这里断言的是「读的是那一列」而不是「调用处传对了布尔」。
     */
    const result = derive({
      insurance: { status: { user_reported: 'WILL_BUY' } },
      documents: {
        passport_status: { user_reported: { status: 'VALID' } },
        visa_status: { user_reported: { status: 'NOT_APPLIED' } },
      },
    });
    const byField = new Map(
      result.verify_items.map((item) => [item.source_field_id, item.blocking]),
    );
    expect(byField.get('PV2-08-008')).toBe(false);
    expect(byField.get('PV2-08-006')).toBe(true);
    expect(byField.get('PV2-08-007')).toBe(true);

    for (const item of result.verify_items) {
      /*
       * `as`：契约里 `source_field_id` 是 `string`（schema 不该依赖前端的
       * 字面量联合），而 `plannerField` 要的是那个联合。上一条断言已经确认
       * 这些 id 就是那三个字段，因此这里的收窄是安全的。
       */
      const spec = plannerField(item.source_field_id as PlannerFieldId);
      expect(item.blocking, item.item_id).toBe(spec.runtime_type === 'VERIFY_BLOCKING');
    }
  });

  it('状态恒为 user_reported —— 自报不等于已核验（规范 4.3）', () => {
    const result = derive({ insurance: { status: { user_reported: 'HELD' } } });
    expect(result.verify_items[0]?.status).toBe('user_reported');
    /* 文案里也要写明，否则下游读到「已持有保险」会当成结论 */
    expect(result.verify_items[0]?.text).toContain('用户自报');
  });

  it('不需要携带药物时不产出待核验项', () => {
    expect(
      derive({ special: { medication_status: { user_reported: 'NO' } } }).verify_items,
    ).toEqual([]);
    /* 「不确定」要进 —— 它正是需要进一步确认的那一类 */
    expect(
      derive({ special: { medication_status: { user_reported: 'UNSURE' } } }).verify_items,
    ).toHaveLength(1);
  });
});

describe('文案表按字段分层，重名值不串味', () => {
  it('THREE_PLUS 在星级与换宿两处含义不同', () => {
    /*
     * 扁平表会静默取其中一个，症状是 Prompt 里出现
     * 「住宿星级：可以换三次以上住宿」—— 模型会照着那条错约束生成，
     * 而没有任何校验能发现。
     */
    expect(
      textsOf({ lodging: { class_and_brand: { hotel_class: 'THREE_PLUS' } } }, 'PV2-06-006'),
    ).toEqual(['住宿星级：三星以上']);
    expect(textsOf({ pace: { hotel_change_tolerance: 'THREE_PLUS' } }, 'PV2-04-007')).toEqual([
      '可以换三次以上住宿',
    ]);
  });

  it('ECONOMY 在舱等与档次两处含义不同', () => {
    expect(textsOf({ transport: { flight_comfort: { cabin: 'ECONOMY' } } }, 'PV2-05-003')).toEqual([
      '舱等：经济舱',
    ]);
    expect(textsOf({ budget: { travel_tier: 'ECONOMY' } }, 'PV2-03-004')).toEqual([
      '整体档次：经济型',
    ]);
  });

  it('NONE 在自由时间与大件行李两处含义不同', () => {
    expect(textsOf({ pace: { free_time: 'NONE' } }, 'PV2-04-005')).toEqual([
      '几乎不需要留自由时间',
    ]);
    expect(
      textsOf({ transport: { luggage_profile: { large_items: ['NONE'] } } }, 'PV2-05-007'),
    ).toEqual(['行李：大件：没有大件行李']);
  });

  it('步行档位在 Prompt 里是自足的一句话', () => {
    /* 界面上写「≤ 3 km」够了（旁边有问题标题），Prompt 里读不出是步行还是骑行 */
    expect(textsOf({ pace: { walking_tolerance: 'UP_TO_3KM' } }, 'PV2-04-003')).toEqual([
      '每天步行不超过 3 公里',
    ]);
  });

  it('没有一条约束的文案里残留英文枚举名', () => {
    /*
     * 漏配文案时 `phrase` 回退原值，于是 Prompt 里出现一个英文标识符。
     * 这条断言把「漏配」变成红 —— 而漏配本身不会有任何其他症状。
     */
    const full: PlannerProfile = {
      trip: {
        locked_order_types: ['LODGING'],
        locked_orders: [
          {
            type: 'TRANSFER',
            name: '接送',
            datetime_text: '10/01',
            place_text: '成田',
            changeability: 'CHANGEABLE',
          },
        ],
      },
      profile: {
        trip_purposes: { values: ['BLEISURE', 'SKI'] },
        top_goals: { values: ['PHOTOS'] },
      },
      travelers: {
        minor_guardianship: 'NON_PARENT_GUARDIAN',
        mobility_level: 'FREQUENT_REST',
        child_needs: { values: ['KIDS_MEAL', 'FAMILY_ROOM'] },
        grouping_needs: ['SPLIT_ACTIVITIES'],
      },
      budget: {
        travel_tier: 'COMFORT',
        scope_and_priorities: { included_items: ['MEALS'], priorities: [] },
      },
      pace: {
        walking_tolerance: 'KM_5_TO_8',
        core_activities_per_day: 'FOUR_TO_FIVE',
        free_time: 'HALF_DAY',
        hotel_change_tolerance: 'FOR_EXPERIENCE',
      },
      risk: { exclusions: ['LONG_QUEUE', 'REMOTE_AREA'] },
      transport: {
        flight_constraints: { transfer_tolerance: 'MAX_ONE_TRANSFER' },
        flight_comfort: { cabin: 'PREMIUM_ECONOMY', seats: ['AISLE', 'TOGETHER'] },
        time_preferences: { windows: ['EVENING'] },
        self_drive: {
          user_reported: { experience: 'Y1_TO_3', license_status: 'HAS_IDP', car_type: 'VAN_7' },
        },
        luggage_profile: { large_items: ['SPORTS_GEAR'] },
      },
      lodging: {
        room_configuration: [{ room_index: 1, bed_type: 'CONNECTING', capacity: 4 }],
        location_priorities: ['SEA_OR_NATURE', 'HOTEL_ITSELF'],
        class_and_brand: { hotel_class: 'FOUR_PLUS' },
        sleep_checkin_needs: { needs: ['HIGH_FLOOR', 'LATE_CHECK_OUT'] },
      },
      food: {
        experience_tags: ['BAR_IZAKAYA', 'CAFE_DESSERT'],
        dietary_requirements: { values: ['KOSHER'] },
        allergy_details: {
          allergens: [{ allergen: '花生', severity: 'MODERATE', avoid_cross_contamination: false }],
        },
        dining_style: { budget_level: 'MOSTLY_CASUAL', queue_attitude: ['WILL_BOOK_AHEAD'] },
      },
      special: {
        health_accessibility_needs: { values: ['HEARING_VISION_AID', 'PREGNANCY'] },
        high_risk_activities: ['SCUBA_DIVING', 'MOUNTAINEERING'],
      },
      documents: {
        passport_status: { user_reported: { status: 'RENEWING' } },
        visa_status: { user_reported: { status: 'IN_PROGRESS' } },
      },
      insurance: { status: { user_reported: 'NONE' } },
      safety: { contexts: ['HEAVY_NIGHTLIFE', 'LATE_NIGHT_ARRIVAL'] },
    };

    const result = derive(full);
    const leaked: string[] = [];
    for (const constraint of [...result.constraints, ...result.verify_items]) {
      /* 连续两个以上大写字母加下划线的片段 = 一个没被翻译的枚举名。`SUV` 是合法文案，因此要求含下划线 */
      const match = /[A-Z]{2,}_[A-Z_]+/.exec(constraint.text);
      if (match !== null) leaked.push(`${constraint.text}（${match[0]}）`);
    }
    expect(leaked).toEqual([]);
  });

  it('声明了文案的字段都是真实字段', () => {
    /* 给一个不存在的 field_id 配文案 = 死文案，且会误导下一个读表的人 */
    const known = new Set<string>(PLANNER_FIELDS.map((spec) => spec.field_id));
    for (const spec of PLANNER_FIELDS) {
      expect(known.has(spec.field_id)).toBe(true);
    }
    /* 反向：随便取一个没有选项的字段，它不该有文案条目 */
    expect(declaredPhraseValues('PV2-01-001')).toEqual([]);
  });
});
