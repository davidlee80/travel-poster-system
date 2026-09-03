import {
  AGE_BAND_VALUES,
  ALLERGY_SEVERITY_VALUES,
  BED_TYPE_VALUES,
  BUDGET_MODE_VALUES,
  BUDGET_SCOPE_ITEM_VALUES,
  CABIN_CLASS_VALUES,
  CAR_TYPE_VALUES,
  CHANGEABILITY_VALUES,
  CHILD_NEED_VALUES,
  CONNECTIVITY_PREFERENCE_VALUES,
  CORE_ACTIVITIES_VALUES,
  CURRENCY_VALUES,
  DATE_FLEXIBILITY_VALUES,
  DEPARTURE_WINDOW_VALUES,
  DESTINATION_STATUS_VALUES,
  DIETARY_REQUIREMENT_VALUES,
  DINING_BUDGET_VALUES,
  DRIVING_EXPERIENCE_VALUES,
  ESIM_SUPPORT_VALUES,
  FOOD_EXPERIENCE_VALUES,
  FREE_TIME_VALUES,
  GROUPING_NEED_VALUES,
  HEALTH_NEED_VALUES,
  HIGH_RISK_ACTIVITY_VALUES,
  HOTEL_CHANGE_TOLERANCE_VALUES,
  HOTEL_CLASS_VALUES,
  INSURANCE_STATUS_VALUES,
  LARGE_LUGGAGE_VALUES,
  LICENSE_STATUS_VALUES,
  LOCATION_PRIORITY_VALUES,
  LOCATION_SHARING_VALUES,
  LOCKED_ORDER_TYPE_VALUES,
  LOYALTY_KIND_VALUES,
  MINOR_GUARDIANSHIP_VALUES,
  MOBILITY_LEVEL_VALUES,
  MONITORING_TOPIC_VALUES,
  NOTIFICATION_CHANNEL_VALUES,
  NOTIFICATION_MODE_VALUES,
  PASSPORT_STATUS_VALUES,
  PAYMENT_METHOD_VALUES,
  QUEUE_ATTITUDE_VALUES,
  RISK_EXCLUSION_VALUES,
  SAFETY_CONTEXT_VALUES,
  SEAT_PREFERENCE_VALUES,
  SLEEP_CHECKIN_NEED_VALUES,
  TOP_GOAL_VALUES,
  TRANSFER_TOLERANCE_VALUES,
  TRAVEL_TIER_VALUES,
  TRAVELER_RELATION_VALUES,
  TRIP_PURPOSE_VALUES,
  TRISTATE_ANSWER_VALUES,
  VISA_STATUS_VALUES,
  WALKING_TOLERANCE_VALUES,
  CONDITION_CODES_BY_DOMAIN,
  type PlannerFieldId,
} from '@tps/schemas';

/**
 * 前端只允许「已确定」或「有备选」。
 *
 * 契约暂时保留 `UNDECIDED`，用于兼容已经落库的历史请求；不能直接复用完整枚举，
 * 否则配置中心即使没有发布该选项，内置回退仍会把「完全没定」重新显示出来。
 */
export const PLANNER_DESTINATION_STATUS_VALUES = DESTINATION_STATUS_VALUES.filter(
  (value) => value !== 'UNDECIDED',
);

/**
 * 76 个字段的控件描述符。
 *
 * ## 为什么是一张描述符表而不是 76 个手写控件
 *
 * 规范 21.1 把「必须能识别 76 个唯一 Field ID」列为**阻塞发布**的门槛，而
 * 76 个 bespoke 控件让这件事只能靠逐个核对 —— 而逐个核对在下一次改版时
 * 又要重做一遍。一张 `Record<PlannerFieldId, FieldDescriptor>` 让「76 个字段
 * 都渲染出来」在**结构上**成立：`Record` 少一个键是编译错误，
 * 而通用渲染器保证每个键都产出一个带 `data-field` 的容器。
 *
 * ## 描述符描述的是「值的形状」，不是「长什么样」
 *
 * 一个字段的载荷形状（单值 / `{values, other_text}` / `{enabled, …}` /
 * `{user_reported, …}` / 对象数组）决定了它需要几个控件、每个控件读写哪个键。
 * 视觉（卡片还是标签、几列）由 CSS 与 primitive 决定，不进这张表 ——
 * 把视觉塞进来会让「改一个字段的排版」变成改契约映射。
 *
 * ## 三种包装是分开的字段，不是三个 primitive
 *
 *   `reported` —— 整块包在 `user_reported` 里（规范 4.3）。**不能**做成
 *     primitive：护照有两个部件（状态 + 到期日）而两者共享同一个 `user_reported`
 *     包装，做成 primitive 会让每个部件各写一个 `user_reported`。
 *   `toggle`   —— 前置开关绑 `enabled`，关掉时部件不渲染但**值保留**（规范 6）。
 *   `parts`    —— 其余一切。`key: null` 表示这个部件的值就是字段本身。
 *
 * ## 选项值列表全部从契约的 `*_VALUES` 导入
 *
 * 不在这里重抄一份：抄一份之后往契约枚举里加一个成员，界面上不会出现它，
 * 而没有任何东西会报错 —— 症状是「产品说加了一个选项，界面上找不到」。
 * 三态标签的选项是条件码，来自 `CONDITION_CODES_BY_DOMAIN` 与本文件的
 * 四张分组表（一个域下的码不全属于同一个字段，见下）。
 */

// ── 三态标签的条件码分组 ────────────────────────────────────

/**
 * 四个三态标签字段各自的条件码。
 *
 * 不能直接用 `CONDITION_CODES_BY_DOMAIN`：`transport` 域下 11 个码分属
 * 跨城（PV2-05-001）与当地（PV2-05-005）两个字段，`accommodation` 域下
 * 19 个码分属住宿类型（PV2-06-001）、设施（PV2-06-007）与三个只作为
 * **投影产物**存在的码（`near_transit` / `family_room` / `single_base` ——
 * 它们由位置优先级、房型与换宿容忍度派生，不是用户直接勾的标签）。
 *
 * 因此这四张表是显式的。漏一个码的表现是「界面上少一个选项」，
 * 由 `descriptors.test.ts` 的反向断言守住：这四张表的并集 + 投影专用码
 * 必须恰好等于对应域的全部码。
 */
const INTERCITY_MODE_CODES = [
  'transport.flight',
  'transport.rail',
  'transport.coach',
  'transport.ferry',
  'transport.self_drive',
] as const;

const LOCAL_MODE_CODES = [
  'transport.public_transit',
  'transport.walking_first',
  'transport.ride_hailing',
  'transport.private_car',
  'transport.cycling',
  'transport.self_drive',
] as const;

const LODGING_TYPE_CODES = [
  'accommodation.hotel',
  'accommodation.homestay',
  'accommodation.apartment',
  'accommodation.resort',
  'accommodation.hostel',
] as const;

const LODGING_AMENITY_CODES = [
  'accommodation.elevator',
  'accommodation.private_bath',
  'accommodation.breakfast',
  'accommodation.kitchen',
  'accommodation.laundry',
  'accommodation.bathtub',
  'accommodation.gym',
  'accommodation.pool',
  'accommodation.workspace',
  'accommodation.front_desk_24h',
] as const;

/** 「愿意多花在哪」。`budget` 域全部四项都是用户直接勾的 */
const BUDGET_PRIORITY_CODES = CONDITION_CODES_BY_DOMAIN.budget;

/** 兴趣主题。`interest` 域全部 14 项 */
const INTEREST_CODES = CONDITION_CODES_BY_DOMAIN.interest;

/**
 * 只作为投影产物存在的条件码，不出现在任何三态标签里。
 *
 * 导出它是为了让完整性断言能算「四张表 ∪ 这一张 ≡ 两个域的全部码」。
 * 逐条的派生来源写在 `request.ts` 的投影表里。
 */
export const PROJECTION_ONLY_CODES = [
  'transport.avoid_transfer',
  'accommodation.near_transit',
  'accommodation.family_room',
  'accommodation.shared_dorm',
  'accommodation.single_base',
] as const;

export const TRISTATE_CODES = {
  'transport.intercity_modes': INTERCITY_MODE_CODES,
  'transport.local_modes': LOCAL_MODE_CODES,
  'lodging.types': LODGING_TYPE_CODES,
  'lodging.amenities': LODGING_AMENITY_CODES,
  'budget.scope_and_priorities': BUDGET_PRIORITY_CODES,
} as const satisfies Record<string, readonly string[]>;

// ── 描述符 ──────────────────────────────────────────────────

/**
 * 控件原语。
 *
 * `check` 与 `check-other` 分开而不是给 `check` 加一个布尔开关：两者读写的
 * **值形状不同**（`string[]` 对 `{values, other_text}`），而形状差异用一个
 * 布尔标记表达之后，读写路径就得在运行期分支 —— 那正是 bug 藏身的地方。
 * `rank` / `rank-other` 同理。
 */
export const CONTROL_PRIMITIVES = [
  'choice',
  'check',
  'check-other',
  'rank',
  'rank-other',
  'tristate',
  'counter',
  'number',
  'slider',
  'money',
  'money-range',
  'time',
  'time-range',
  'date',
  'date-range',
  'text',
  'textarea',
  'text-list',
  'bool',
  'place',
  'place-list',
  'object-list',
] as const;
export type ControlPrimitive = (typeof CONTROL_PRIMITIVES)[number];

export interface FieldPart {
  /** 字段值对象内的键。`null` = 这个部件的值就是字段本身 */
  readonly key: string | null;
  readonly primitive: ControlPrimitive;
  /** 部件标签。单部件字段留空 —— 那时字段标题已经是问句 */
  readonly label?: string;
  readonly options?: readonly string[];
  /** 选项取自另一个字段的当前答案（Top 3 只能从已选兴趣里挑）*/
  readonly options_from?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly placeholder?: string;
  readonly hint?: string;
  /**
   * 多选允许用空数组表达「明确没有」时显示的选项。
   *
   * `undefined` 是尚未回答，`[]` / `{ values: [] }` 是用户明确选择了没有；
   * 两者不能只靠选项数组长度区分，因此由描述符显式声明入口。
   */
  readonly empty_label?: string;
  /** 兄弟键选中某个值时才显示。为空时恒显示 */
  readonly requires?: { readonly key: string; readonly value: string };
  /** `object-list` 每行的部件 */
  readonly item_parts?: readonly FieldPart[];
  /** `object-list` 的行数跟随这个计数器字段的 api_key */
  readonly follow_count?: string;
  /** `object-list` 自动写入的行号键（房型配置的 `room_index`，1 起）*/
  readonly index_key?: string;
  /** `object-list` 新增一行的预填值。保证 schema 的必填键不为空 */
  readonly item_defaults?: Readonly<Record<string, unknown>>;
  readonly add_label?: string;
  /**
   * 这个计数器变小时，把该 api_key 指向的数组截断到同样长度。
   *
   * 规范 8 要求人数变化时自动创建或回收 Traveler Card，规范 12 对房间数与
   * 房型配置提同样的要求。不截断的后果是 `travelers.profiles.length > count`，
   * 而那会让 PV2-02-002 报「比同行人数多了 2 位」—— 用户明明只是把人数改小了。
   */
  readonly truncates?: string;
}

export type FieldDescriptor =
  | {
      readonly kind: 'parts';
      /** 整块包在 `user_reported` 里（规范 4.3）。部件的键相对于它 */
      readonly reported?: true;
      /** 前置开关的文案。绑 `enabled`；关掉时部件不渲染但值保留 */
      readonly toggle?: string;
      readonly parts: readonly FieldPart[];
    }
  /** 第 9 步的复核面板（`ReviewBoard.tsx`）*/
  | { readonly kind: 'review-board' }
  /** 第 9 步的阻塞项就地补答列表（`ReviewBoard.tsx`）*/
  | { readonly kind: 'blocker-list' }
  /** 行前准备中心的文件导入入口。上传后端不在 P9 范围内 */
  | { readonly kind: 'upload-entry' };

/** 单部件字段的简写。绝大多数字段是这一种 */
function one(primitive: ControlPrimitive, extra: Omit<FieldPart, 'key' | 'primitive'> = {}) {
  return {
    kind: 'parts',
    parts: [{ key: null, primitive, ...extra }],
  } as const satisfies FieldDescriptor;
}

/**
 * field_id → 控件描述符。
 *
 * `Record` 而不是 `Partial<Record>`：**少一个字段是编译错误**。
 * 这是规范 21.1 那条硬门槛在类型层面的落点 —— 通用渲染器遍历
 * `PLANNER_FIELDS` 时对每个 field_id 查这张表，查不到就没有控件，
 * 而 `Partial` 会让那种情况变成运行期的一个空白区块。
 */
export const FIELD_DESCRIPTORS: Record<PlannerFieldId, FieldDescriptor> = {
  // ── 01 旅行轮廓 ──────────────────────────────────────────
  'PV2-01-001': one('place', { placeholder: '城市、机场或车站' }),
  'PV2-01-002': one('choice', { options: PLANNER_DESTINATION_STATUS_VALUES }),
  'PV2-01-003': one('place-list', {
    max: 5,
    add_label: '添加目的地',
    hint: '顺序即行程顺序，可增删。多城市最多 5 个。',
  }),
  'PV2-01-004': one('date-range'),
  'PV2-01-005': one('choice', { options: DATE_FLEXIBILITY_VALUES }),
  'PV2-01-006': one('check-other', { options: TRIP_PURPOSE_VALUES, max: 4 }),
  'PV2-01-007': one('rank-other', { options: TOP_GOAL_VALUES, max: 3 }),
  'PV2-01-008': one('check', {
    options: LOCKED_ORDER_TYPE_VALUES,
    empty_label: '暂无不可变预订',
  }),
  'PV2-01-009': {
    kind: 'parts',
    parts: [
      {
        key: null,
        primitive: 'object-list',
        max: 20,
        add_label: '添加一张订单',
        item_defaults: {
          type: 'LODGING',
          name: '',
          datetime_text: '',
          place_text: '',
          changeability: 'UNKNOWN',
        },
        item_parts: [
          { key: 'type', primitive: 'choice', label: '类型', options: LOCKED_ORDER_TYPE_VALUES },
          {
            key: 'name',
            primitive: 'text',
            label: '名称',
            placeholder: '航班号 / 酒店名 / 演出名',
          },
          {
            key: 'datetime_text',
            primitive: 'text',
            label: '时间',
            placeholder: '10/05 10:00 起飞',
          },
          { key: 'place_text', primitive: 'text', label: '地点', placeholder: '成田机场 T1' },
          { key: 'reference', primitive: 'text', label: '订单号（可选）' },
          {
            key: 'changeability',
            primitive: 'choice',
            label: '可改退',
            options: CHANGEABILITY_VALUES,
          },
        ],
      },
    ],
  },

  // ── 02 同行伙伴 ──────────────────────────────────────────
  'PV2-02-001': one('counter', { min: 1, max: 20, truncates: 'travelers.profiles' }),
  'PV2-02-002': {
    kind: 'parts',
    parts: [
      {
        key: null,
        primitive: 'object-list',
        max: 20,
        follow_count: 'travelers.count',
        add_label: '添加一位旅行者',
        item_defaults: { relation: 'SELF', age_band: 'ADULT' },
        item_parts: [
          {
            key: 'relation',
            primitive: 'choice',
            label: '同行关系',
            options: TRAVELER_RELATION_VALUES,
          },
          { key: 'age_band', primitive: 'choice', label: '年龄段', options: AGE_BAND_VALUES },
          {
            key: 'age',
            primitive: 'number',
            label: '具体年龄（儿童建议填写）',
            min: 0,
            max: 120,
          },
          {
            key: 'relation_other',
            primitive: 'text',
            label: '关系补充',
            requires: { key: 'relation', value: 'OTHER' },
          },
        ],
      },
    ],
  },
  'PV2-02-003': one('choice', { options: MINOR_GUARDIANSHIP_VALUES }),
  'PV2-02-004': one('choice', { options: MOBILITY_LEVEL_VALUES }),
  'PV2-02-005': one('check-other', {
    options: CHILD_NEED_VALUES,
    empty_label: '无特殊安排',
  }),
  'PV2-02-006': one('check', { options: GROUPING_NEED_VALUES }),

  // ── 03 预算取舍 ──────────────────────────────────────────
  'PV2-03-001': one('choice', { options: BUDGET_MODE_VALUES }),
  'PV2-03-002': one('choice', { options: CURRENCY_VALUES }),
  'PV2-03-003': one('money-range', { min: 0 }),
  'PV2-03-004': one('choice', { options: TRAVEL_TIER_VALUES }),
  'PV2-03-005': {
    kind: 'parts',
    toggle: '有一个绝对不能超过的金额',
    parts: [{ key: 'amount', primitive: 'money', label: '硬上限', min: 0 }],
  },
  'PV2-03-006': {
    kind: 'parts',
    parts: [
      {
        key: 'included_items',
        primitive: 'check',
        label: '这笔预算包含哪些项目',
        options: BUDGET_SCOPE_ITEM_VALUES,
      },
      {
        key: 'priorities',
        primitive: 'tristate',
        label: '哪些项目愿意多花',
        options: BUDGET_PRIORITY_CODES,
      },
    ],
  },

  // ── 04 旅行节奏 ──────────────────────────────────────────
  'PV2-04-001': one('slider', {
    min: 1,
    max: 5,
    hint: '1 是躺平度假，5 是尽量多看。默认 3。',
  }),
  'PV2-04-002': one('time-range'),
  'PV2-04-003': one('choice', { options: WALKING_TOLERANCE_VALUES }),
  'PV2-04-004': one('choice', { options: CORE_ACTIVITIES_VALUES }),
  'PV2-04-005': one('choice', { options: FREE_TIME_VALUES }),
  'PV2-04-006': {
    kind: 'parts',
    toggle: '需要固定午休或午睡',
    parts: [{ key: 'window', primitive: 'time-range', label: '午休时间' }],
  },
  'PV2-04-007': one('choice', { options: HOTEL_CHANGE_TOLERANCE_VALUES }),
  'PV2-04-008': one('check', { options: RISK_EXCLUSION_VALUES }),

  // ── 05 路上怎么走 ────────────────────────────────────────
  'PV2-05-001': one('tristate', { options: INTERCITY_MODE_CODES }),
  'PV2-05-002': {
    kind: 'parts',
    parts: [
      {
        key: 'transfer_tolerance',
        primitive: 'choice',
        label: '直飞与转机',
        options: TRANSFER_TOLERANCE_VALUES,
      },
      { key: 'avoid_red_eye', primitive: 'bool', label: '不要红眼航班' },
    ],
  },
  'PV2-05-003': {
    kind: 'parts',
    parts: [
      { key: 'cabin', primitive: 'choice', label: '舱等', options: CABIN_CLASS_VALUES },
      { key: 'seats', primitive: 'check', label: '座位', options: SEAT_PREFERENCE_VALUES },
    ],
  },
  'PV2-05-004': {
    kind: 'parts',
    parts: [
      {
        key: 'windows',
        primitive: 'check',
        label: '偏好的出发 / 抵达时段',
        options: DEPARTURE_WINDOW_VALUES,
      },
      { key: 'avoid_late_night_arrival', primitive: 'bool', label: '避免深夜抵达' },
    ],
  },
  'PV2-05-005': one('tristate', { options: LOCAL_MODE_CODES }),
  'PV2-05-006': {
    kind: 'parts',
    reported: true,
    parts: [
      { key: 'driver_age', primitive: 'number', label: '主驾年龄', min: 0, max: 120 },
      { key: 'experience', primitive: 'choice', label: '驾龄', options: DRIVING_EXPERIENCE_VALUES },
      {
        key: 'license_status',
        primitive: 'choice',
        label: '证件情况',
        options: LICENSE_STATUS_VALUES,
        hint: '我们只需要判断合法性的条件，不采集驾照号码。',
      },
      { key: 'car_type', primitive: 'choice', label: '车型', options: CAR_TYPE_VALUES },
    ],
  },
  'PV2-05-007': {
    kind: 'parts',
    parts: [
      { key: 'carry_on', primitive: 'counter', label: '随身行李', min: 0, max: 20 },
      { key: 'checked', primitive: 'counter', label: '托运行李', min: 0, max: 20 },
      {
        key: 'large_items',
        primitive: 'check',
        label: '大件或特殊器材',
        options: LARGE_LUGGAGE_VALUES,
      },
      {
        key: 'large_items_other',
        primitive: 'text',
        label: '其他器材说明',
        requires: { key: 'large_items', value: 'OTHER' },
      },
    ],
  },

  // ── 06 住得更舒服 ────────────────────────────────────────
  'PV2-06-001': one('tristate', { options: LODGING_TYPE_CODES }),
  'PV2-06-002': one('counter', { min: 1, max: 10, truncates: 'lodging.room_configuration' }),
  'PV2-06-003': {
    kind: 'parts',
    parts: [
      {
        key: null,
        primitive: 'object-list',
        max: 10,
        follow_count: 'lodging.rooms_count',
        index_key: 'room_index',
        add_label: '添加一间房',
        item_defaults: { bed_type: 'DOUBLE', capacity: 2 },
        item_parts: [
          { key: 'bed_type', primitive: 'choice', label: '床型', options: BED_TYPE_VALUES },
          { key: 'capacity', primitive: 'counter', label: '住几人', min: 1, max: 6 },
        ],
      },
    ],
  },
  'PV2-06-004': one('money-range', { min: 0, hint: '币种沿用预算步骤里选的那个。' }),
  'PV2-06-005': one('rank', { options: LOCATION_PRIORITY_VALUES, max: 3 }),
  'PV2-06-006': {
    kind: 'parts',
    parts: [
      { key: 'hotel_class', primitive: 'choice', label: '星级', options: HOTEL_CLASS_VALUES },
      {
        key: 'brands',
        primitive: 'text-list',
        label: '偏好品牌（留空不限制）',
        max: 5,
        placeholder: '例如 万豪、星野',
      },
    ],
  },
  'PV2-06-007': one('tristate', { options: LODGING_AMENITY_CODES }),
  'PV2-06-008': {
    kind: 'parts',
    parts: [
      {
        key: 'needs',
        primitive: 'check',
        label: '睡眠与入住要求',
        options: SLEEP_CHECKIN_NEED_VALUES,
      },
      {
        key: 'arrival_time',
        primitive: 'time',
        label: '预计到店时间',
        requires: { key: 'needs', value: 'LATE_CHECK_IN' },
        hint: '晚于前台服务时间时，我们会把它列为供应商待核验项。',
      },
    ],
  },

  // ── 07 吃好也玩好 ────────────────────────────────────────
  'PV2-07-001': one('check', { options: FOOD_EXPERIENCE_VALUES }),
  'PV2-07-002': one('check-other', {
    options: DIETARY_REQUIREMENT_VALUES,
    empty_label: '没有特殊饮食要求',
  }),
  'PV2-07-003': one('choice', { options: TRISTATE_ANSWER_VALUES }),
  'PV2-07-004': {
    kind: 'parts',
    parts: [
      {
        key: 'allergens',
        primitive: 'object-list',
        label: '过敏原与严重程度',
        max: 20,
        add_label: '添加一种过敏原',
        item_defaults: { allergen: '', severity: 'MODERATE', avoid_cross_contamination: false },
        item_parts: [
          { key: 'allergen', primitive: 'text', label: '过敏原', placeholder: '花生、甲壳类…' },
          {
            key: 'severity',
            primitive: 'choice',
            label: '严重程度',
            options: ALLERGY_SEVERITY_VALUES,
          },
          { key: 'avoid_cross_contamination', primitive: 'bool', label: '需避免交叉污染' },
        ],
      },
      { key: 'carries_emergency_medication', primitive: 'bool', label: '随身携带急救药物' },
    ],
  },
  'PV2-07-005': {
    kind: 'parts',
    parts: [
      {
        key: 'budget_level',
        primitive: 'choice',
        label: '用餐预算',
        options: DINING_BUDGET_VALUES,
      },
      {
        key: 'queue_attitude',
        primitive: 'check',
        label: '排队与预约',
        options: QUEUE_ATTITUDE_VALUES,
      },
    ],
  },
  'PV2-07-006': one('check', { options: INTEREST_CODES, hint: '建议选 2～8 项。' }),
  'PV2-07-007': one('rank', { options_from: 'interests.tags', max: 3 }),
  'PV2-07-008': {
    kind: 'parts',
    parts: [
      {
        key: null,
        primitive: 'object-list',
        max: 20,
        add_label: '添加一项',
        item_defaults: { text: '' },
        item_parts: [
          { key: 'text', primitive: 'text', label: '地点或活动', placeholder: '例如 teamLab' },
          { key: 'date_constraint', primitive: 'date', label: '只能在某天（可选）' },
        ],
      },
    ],
  },
  'PV2-07-009': {
    kind: 'parts',
    parts: [
      { key: 'wish', primitive: 'text-list', label: '还想去', max: 20 },
      { key: 'exclude', primitive: 'text-list', label: '明确不要安排', max: 20 },
    ],
  },
  'PV2-07-010': {
    kind: 'parts',
    toggle: '有明确的购物或退税目标',
    parts: [
      { key: 'brands_or_categories', primitive: 'text-list', label: '品牌或品类', max: 20 },
      { key: 'budget', primitive: 'money', label: '购物预算', min: 0 },
      {
        key: 'wants_tax_refund',
        primitive: 'bool',
        label: '需要安排退税',
        hint: '大额购物是否计入总预算，请在预算步骤的口径里说明。',
      },
    ],
  },

  // ── 08 特别关照 ──────────────────────────────────────────
  'PV2-08-001': one('choice', { options: TRISTATE_ANSWER_VALUES }),
  'PV2-08-002': one('check-other', { options: HEALTH_NEED_VALUES }),
  'PV2-08-003': one('check', {
    options: HIGH_RISK_ACTIVITY_VALUES,
    empty_label: '没有相关活动',
  }),
  'PV2-08-004': {
    kind: 'parts',
    reported: true,
    parts: [{ key: null, primitive: 'choice', options: TRISTATE_ANSWER_VALUES }],
  },
  'PV2-08-005': {
    kind: 'parts',
    parts: [
      { key: 'nationality', primitive: 'text', label: '国籍', placeholder: '中国' },
      { key: 'residency', primitive: 'text', label: '长期居留地', placeholder: '中国' },
    ],
  },
  'PV2-08-006': {
    kind: 'parts',
    reported: true,
    parts: [
      { key: 'status', primitive: 'choice', label: '状态', options: PASSPORT_STATUS_VALUES },
      { key: 'expiry_date', primitive: 'date', label: '到期日' },
    ],
  },
  'PV2-08-007': {
    kind: 'parts',
    reported: true,
    parts: [
      { key: 'status', primitive: 'choice', label: '状态', options: VISA_STATUS_VALUES },
      { key: 'valid_until', primitive: 'date', label: '有效期至（可选）' },
    ],
  },
  'PV2-08-008': {
    kind: 'parts',
    reported: true,
    parts: [{ key: null, primitive: 'choice', options: INSURANCE_STATUS_VALUES }],
  },
  'PV2-08-009': one('check', {
    options: SAFETY_CONTEXT_VALUES,
    empty_label: '没有需要补充的安全背景',
  }),
  'PV2-08-010': {
    kind: 'parts',
    toggle: '行程中有不能移动的工作安排',
    parts: [
      {
        key: 'items',
        primitive: 'object-list',
        max: 10,
        add_label: '添加一段',
        item_defaults: { when_text: '' },
        item_parts: [
          { key: 'when_text', primitive: 'text', label: '时间', placeholder: '10/06 09:00–11:00' },
          {
            key: 'requirement_text',
            primitive: 'text',
            label: '要求',
            placeholder: '需要安静网络',
          },
        ],
      },
    ],
  },

  // ── 09 确认旅程 ──────────────────────────────────────────
  'PV2-09-001': { kind: 'review-board' },
  'PV2-09-002': { kind: 'blocker-list' },
  'PV2-09-003': {
    kind: 'parts',
    parts: [
      { key: 'mode', primitive: 'choice', label: '提醒频率', options: NOTIFICATION_MODE_VALUES },
      { key: 'channels', primitive: 'check', label: '渠道', options: NOTIFICATION_CHANNEL_VALUES },
    ],
  },
  'PV2-09-004': one('textarea', { max: 500, placeholder: '任何我们没问到但你希望我们知道的事。' }),
  'PV2-09-005': one('bool', {
    label: '我同意本次服务使用我提供的信息来生成与优化这份行程',
  }),
  'PV2-09-006': one('bool', {
    label: '保存非敏感旅行偏好，下次不用重填',
  }),

  // ── 10 行前准备中心 ──────────────────────────────────────
  'PV2-10-001': {
    kind: 'parts',
    parts: [
      { key: 'esim', primitive: 'choice', label: '手机支持 eSIM 吗', options: ESIM_SUPPORT_VALUES },
      {
        key: 'preferences',
        primitive: 'check',
        label: '希望怎么联网',
        options: CONNECTIVITY_PREFERENCE_VALUES,
      },
    ],
  },
  'PV2-10-002': one('check-other', { options: PAYMENT_METHOD_VALUES }),
  'PV2-10-003': {
    kind: 'parts',
    parts: [
      {
        key: null,
        primitive: 'object-list',
        max: 20,
        add_label: '添加一项权益',
        item_defaults: { kind: 'AIRLINE', brand: '' },
        item_parts: [
          { key: 'kind', primitive: 'choice', label: '类型', options: LOYALTY_KIND_VALUES },
          { key: 'brand', primitive: 'text', label: '品牌', placeholder: 'ANA / 万豪' },
          { key: 'tier', primitive: 'text', label: '等级（可选）', placeholder: '金卡' },
        ],
      },
    ],
  },
  'PV2-10-004': {
    kind: 'parts',
    parts: [
      { key: 'name', primitive: 'text', label: '姓名' },
      { key: 'relation', primitive: 'text', label: '与你的关系' },
      { key: 'contact', primitive: 'text', label: '联系方式' },
      {
        key: 'location_sharing',
        primitive: 'choice',
        label: '位置共享',
        options: LOCATION_SHARING_VALUES,
        hint: '位置共享是独立授权，可以随时改。',
      },
    ],
  },
  'PV2-10-005': { kind: 'upload-entry' },
  'PV2-10-006': one('check', { options: MONITORING_TOPIC_VALUES }),
};

/**
 * 描述符声明了哪些选项值。
 *
 * 供「每个选项值都有中文文案」的断言遍历 —— 断言那件事需要的是
 * 「界面上会出现哪些值」而不是「契约里有哪些值」，两者的差别正是
 * `PROJECTION_ONLY_CODES`（在契约里，但界面上不出现）。
 */
export function declaredOptionValues(fieldId: PlannerFieldId): readonly string[] {
  const descriptor = FIELD_DESCRIPTORS[fieldId];
  if (descriptor.kind !== 'parts') return [];
  const out: string[] = [];
  const walk = (parts: readonly FieldPart[]): void => {
    for (const part of parts) {
      if (part.options !== undefined) out.push(...part.options);
      if (part.item_parts !== undefined) walk(part.item_parts);
    }
  };
  walk(descriptor.parts);
  return out;
}
