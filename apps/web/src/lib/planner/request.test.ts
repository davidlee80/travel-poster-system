import { MUST_BY_DEFAULT_DOMAINS } from '@tps/presentation';
import {
  CURRENCY_VALUES,
  TEMPLATE_ID_VALUES,
  TRAVEL_TIER_VALUES,
  TravelRequestUISchema,
  conditionDomain,
  type PlannerProfileInput,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  buildPlannerRequest,
  prepareProfile,
  projectBudget,
  projectConditions,
  projectPace,
  projectTravelers,
  TIER_PER_PERSON_PER_DAY,
} from './request';
import { INITIAL_PLANNER_STATE, type PlannerState } from './state';

const OPTIONS = {
  clientRequestId: 'test-request-1',
  timezone: 'Asia/Shanghai',
  today: '2026-08-24',
  now: '2026-08-24T10:00:00.000Z',
} as const;

function stateWith(answers: PlannerProfileInput): PlannerState {
  return { ...INITIAL_PLANNER_STATE, answers };
}

/** 一份填得足够完整、能通过契约的九步答案 */
const COMPLETE: PlannerProfileInput = {
  trip: {
    origin: { text: '上海', country: '中国' },
    destination_status: 'CONFIRMED',
    destinations: [
      { text: '东京', country: '日本' },
      { text: '京都', country: '日本' },
    ],
    dates: { start_date: '2026-10-01', end_date: '2026-10-07' },
    date_flexibility: 'PLUS_MINUS_3',
    locked_order_types: ['LODGING', 'RESTAURANT'],
    locked_orders: [
      {
        type: 'LODGING',
        name: '东京湾酒店',
        datetime_text: '10/01 15:00 入住',
        place_text: '台场',
        changeability: 'NON_REFUNDABLE',
      },
    ],
  },
  profile: {
    trip_purposes: { values: ['LEISURE', 'FOOD'] },
    top_goals: { values: ['EAT_WELL', 'LESS_HASSLE'] },
    additional_notes: '想安排一次和菓子体验。',
  },
  travelers: {
    count: 3,
    profiles: [
      { relation: 'SELF', age_band: 'ADULT' },
      { relation: 'PARTNER', age_band: 'ADULT' },
      { relation: 'CHILD', age_band: 'CHILD', age: 6 },
    ],
    mobility_level: 'LESS_WALKING',
    child_needs: { values: ['STROLLER_ACCESS', 'FIXED_NAP'] },
  },
  budget: {
    mode: 'TOTAL',
    currency: 'CNY',
    target_range: { min: 30_000, max: 45_000 },
    travel_tier: 'QUALITY',
    scope_and_priorities: {
      included_items: ['ACCOMMODATION', 'MEALS'],
      priorities: [{ code: 'budget.lodging_quality', stance: 'REQUIRE' }],
    },
  },
  pace: {
    level: 2,
    daily_window: { start: '09:00', end: '21:00' },
    walking_tolerance: 'KM_8_TO_12',
    core_activities_per_day: 'TWO_TO_THREE',
    rest_window: { enabled: true, window: { start: '13:00', end: '14:30' } },
    hotel_change_tolerance: 'ONE',
  },
  risk: { exclusions: ['MULTI_TRANSFER'] },
  transport: {
    intercity_modes: [{ code: 'transport.flight', stance: 'PREFER' }],
    flight_constraints: { transfer_tolerance: 'DIRECT_ONLY' },
    local_modes: [{ code: 'transport.public_transit', stance: 'PREFER' }],
    time_preferences: { avoid_late_night_arrival: true },
  },
  lodging: {
    types: [{ code: 'accommodation.hotel', stance: 'REQUIRE' }],
    rooms_count: 2,
    room_configuration: [
      { room_index: 1, bed_type: 'DOUBLE', capacity: 2 },
      { room_index: 2, bed_type: 'TWIN', capacity: 2 },
    ],
    location_priorities: ['TRANSIT_CONVENIENT', 'QUIET'],
    amenities: [{ code: 'accommodation.breakfast', stance: 'PREFER' }],
  },
  food: {
    experience_tags: ['LOCAL_SPECIALTY'],
    dietary_requirements: { values: ['NO_SPICY'] },
    has_allergies: 'NO',
  },
  interests: {
    tags: ['interest.food', 'interest.city_walk', 'interest.hot_spring'],
    top3: ['interest.food'],
  },
  special: { has_health_or_accessibility_needs: 'NO', high_risk_activities: [] },
  documents: {
    nationality_residency: { nationality: '中国', residency: '中国' },
    passport_status: { user_reported: { status: 'VALID', expiry_date: '2030-01-01' } },
    visa_status: { user_reported: { status: 'MAYBE_EXEMPT' } },
  },
  insurance: { status: { user_reported: 'WILL_BUY' } },
  review: { constraints_snapshot: { acknowledged_groups: ['SKELETON', 'MUST'] } },
  service: { notification_preferences: { mode: 'DAILY_MORNING', channels: ['IN_APP'] } },
  privacy: { trip_processing_consent: true, save_preferences: false },
};

describe('产出的请求体能通过契约', () => {
  it('完整答案解析成功', () => {
    const body = buildPlannerRequest(stateWith(COMPLETE), OPTIONS);
    const result = TravelRequestUISchema.safeParse(body);
    /*
     * 把 issue 一起打出来：`success: false` 这一条信息定位不到任何字段，
     * 而这个测试的全部价值就在于「哪个字段拼错了」。
     */
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('空答案也能解析 —— 一份什么都没填的草稿不该被 schema 拒', () => {
    /*
     * 「能不能生成」由 tripState 判定（规范 5.3、18），而 schema 只做结构校验。
     * 空答案在这里被拒的话，错误码是 `REQ_SCHEMA_INVALID` ——
     * 一个定位不到任何表单项的码，而用户看到的是「请求格式不正确」。
     *
     * 例外是三个必填的机器填充字段（时区、幂等键、版本），它们由本函数补齐；
     * 出发地与目的地为空串会被 `NonEmptyStringSchema` 拒，这是**对的** ——
     * 界面上那个按钮此刻的状态是 `draft`，压根不会走到提交。
     */
    const body = buildPlannerRequest(INITIAL_PLANNER_STATE, OPTIONS);
    expect(body.trip.origin.text).toBe('');
    expect(body.budget.min).toBeGreaterThan(0);
  });

  it('目的地两处一致（陷阱 3）', () => {
    const body = buildPlannerRequest(stateWith(COMPLETE), OPTIONS);
    expect(body.trip.destination.text).toBe('东京');
    expect(body.planner_profile?.trip?.destinations?.[0]?.text).toBe('东京');
    expect(body.trip.destination.allow_multiple_destinations).toBe(true);
  });

  it('单目的地时不置 allow_multiple_destinations', () => {
    const body = buildPlannerRequest(
      stateWith({ ...COMPLETE, trip: { ...COMPLETE.trip, destinations: [{ text: '东京' }] } }),
      OPTIONS,
    );
    expect(body.trip.destination.allow_multiple_destinations).toBe(false);
  });

  it('逐字记录与投影都在 —— 缺任一个都会让一半链路失效', () => {
    const body = buildPlannerRequest(stateWith(COMPLETE), OPTIONS);
    expect(body.planner_profile).toBeDefined();
    expect(body.conditions?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('输出样式套件（R-85 P3）', () => {
  it('没选时整个 output_preferences 键不出现', () => {
    /*
     * **不是 `{}` 也不是 `{ template_id: null }`。**
     *
     * 契约那边是 `template_id: TemplateIdSchema.default(TEMPLATE_ID_VALUES[0])`
     * 加整块 `.prefault({})`，因此键缺失时后端自动补默认套件；
     * 而传 `null` 会被 `z.enum` 拒成 REQ_SCHEMA_INVALID —— 那个错误用户
     * 看不懂，且只在「没选样式」时出现，而那是最常见的情形。
     *
     * 用 `toBeUndefined` 而不是 `toEqual({})`：后者对两种错法（发了空对象、
     * 发了 null）都会红得不够精确。
     */
    const body = buildPlannerRequest(stateWith(COMPLETE), OPTIONS);
    expect(body.output_preferences).toBeUndefined();
    expect(Object.keys(body)).not.toContain('output_preferences');
  });

  it('选了套件时发出它，且不碰其他字段', () => {
    const picked = 'blueprint_v1';
    const body = buildPlannerRequest(
      { ...stateWith(COMPLETE), templateId: picked },
      OPTIONS,
    );

    expect(body.output_preferences?.template_id).toBe(picked);
    /* 模板不属于旅行画像 —— 它不得渗进 `planner_profile` */
    expect(JSON.stringify(body.planner_profile)).not.toContain(picked);
  });

  it('选默认那一套也显式发出 —— 与「没选」不同', () => {
    /*
     * 两者今天等价，但默认套件将来会换 —— 那时「我当初没选」应该跟着换，
     * 而「我当初选了水墨纸本」不应该。因此这两种状态必须在载荷上可区分。
     */
    const body = buildPlannerRequest(
      { ...stateWith(COMPLETE), templateId: TEMPLATE_ID_VALUES[0] },
      OPTIONS,
    );
    expect(body.output_preferences?.template_id).toBe(TEMPLATE_ID_VALUES[0]);
  });
});

describe('提交前的清洗与盖章', () => {
  it('剔掉空占位行', () => {
    const answers = prepareProfile(
      {
        trip: { destinations: [{ text: '东京' }, { text: '  ' }] },
        interests: {
          must_do: [{ text: 'teamLab' }, { text: '' }],
          wish_and_exclude: { wish: ['', '奈良'], exclude: [] },
        },
        lodging: { class_and_brand: { brands: ['万豪', ' '] } },
        special: { work_constraints: { enabled: true, items: [{ when_text: '' }] } },
        pretrip: { loyalty_programs: [{ kind: 'AIRLINE', brand: '' }] },
      },
      OPTIONS.today,
      OPTIONS.now,
    );
    expect(answers.trip?.destinations).toHaveLength(1);
    expect(answers.interests?.must_do).toHaveLength(1);
    expect(answers.interests?.wish_and_exclude?.wish).toEqual(['奈良']);
    expect(answers.lodging?.class_and_brand?.brands).toEqual(['万豪']);
    expect(answers.special?.work_constraints?.items).toEqual([]);
    expect(answers.pretrip?.loyalty_programs).toEqual([]);
  });

  it('给已填的自报字段盖日期，不给空的盖', () => {
    const answers = prepareProfile(
      {
        documents: { passport_status: { user_reported: { status: 'VALID' } } },
        insurance: {},
      },
      OPTIONS.today,
      OPTIONS.now,
    );
    expect(answers.documents?.passport_status?.reported_on).toBe(OPTIONS.today);
    /*
     * 空的不盖：一个只有 `reported_on` 的对象会被 schema 拒（`user_reported`
     * 必填），也会让 `hasValue` 把它算成「已回答」—— 于是完成度虚高，
     * 而那个字段的控件仍然是空的。
     */
    expect(answers.insurance?.status).toBeUndefined();
  });

  it('已有的自报日期不被覆盖 —— 那是「什么时候自报的」而不是「什么时候提交的」', () => {
    const answers = prepareProfile(
      { insurance: { status: { user_reported: 'HELD', reported_on: '2026-01-01' } } },
      OPTIONS.today,
      OPTIONS.now,
    );
    expect(answers.insurance?.status?.reported_on).toBe('2026-01-01');
  });

  it('复核面板的确认时间在提交时盖上', () => {
    const answers = prepareProfile(
      { review: { constraints_snapshot: { acknowledged_groups: ['MUST'] } } },
      OPTIONS.today,
      OPTIONS.now,
    );
    expect(answers.review?.constraints_snapshot?.acknowledged_at).toBe(OPTIONS.now);
  });

  it('没有复核记录时不凭空造一个', () => {
    const answers = prepareProfile({}, OPTIONS.today, OPTIONS.now);
    expect(answers.review).toBeUndefined();
  });
});

describe('同行人投影', () => {
  it('按年龄段分成 adults / children / seniors', () => {
    const result = projectTravelers({
      travelers: {
        count: 4,
        profiles: [
          { relation: 'SELF', age_band: 'ADULT' },
          { relation: 'CHILD', age_band: 'INFANT' },
          { relation: 'CHILD', age_band: 'TEEN', age: 16 },
          { relation: 'PARENT', age_band: 'SENIOR', age: 70 },
        ],
      },
    });
    expect(result.adults).toBe(1);
    expect(result.children).toEqual([{ age: 1 }, { age: 16 }]);
    expect(result.seniors).toEqual([{ age: 70 }]);
  });

  it('没填具体年龄时用档位代表值', () => {
    const result = projectTravelers({
      travelers: { count: 1, profiles: [{ relation: 'CHILD', age_band: 'CHILD' }] },
    });
    /* P8 的 `TravelerChildSchema.age` 是必填的，留空会让整个请求被拒 */
    expect(result.children).toEqual([{ age: 8 }]);
  });

  it('卡片比人数少时按人数补足成人', () => {
    /*
     * 规范 8 允许用户改了人数还没填完卡片就往下走。按 1 张卡片算一个 4 人行程
     * 会让预算差四倍，而界面上看不出任何异常。
     */
    const result = projectTravelers({
      travelers: { count: 4, profiles: [{ relation: 'SELF', age_band: 'ADULT' }] },
    });
    expect(result.adults).toBe(4);
  });

  it('一张卡片都没有时全按成人算', () => {
    expect(projectTravelers({ travelers: { count: 2 } })).toEqual({
      adults: 2,
      children: [],
      seniors: [],
    });
  });

  it('什么都没填时至少一位成人 —— 0 会被 N-xx 拒', () => {
    expect(projectTravelers({}).adults).toBe(1);
  });
});

describe('预算投影', () => {
  it('总预算原样发，basis 为 TOTAL', () => {
    const result = projectBudget(
      { budget: { mode: 'TOTAL', currency: 'CNY', target_range: { min: 30_000, max: 45_000 } } },
      3,
    );
    expect(result).toMatchObject({ basis: 'TOTAL', min: 30_000, max: 45_000, currency: 'CNY' });
  });

  it('人均总预算乘人数折成总额，而不是当成「人均每天」', () => {
    /*
     * 当成「人均每天」的话，一个 8000 元人均总预算的 7 天 3 人行程会变成
     * 8000 × 3 × 7 = 168000 —— 二十倍的偏差，而请求本身完全合法。
     */
    const result = projectBudget(
      { budget: { mode: 'PER_PERSON', target_range: { min: 8_000, max: 12_000 } } },
      3,
    );
    expect(result).toMatchObject({ basis: 'TOTAL', min: 24_000, max: 36_000 });
  });

  it('只知道档次时按档位表估算每人每天', () => {
    const result = projectBudget({ budget: { mode: 'TIER', travel_tier: 'QUALITY' } }, 2);
    expect(result.basis).toBe('PER_PERSON_PER_DAY');
    expect(result.min).toBe(1_200);
    expect(result.tier).toBe('QUALITY');
  });

  it('暂无概念且未选档次时按舒适型估算', () => {
    const result = projectBudget({ budget: { mode: 'UNKNOWN' } }, 2);
    expect([result.min, result.max]).toEqual([600, 1_200]);
    /* 没选档次就不发 tier —— 「没选」与「选了舒适」不是一回事 */
    expect(result.tier).toBeUndefined();
  });

  it('V2 的舒适型映射到 P8 的 STANDARD', () => {
    /* P8 的 `STANDARD` 是「舒适」的旧译名。映射错会让选点取向整体偏移一档 */
    expect(projectBudget({ budget: { mode: 'TIER', travel_tier: 'COMFORT' } }, 1).tier).toBe(
      'STANDARD',
    );
  });

  it('档位表覆盖 6 个币种 × 4 个档位', () => {
    /*
     * 缺一格的表现是那个组合下 min/max 落到回退值，而回退值是 0 ——
     * N-12 会以「每人每天 0 元」拒掉请求，而用户只是选了日元 + 奢华型。
     */
    for (const currency of CURRENCY_VALUES) {
      for (const tier of TRAVEL_TIER_VALUES) {
        const range = TIER_PER_PERSON_PER_DAY[currency][tier];
        expect(range, `${currency} ${tier}`).toBeDefined();
        expect(range?.[0]).toBeGreaterThan(0);
        expect(range?.[1]).toBeGreaterThan(range?.[0] ?? 0);
      }
    }
  });

  it('档位区间随档次单调递增', () => {
    /* 反着写会让「奢华型」比「经济型」便宜，而没有任何东西会报错 */
    for (const currency of CURRENCY_VALUES) {
      const table = TIER_PER_PERSON_PER_DAY[currency];
      const mins = TRAVEL_TIER_VALUES.map((tier) => table[tier]?.[0] ?? 0);
      expect(mins, currency).toEqual([...mins].sort((a, b) => a - b));
    }
  });
});

describe('节奏投影', () => {
  it('五档压成三档，同时原样发 intensity', () => {
    /* 5.1 规定「数值字段与 level 冲突时以数值为准」，因此下游拿到的是未压缩的 */
    expect(projectPace({ pace: { level: 1 } })).toMatchObject({ level: 'RELAXED', intensity: 1 });
    expect(projectPace({ pace: { level: 3 } })).toMatchObject({ level: 'BALANCED', intensity: 3 });
    expect(projectPace({ pace: { level: 5 } })).toMatchObject({ level: 'PACKED', intensity: 5 });
  });

  it('步行上限取「愿意走」与「能走」的较小值', () => {
    /* 字段表：不与行动能力冲突；若冲突取更保守值 */
    const result = projectPace({
      pace: { walking_tolerance: 'KM_8_TO_12' },
      travelers: { mobility_level: 'LESS_WALKING' },
    });
    expect(result.walking_limit_km).toBe(4);
  });

  it('只填了行动能力时也有上限', () => {
    expect(
      projectPace({ travelers: { mobility_level: 'NO_LONG_STANDING' } }).walking_limit_km,
    ).toBe(6);
  });

  it('「交给系统」不投影每日项目数 —— 那是不设约束', () => {
    const result = projectPace({ pace: { core_activities_per_day: 'SYSTEM' } });
    expect(result.attractions_per_day_min).toBeUndefined();
    expect(result.attractions_per_day_max).toBeUndefined();
  });

  it('最早出门时间取每日时段的开始', () => {
    expect(
      projectPace({ pace: { daily_window: { start: '08:30', end: '20:00' } } })
        .earliest_departure_time,
    ).toBe('08:30');
  });
});

describe('条件投影', () => {
  it('三态标签原样带 mode 与 value', () => {
    const result = projectConditions({
      transport: {
        local_modes: [
          { code: 'transport.public_transit', stance: 'REQUIRE' },
          { code: 'transport.cycling', stance: 'EXCLUDE' },
          { code: 'transport.walking_first', stance: 'PREFER' },
        ],
      },
    });
    expect(result).toEqual(
      expect.arrayContaining([
        { code: 'transport.public_transit', mode: 'MUST', value: true },
        /* 「不要」走 value: false，不进 code 名（命名约定 1）*/
        { code: 'transport.cycling', mode: 'MUST', value: false },
        { code: 'transport.walking_first', mode: 'SHOULD', value: true },
      ]),
    );
  });

  it('饮食与无障碍即使只是偏好也发 MUST', () => {
    /*
     * 轮椅通行与食物过敏不是偏好。降级成 SHOULD 之后 V-30 不再校验，
     * 而生成出的计划看起来完全正常 —— 用户要到出行当天才发现。
     */
    const result = projectConditions({
      food: { dietary_requirements: { values: ['HALAL'] } },
      travelers: { mobility_level: 'LESS_WALKING' },
    });
    for (const condition of result) {
      if (MUST_BY_DEFAULT_DOMAINS.includes(conditionDomain(condition.code))) {
        expect(condition.mode, condition.code).toBe('MUST');
      }
    }
    expect(result.map((c) => c.code)).toEqual(
      expect.arrayContaining(['diet.halal', 'accessibility.low_walking']),
    );
  });

  it('同一个 code 只出现一次 —— N-08 会拒重复', () => {
    /* `accessibility.low_walking` 有三个派生来源（行动能力、健康需求、久站） */
    const result = projectConditions({
      travelers: { mobility_level: 'NO_LONG_STANDING' },
      special: {
        health_accessibility_needs: { values: ['NO_LONG_STANDING', 'WHEELCHAIR_OR_WALKER'] },
      },
    });
    const codes = result.map((condition) => condition.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('只接受直飞是 MUST，最多一次转机是 SHOULD', () => {
    /*
     * 「最多 1 次转机」本身允许转机。用 MUST 会让所有带转机的方案被 V-30 拒掉，
     * 而用户明确说了可以转一次。
     */
    expect(
      projectConditions({
        transport: { flight_constraints: { transfer_tolerance: 'DIRECT_ONLY' } },
      }),
    ).toEqual([{ code: 'transport.avoid_transfer', mode: 'MUST', value: true }]);
    expect(
      projectConditions({
        transport: { flight_constraints: { transfer_tolerance: 'MAX_ONE_TRANSFER' } },
      }),
    ).toEqual([{ code: 'transport.avoid_transfer', mode: 'SHOULD', value: true }]);
  });

  it('「可多次转机」不产出条件 —— 那是放宽而不是约束', () => {
    expect(
      projectConditions({
        transport: { flight_constraints: { transfer_tolerance: 'MULTI_TRANSFER_OK' } },
      }),
    ).toEqual([]);
  });

  it('只有「一次都不换」投影成单一落脚点', () => {
    expect(
      projectConditions({ pace: { hotel_change_tolerance: 'ZERO' } }).map((c) => c.code),
    ).toEqual(['accommodation.single_base']);
    /* 「最多换 1 次」不是单点，算进去会让双中心行程被硬约束拦掉 */
    expect(projectConditions({ pace: { hotel_change_tolerance: 'ONE' } })).toEqual([]);
  });

  it('没有对应码的答案不硬塞码', () => {
    /*
     * 字典外的 code 会让 N-08 以 `REQ_CONDITION_CODE_UNKNOWN` 拒掉**整个请求**。
     * 这些答案由 P9-6 的 constraints.ts 以 RuntimeConstraint 进 Prompt。
     */
    const result = projectConditions({
      food: { dietary_requirements: { values: ['OTHER'], other_text: '不吃牛肉' } },
      travelers: { child_needs: { values: ['KIDS_MEAL'] } },
      interests: { must_do: [{ text: 'teamLab' }] },
    });
    expect(result).toEqual([]);
  });

  it('空答案不产出任何条件', () => {
    expect(projectConditions({})).toEqual([]);
  });
});

describe('已有订单投影', () => {
  it('餐厅与接送没有 P8 对应值，不进投影但留在逐字记录里', () => {
    const body = buildPlannerRequest(
      stateWith({
        ...COMPLETE,
        trip: { ...COMPLETE.trip, locked_order_types: ['LODGING', 'RESTAURANT', 'TRANSFER'] },
      }),
      OPTIONS,
    );
    expect(body.trip.existing_bookings).toEqual(['LODGING']);
    expect(body.planner_profile?.trip?.locked_order_types).toEqual([
      'LODGING',
      'RESTAURANT',
      'TRANSFER',
    ]);
  });
});

describe('日期弹性投影', () => {
  it('五档折成天数', () => {
    const cases = [
      ['FIXED', 0],
      ['PLUS_MINUS_1', 1],
      ['PLUS_MINUS_3', 3],
      ['WHOLE_WEEK', 7],
      ['MONTH_ONLY', 30],
    ] as const;
    for (const [flexibility, days] of cases) {
      const body = buildPlannerRequest(
        stateWith({ ...COMPLETE, trip: { ...COMPLETE.trip, date_flexibility: flexibility } }),
        OPTIONS,
      );
      expect(body.trip.dates.flexibility_days, flexibility).toBe(days);
    }
  });
});

describe('自由文本', () => {
  it('只有补充说明进 custom_requirements', () => {
    /*
     * 「其他」选项的补充文字**不**并进来：它们是各自结构化字段的一部分
     * （留在 planner_profile 里），而 P9-6 的 constraints.ts 会把它们
     * 按各自的运行时类型渲染进 Prompt。并进自由文本会让一条
     * 「必须满足」的饮食要求降级成一句「补充信息」。
     */
    const body = buildPlannerRequest(
      stateWith({
        profile: { additional_notes: '  想安排和菓子体验  ' },
        food: { dietary_requirements: { values: ['OTHER'], other_text: '不吃牛肉' } },
      }),
      OPTIONS,
    );
    expect(body.custom_requirements?.raw_text).toBe('想安排和菓子体验');
  });
});
