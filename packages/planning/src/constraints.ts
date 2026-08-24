import {
  PLANNER_CONSTRAINT_PRECEDENCE,
  plannerField,
  type PlannerConstraintType,
  type PlannerFieldId,
  type PlannerProfile,
  type RuntimeConstraint,
  type VerifyItem,
} from '@tps/schemas';

/**
 * 76 字段答案 → 运行时约束清单与待核验清单（TP-9，规范 4 章 + 4.1 + 4.3）。
 *
 * ## 为什么需要这一层
 *
 * P8 的链路只认三样东西：`conditions[]`（冻结字典里的 code）、
 * `pace` 的四个数值、以及一段 500 字自由文本。而 76 字段里有大量约束
 * **没有对应的 code**：
 *
 *   「花生过敏，严重程度是过敏性休克风险，需避免交叉污染」
 *   「10/06 09:00–11:00 有不能移动的会议，需要安静网络」
 *   「明确不要安排：夜店」
 *   「已购买且不可改退：东京湾酒店，10/01 15:00 入住」
 *
 * 硬塞 code 会让 N-08 拒掉整个请求；放进自由文本会让一条安全硬约束降级成
 * 一句「补充信息」，而 5.1 明确规定「不得据自由文本静默改写硬约束」。
 *
 * 因此这里产出的是**带类型与来源的自然语言约束**，由 Prompt 按
 * `LOCKED > CONSENT > HARD > EXCLUDE > VERIFY > PREFER` 分段渲染（规范 4.1）。
 *
 * ## 一条约束的 `source_field_id` 是硬要求
 *
 * 规范 21.2 要求生成结果能指回具体字段。因此每条约束都从某个 field_id 派生，
 * 没有「系统自己加的」约束 —— 那种约束用户既看不到来源也无法修改。
 *
 * ## 这里**不做**取舍
 *
 * 冲突（「必须有电梯」与「不要电梯」同时出现）不在这里解决：`decision_weight`
 * 把优先级带下去，由生成与 V-xx 校验决定。在这里合并两条矛盾约束会让
 * 「系统悄悄替用户做了决定」，而规范 4.1 只允许「低优先级不得静默覆盖高优先级」，
 * 不允许静默丢弃。
 */

/** 一次派生的产物。两份清单分开，因为它们的消费方不同（Prompt 与待确认面板） */
export interface DerivedConstraints {
  readonly constraints: readonly RuntimeConstraint[];
  readonly verify_items: readonly VerifyItem[];
}

interface Draft {
  readonly type: PlannerConstraintType;
  readonly field: PlannerFieldId;
  readonly text: string;
  /** 同一字段派生出多条时用它区分（过敏原逐条、订单逐张）*/
  readonly slot?: string;
}

function toConstraint(draft: Draft): RuntimeConstraint {
  /*
   * `constraint_id` = 类型:字段[#槽位]。
   *
   * 不用数组下标：删掉中间一条会让其后所有约束的标识都变，
   * 而跨版本比对「哪几条约束变了」正是这个字段存在的理由。
   */
  const suffix = draft.slot === undefined ? '' : `#${draft.slot}`;
  return {
    constraint_id: `${draft.type}:${draft.field}${suffix}`,
    type: draft.type,
    source_field_id: draft.field,
    text: draft.text,
    decision_weight: PLANNER_CONSTRAINT_PRECEDENCE[draft.type],
  };
}

// ── 文案表 ──────────────────────────────────────────────────

/**
 * field_id → 该字段的选项文案（进 Prompt 的中文短语）。
 *
 * ## 为什么按字段分层，而不是一张扁平表
 *
 * 枚举值跨字段重名，而重名的两处含义**完全不同**：
 *
 *   PV2-04-007 换宿容忍度   THREE_PLUS → 可以换三次以上住宿
 *   PV2-06-006 星级         THREE_PLUS → 三星以上
 *   PV2-04-005 自由时间     NONE       → 几乎不留自由时间
 *   PV2-05-007 大件行李     NONE       → 没有大件行李
 *   PV2-05-003 舱等         ECONOMY    → 经济舱
 *   PV2-03-004 旅行档次     ECONOMY    → 经济型
 *
 * 扁平表会静默取其中一个，而症状是 **Prompt 里出现一条语义被改写的约束**：
 * 「住宿星级：可以换三次以上住宿」。这比界面上显示错文案严重得多 ——
 * 模型会照着那条错约束生成，而没有任何校验能发现。
 * `apps/web` 的 `OPTION_LABEL` 出于同一个理由也是按 api_key 分层的。
 *
 * ## 为什么后端要另有一份，不复用前端那份
 *
 * 两者的读者不同。界面文案可以很短，因为旁边有问题标题与其他选项作上下文
 * （「≤ 3 km」在一排档位里含义清楚）；Prompt 里的每一条必须**自足**
 * （「每天步行不超过 3 公里」）。共用一份会让改一次界面文案就改变发给模型的
 * 约束语义 —— 而那是一次无人察觉的行为变更。
 *
 * 打包上也不可能复用：`apps/web` 不能被 `packages/planning` 引用。
 */
const PHRASE_BY_FIELD: Partial<Record<PlannerFieldId, Record<string, string>>> = {
  // ── 01 旅行轮廓 ──
  'PV2-01-006': {
    LEISURE: '休闲度假',
    HONEYMOON: '蜜月或纪念日',
    FAMILY: '亲子陪伴',
    FOOD: '美食',
    PHOTOGRAPHY: '摄影',
    SHOPPING: '购物',
    SKI: '滑雪',
    SHOW_SPORTS: '看演出或赛事',
    BLEISURE: '商务加休闲',
    VISIT_RELATIVES: '探亲',
    OTHER: '其他',
  },
  'PV2-01-007': {
    EAT_WELL: '吃得好',
    STAY_WELL: '住得舒服',
    LESS_HASSLE: '少折腾',
    DEEP_EXPERIENCE: '深度体验',
    PHOTOS: '拍照好看',
    FAMILY_FUN: '亲子开心',
    SHOPPING: '购物效率',
    VALUE_FOR_MONEY: '控制预算',
    FREE_TIME: '留白自由',
    OTHER: '其他',
  },
  'PV2-01-009': {
    INTERCITY_TRANSPORT: '往返交通',
    LODGING: '住宿',
    TICKETS: '门票或活动',
    RESTAURANT: '餐厅',
    TRANSFER: '接送',
    CHANGEABLE: '可改可退',
    NON_REFUNDABLE: '不可改退',
    /* 「不清楚」按不可改退处理（规范 7），但文案照实说 —— 模型据此可以建议用户去确认 */
    UNKNOWN: '改退政策不清楚',
  },

  // ── 02 同行伙伴 ──
  'PV2-02-003': {
    BOTH_PARENTS: '未成年人由双亲陪同',
    SINGLE_PARENT: '未成年人由单亲陪同',
    NON_PARENT_GUARDIAN: '未成年人由非父母监护人陪同',
    UNACCOMPANIED: '未成年人独自出行',
  },
  'PV2-02-004': {
    LESS_WALKING: '希望少走路',
    NO_LONG_STANDING: '不能长时间站立',
    AVOID_STAIRS: '避免大量台阶',
    FREQUENT_REST: '需要频繁休息',
  },
  'PV2-02-005': {
    STROLLER_ACCESS: '婴儿车要能通行',
    CAR_SEAT: '需要儿童安全座椅',
    FIXED_NAP: '需要固定午睡时间',
    KIDS_MEAL: '需要儿童餐',
    FAMILY_ROOM: '需要亲子房',
    OTHER: '其他儿童需求',
  },
  'PV2-02-006': {
    SEPARATE_ROOMS: '需要分房',
    SEPARATE_CARS: '需要分车',
    SPLIT_ACTIVITIES: '可以分组活动',
    ALWAYS_TOGETHER: '大部分时间要在一起',
  },

  // ── 03 预算取舍 ──
  'PV2-03-004': {
    ECONOMY: '经济型',
    COMFORT: '舒适型',
    QUALITY: '品质型',
    LUXURY: '奢华型',
  },
  'PV2-03-006': {
    INTERCITY_TRANSPORT: '往返大交通',
    ACCOMMODATION: '住宿',
    MEALS: '餐饮',
    LOCAL_TRANSPORT: '市内交通',
    TICKETS: '活动门票',
    SHOPPING: '购物',
  },

  // ── 04 旅行节奏 ──
  'PV2-04-003': {
    UP_TO_3KM: '每天步行不超过 3 公里',
    KM_3_TO_5: '每天步行 3 到 5 公里',
    KM_5_TO_8: '每天步行 5 到 8 公里',
    KM_8_TO_12: '每天步行 8 到 12 公里',
    OVER_12KM: '每天步行 12 公里以上也可以',
  },
  'PV2-04-004': {
    ONE: '每天只安排一个核心项目',
    TWO_TO_THREE: '每天安排二到三个核心项目',
    FOUR_TO_FIVE: '每天安排四到五个核心项目',
    AS_MANY: '每天尽量多安排',
    SYSTEM: '每天安排几项交给系统决定',
  },
  'PV2-04-005': {
    NONE: '几乎不需要留自由时间',
    ABOUT_1H: '每天留约一小时自由时间',
    H2_TO_3: '每天留两到三小时自由时间',
    HALF_DAY: '每天留半天自由时间',
    DEPENDS: '自由时间视情况而定',
  },
  'PV2-04-007': {
    ZERO: '全程不换住宿，只住一个地方',
    ONE: '最多换一次住宿',
    TWO: '最多换两次住宿',
    THREE_PLUS: '可以换三次以上住宿',
    FOR_EXPERIENCE: '为了体验可以多换住宿',
  },
  'PV2-04-008': {
    RED_EYE_FLIGHT: '红眼航班',
    OVERNIGHT_GROUND: '夜间长途陆路交通',
    MULTI_TRANSFER: '多次转机',
    REMOTE_AREA: '偏远地区',
    LAST_MINUTE_CHANGE: '临时变更',
    HIGH_RISK_ACTIVITY: '高风险活动',
    LONG_QUEUE: '长时间排队',
  },

  // ── 05 路上怎么走 ──
  'PV2-05-002': {
    DIRECT_ONLY: '只接受直飞，不得安排转机',
    DIRECT_PREFERRED: '优先直飞',
    MAX_ONE_TRANSFER: '最多接受一次转机',
    MULTI_TRANSFER_OK: '可以接受多次转机',
  },
  'PV2-05-003': {
    ECONOMY: '经济舱',
    PREMIUM_ECONOMY: '超级经济舱',
    BUSINESS: '商务舱',
    FIRST: '头等舱',
    WINDOW: '靠窗',
    AISLE: '靠过道',
    TOGETHER: '同行人连座',
  },
  'PV2-05-004': {
    EARLY_MORNING: '清晨',
    MORNING: '上午',
    AFTERNOON: '下午',
    EVENING: '晚间',
  },
  'PV2-05-006': {
    UNDER_1Y: '驾龄不足一年',
    Y1_TO_3: '驾龄一到三年',
    OVER_3Y: '驾龄三年以上',
    VALID_LICENSE: '持有效驾照',
    HAS_IDP: '有国际驾照或翻译件',
    NEEDS_CHECK: '驾驶资格需要核验',
    SEDAN: '普通轿车',
    SUV: 'SUV',
    VAN_7: '七座车',
    WITH_CHILD_SEAT: '车上要有儿童座椅',
  },
  'PV2-05-007': {
    NONE: '没有大件行李',
    STROLLER: '婴儿车',
    CAMERA_GEAR: '摄影器材',
    SPORTS_GEAR: '运动装备',
    OTHER: '其他大件物品',
  },

  // ── 06 住得更舒服 ──
  'PV2-06-003': {
    DOUBLE: '一张大床',
    TWIN: '两张单人床',
    EXTRA_BED: '大床加床',
    CONNECTING: '连通房（需供应商确认）',
    FAMILY: '家庭房',
    SEPARATE: '分开的房间',
  },
  'PV2-06-005': {
    TRANSIT_CONVENIENT: '交通便利',
    WALK_TO_SIGHTS: '步行可达景点',
    QUIET: '安静好睡',
    NIGHTLIFE: '夜生活方便',
    SHOPPING: '购物方便',
    SEA_OR_NATURE: '有海景或自然景观',
    HOTEL_ITSELF: '酒店本身有吸引力',
  },
  'PV2-06-006': {
    ANY: '星级无要求',
    THREE_PLUS: '三星以上',
    FOUR_PLUS: '四星以上',
    FIVE: '五星',
  },
  'PV2-06-008': {
    VERY_QUIET: '房间要非常安静',
    HIGH_FLOOR: '要高楼层',
    NON_SMOKING: '要非吸烟房',
    LATE_CHECK_IN: '会晚到入住',
    EARLY_CHECK_IN: '希望提前入住',
    LATE_CHECK_OUT: '希望晚退房',
  },

  // ── 07 吃好也玩好 ──
  'PV2-07-001': {
    LOCAL_SPECIALTY: '当地特色菜',
    FINE_DINING: '精致餐饮',
    STREET_FOOD: '街头美食',
    MARKET: '本地市场',
    CAFE_DESSERT: '咖啡与甜品',
    BAR_IZAKAYA: '酒吧或居酒屋',
    CHINESE: '中餐',
    JAPANESE: '日料',
    WESTERN: '西餐',
  },
  'PV2-07-002': {
    VEGETARIAN: '素食',
    VEGAN: '纯素（不含蛋奶）',
    HALAL: '清真',
    KOSHER: '犹太洁食',
    NO_SPICY: '不吃辣',
    ALCOHOL_FREE: '不饮酒',
    OTHER: '其他饮食要求',
  },
  'PV2-07-004': {
    MILD: '轻微',
    MODERATE: '中等',
    SEVERE: '严重',
    ANAPHYLAXIS: '有过敏性休克风险',
  },
  'PV2-07-005': {
    MOSTLY_CASUAL: '以普通餐厅为主',
    MODERATE: '适中，特色餐愿意多花',
    QUALITY_FIRST: '优先品质餐厅',
    WILL_BOOK_AHEAD: '愿意提前预约',
    WILL_QUEUE: '愿意排队',
    AVOID_QUEUE: '尽量不排长队',
  },

  // ── 08 特别关照 ──
  'PV2-08-002': {
    WHEELCHAIR_OR_WALKER: '使用轮椅或助行器',
    HEARING_VISION_AID: '需要视听辅助',
    PREGNANCY: '孕期',
    CHRONIC_CONDITION: '有慢性病影响行程',
    NO_LONG_STANDING: '不能长时间站立',
    MEDICAL_DEVICE: '随身有医疗设备',
    OTHER: '其他健康或无障碍需求',
  },
  'PV2-08-003': {
    HIGH_ALTITUDE: '高原活动',
    SCUBA_DIVING: '水肺潜水',
    SKIING: '滑雪',
    MOUNTAINEERING: '登山',
    EXTREME_SPORTS: '跳伞或其他极限项目',
  },
  'PV2-08-006': {
    VALID: '在有效期内',
    APPLYING: '待办理',
    RENEWING: '更新中',
  },
  'PV2-08-007': {
    HELD: '已持有',
    NOT_APPLIED: '尚未办理',
    IN_PROGRESS: '办理中',
    UNSURE: '不确定',
    MAYBE_EXEMPT: '可能免签',
  },
  'PV2-08-008': {
    HELD: '已持有',
    NONE: '没有',
    WILL_BUY: '打算购买',
    UNSURE: '不确定',
  },
  'PV2-08-009': {
    SOLO_TRAVEL: '独自旅行',
    SOLO_FEMALE: '女性独自旅行',
    HEAVY_NIGHTLIFE: '夜间活动较多',
    LATE_NIGHT_ARRIVAL: '深夜抵达',
    REMOTE_AREA: '会去偏远地区',
  },
};

/**
 * 取一个选项值在**某个字段下**的文案。
 *
 * 查不到时回退原值：一个英文枚举名进 Prompt 至少能看出漏配了文案，
 * 而空串会让那条约束变成一句「」—— 模型读到一条空约束，
 * 而它大概会当作根本没有这条约束。
 */
function phrase(field: PlannerFieldId, value: string): string {
  return PHRASE_BY_FIELD[field]?.[value] ?? value;
}

function phrases(field: PlannerFieldId, values: readonly string[]): string {
  return values.map((value) => phrase(field, value)).join('、');
}

/** 该字段声明了哪些选项文案。供测试对照契约枚举 */
export function declaredPhraseValues(field: PlannerFieldId): readonly string[] {
  return Object.keys(PHRASE_BY_FIELD[field] ?? {});
}

/** 三态 → 运行时类型。`PREFER` 落 PREFER，`REQUIRE` 落 HARD，`EXCLUDE` 落 EXCLUDE */
const STANCE_TYPE: Record<string, PlannerConstraintType> = {
  PREFER: 'PREFER',
  REQUIRE: 'HARD',
  EXCLUDE: 'EXCLUDE',
};

// ── 派生 ────────────────────────────────────────────────────

/**
 * 从问卷答案派生运行时约束与待核验清单。
 *
 * 空答案（P8 客户端）返回两个空数组 —— 调用方据此不往
 * `NormalizedTravelRequest` 里写这两个字段（它们是可选的，见陷阱 2）。
 */
export function deriveConstraints(profile: PlannerProfile | undefined): DerivedConstraints {
  if (profile === undefined) return { constraints: [], verify_items: [] };

  const drafts: Draft[] = [];
  const verify: VerifyItem[] = [];

  const push = (
    type: PlannerConstraintType,
    field: PlannerFieldId,
    text: string,
    slot?: string,
  ): void => {
    if (text.trim().length === 0) return;
    drafts.push(slot === undefined ? { type, field, text } : { type, field, text, slot });
  };

  /**
   * 登记一条待核验项。
   *
   * `blocking` 取字段元数据的 `runtime_type` 而不是调用方传参：
   * 「签证待查」与「严重过敏安全确认」的分级是规范 0 章定下来的，
   * 而在调用处逐个传一个布尔会让那个分级被复制 9 次。
   */
  const pushVerify = (field: PlannerFieldId, text: string, slot?: string): void => {
    const spec = plannerField(field);
    verify.push({
      item_id: slot === undefined ? `VERIFY:${field}` : `VERIFY:${field}#${slot}`,
      source_field_id: field,
      blocking: spec.runtime_type === 'VERIFY_BLOCKING',
      status: 'user_reported',
      text,
    });
  };

  // ── 01 旅行轮廓 ────────────────────────────────────────
  const trip = profile.trip;

  /*
   * LOCKED 由已有订单派生（规范 4 章的注）。
   *
   * **只有不可改退（含「不清楚」）的订单才是 LOCKED。** 可改退的订单是
   * HARD —— 它仍然要出现在行程里，但排期冲突时可以建议改期。
   * 全部当 LOCKED 会让一张可退的餐厅预订把整天锁死；
   * 全部当 HARD 会让一张不可退的机票被模型「优化」掉。
   *
   * 「不清楚」按不可改退处理（规范 7：不可改退默认视为最高约束）。
   */
  for (const [index, order] of (trip?.locked_orders ?? []).entries()) {
    const locked = order.changeability !== 'CHANGEABLE';
    const detail =
      `${phrase('PV2-01-009', order.type)}「${order.name}」，时间：${order.datetime_text}，` +
      `地点：${order.place_text}，${phrase('PV2-01-009', order.changeability)}`;
    push(
      locked ? 'LOCKED' : 'HARD',
      'PV2-01-009',
      locked ? `已购买且不可移动：${detail}` : `已预订，如需改动请说明理由：${detail}`,
      String(index),
    );
  }

  const goals = profile.profile?.top_goals?.values ?? [];
  if (goals.length > 0) {
    /* 数组顺序即排名，第 1 项权重最高（契约里没有 rank 字段）*/
    push('HARD', 'PV2-01-007', `本次旅行最重要的事，按重要性排序：${phrases('PV2-01-007', goals)}`);
  }
  const purposes = profile.profile?.trip_purposes;
  if (purposes !== undefined && (purposes.values.length > 0 || purposes.other_text !== undefined)) {
    push(
      'FACT',
      'PV2-01-006',
      `旅行目的：${[phrases('PV2-01-006', purposes.values), purposes.other_text ?? ''].filter((p) => p.length > 0).join('、')}`,
    );
  }

  // ── 02 同行伙伴 ────────────────────────────────────────
  const travelers = profile.travelers;
  const mobility = travelers?.mobility_level;
  if (mobility !== undefined && mobility !== 'NORMAL') {
    push('HARD', 'PV2-02-004', `同行人的行动能力：${phrase('PV2-02-004', mobility)}`);
  }
  const childNeeds = travelers?.child_needs;
  if (childNeeds !== undefined && childNeeds.values.length > 0) {
    push('HARD', 'PV2-02-005', `儿童出行安排：${phrases('PV2-02-005', childNeeds.values)}`);
  }
  const grouping = travelers?.grouping_needs ?? [];
  if (grouping.length > 0) {
    push('FACT', 'PV2-02-006', `同行人分组：${phrases('PV2-02-006', grouping)}`);
  }
  if (travelers?.minor_guardianship !== undefined) {
    pushVerify(
      'PV2-02-003',
      `${phrase('PV2-02-003', travelers.minor_guardianship)}，需确认航空公司与目的地的监护要求`,
    );
  }

  // ── 03 预算取舍 ────────────────────────────────────────
  const budget = profile.budget;
  const cap = budget?.hard_cap;
  if (cap?.enabled === true && cap.amount !== undefined) {
    /* 硬上限的优先级高于档次偏好（字段表）。它是 HARD 而不是 PREFER */
    push(
      'HARD',
      'PV2-03-005',
      `总花费绝对不能超过 ${cap.amount} ${budget?.currency ?? 'CNY'}`,
    );
  }
  const scope = budget?.scope_and_priorities;
  if (scope !== undefined && scope.included_items.length > 0) {
    push('FACT', 'PV2-03-006', `预算口径包含：${phrases('PV2-03-006', scope.included_items)}`);
  }
  if (budget?.travel_tier !== undefined) {
    push('PREFER', 'PV2-03-004', `整体档次：${phrase('PV2-03-004', budget.travel_tier)}`);
  }

  // ── 04 旅行节奏 ────────────────────────────────────────
  const pace = profile.pace;
  if (pace?.daily_window !== undefined) {
    push(
      'HARD',
      'PV2-04-002',
      `每天最早 ${pace.daily_window.start} 出门，最晚 ${pace.daily_window.end} 结束`,
    );
  }
  if (pace?.walking_tolerance !== undefined) {
    push('HARD', 'PV2-04-003', phrase('PV2-04-003', pace.walking_tolerance));
  }
  if (pace?.core_activities_per_day !== undefined && pace.core_activities_per_day !== 'SYSTEM') {
    push('PREFER', 'PV2-04-004', phrase('PV2-04-004', pace.core_activities_per_day));
  }
  if (pace?.free_time !== undefined) {
    push('PREFER', 'PV2-04-005', phrase('PV2-04-005', pace.free_time));
  }
  const rest = pace?.rest_window;
  if (rest?.enabled === true && rest.window !== undefined) {
    push(
      'HARD',
      'PV2-04-006',
      `每天 ${rest.window.start} 到 ${rest.window.end} 是固定午休，这段时间不安排任何行程`,
    );
  }
  if (pace?.hotel_change_tolerance !== undefined) {
    push('HARD', 'PV2-04-007', phrase('PV2-04-007', pace.hotel_change_tolerance));
  }
  const exclusions = profile.risk?.exclusions ?? [];
  if (exclusions.length > 0) {
    push('EXCLUDE', 'PV2-04-008', `绝对不要安排：${phrases('PV2-04-008', exclusions)}`);
  }

  // ── 05 路上怎么走 ──────────────────────────────────────
  const transport = profile.transport;
  for (const selection of transport?.intercity_modes ?? []) {
    pushStance(push, 'PV2-05-001', selection, '跨城交通');
  }
  for (const selection of transport?.local_modes ?? []) {
    pushStance(push, 'PV2-05-005', selection, '当地交通');
  }
  const flight = transport?.flight_constraints;
  if (flight?.transfer_tolerance !== undefined) {
    /* 「只接受直飞」是硬约束，其余三档是偏好 —— 后者本身允许转机 */
    push(
      flight.transfer_tolerance === 'DIRECT_ONLY' ? 'HARD' : 'PREFER',
      'PV2-05-002',
      phrase('PV2-05-002', flight.transfer_tolerance),
    );
  }
  if (flight?.avoid_red_eye === true) {
    push('EXCLUDE', 'PV2-05-002', '不要红眼航班', 'red_eye');
  }
  const comfort = transport?.flight_comfort;
  if (comfort?.cabin !== undefined) push('PREFER', 'PV2-05-003', `舱等：${phrase('PV2-05-003', comfort.cabin)}`);
  if ((comfort?.seats ?? []).length > 0) {
    push('PREFER', 'PV2-05-003', `座位：${phrases('PV2-05-003', comfort?.seats ?? [])}`, 'seats');
  }
  const times = transport?.time_preferences;
  if ((times?.windows ?? []).length > 0) {
    push('PREFER', 'PV2-05-004', `偏好时段：${phrases('PV2-05-004', times?.windows ?? [])}`);
  }
  if (times?.avoid_late_night_arrival === true) {
    push('EXCLUDE', 'PV2-05-004', '不要深夜抵达', 'late_night');
  }
  const drive = transport?.self_drive?.user_reported;
  if (drive !== undefined) {
    const parts = [
      drive.driver_age === undefined ? '' : `主驾 ${drive.driver_age} 岁`,
      drive.experience === undefined ? '' : phrase('PV2-05-006', drive.experience),
      drive.license_status === undefined ? '' : phrase('PV2-05-006', drive.license_status),
      drive.car_type === undefined ? '' : `车型：${phrase('PV2-05-006', drive.car_type)}`,
    ].filter((part) => part.length > 0);
    if (parts.length > 0) {
      pushVerify('PV2-05-006', `自驾计划（用户自报，需核验目的地是否认可）：${parts.join('，')}`);
    }
  }
  const luggage = transport?.luggage_profile;
  if (luggage !== undefined) {
    const items = [
      luggage.carry_on === undefined ? '' : `随身 ${luggage.carry_on} 件`,
      luggage.checked === undefined ? '' : `托运 ${luggage.checked} 件`,
      (luggage.large_items ?? []).length === 0 ? '' : `大件：${phrases('PV2-05-007', luggage.large_items ?? [])}`,
      luggage.large_items_other ?? '',
    ].filter((part) => part.length > 0);
    if (items.length > 0) push('FACT', 'PV2-05-007', `行李：${items.join('，')}`);
  }

  // ── 06 住得更舒服 ──────────────────────────────────────
  const lodging = profile.lodging;
  for (const selection of lodging?.types ?? []) {
    pushStance(push, 'PV2-06-001', selection, '住宿类型');
  }
  for (const selection of lodging?.amenities ?? []) {
    pushStance(push, 'PV2-06-007', selection, '住宿设施');
  }
  const rooms = lodging?.room_configuration ?? [];
  if (rooms.length > 0) {
    push(
      'HARD',
      'PV2-06-003',
      `房间配置：${rooms.map((room) => `第 ${room.room_index} 间 ${phrase('PV2-06-003', room.bed_type)}（${room.capacity} 人）`).join('；')}`,
    );
  }
  if (lodging?.nightly_budget !== undefined) {
    push(
      'HARD',
      'PV2-06-004',
      `住宿每晚预算 ${lodging.nightly_budget.min} 到 ${lodging.nightly_budget.max} ${budget?.currency ?? 'CNY'}`,
    );
  }
  const priorities = lodging?.location_priorities ?? [];
  if (priorities.length > 0) {
    push('PREFER', 'PV2-06-005', `住宿位置看重（按重要性排序）：${phrases('PV2-06-005', priorities)}`);
  }
  const classAndBrand = lodging?.class_and_brand;
  if (classAndBrand?.hotel_class !== undefined && classAndBrand.hotel_class !== 'ANY') {
    push('PREFER', 'PV2-06-006', `住宿星级：${phrase('PV2-06-006', classAndBrand.hotel_class)}`);
  }
  if ((classAndBrand?.brands ?? []).length > 0) {
    push('PREFER', 'PV2-06-006', `偏好住宿品牌：${(classAndBrand?.brands ?? []).join('、')}`, 'brands');
  }
  const sleep = lodging?.sleep_checkin_needs;
  if (sleep !== undefined && sleep.needs.length > 0) {
    push('HARD', 'PV2-06-008', `睡眠与入住要求：${phrases('PV2-06-008', sleep.needs)}`);
  }
  if (sleep?.arrival_time !== undefined) {
    /* 字段表：晚到时间超过前台时间时必须进 VERIFY */
    pushVerify('PV2-06-008', `预计 ${sleep.arrival_time} 到店，需确认前台是否还在服务`);
  }

  // ── 07 吃好也玩好 ──────────────────────────────────────
  const food = profile.food;
  if ((food?.experience_tags ?? []).length > 0) {
    push('PREFER', 'PV2-07-001', `餐饮体验偏好：${phrases('PV2-07-001', food?.experience_tags ?? [])}`);
  }
  const diet = food?.dietary_requirements;
  if (diet !== undefined && (diet.values.length > 0 || diet.other_text !== undefined)) {
    const text = [phrases('PV2-07-002', diet.values), diet.other_text ?? ''].filter((p) => p.length > 0).join('、');
    /* 饮食是硬约束，不是偏好（规范 4.2 禁止对它用三态） */
    push('HARD', 'PV2-07-002', `必须遵守的饮食方式：${text}`);
  }
  const allergies = food?.allergy_details;
  for (const [index, entry] of (allergies?.allergens ?? []).entries()) {
    push(
      'HARD',
      'PV2-07-004',
      `食物过敏：${entry.allergen}，严重程度${phrase('PV2-07-004', entry.severity)}` +
        (entry.avoid_cross_contamination ? '，需避免交叉污染' : ''),
      String(index),
    );
    /*
     * 严重与休克风险两级额外进待核验：字段表要求「严重过敏进入人工/供应商确认」。
     * 轻微与中等不进 —— 那会让待确认清单被大量低风险项淹没，
     * 而清单存在的意义是让真正危险的那几条被看见。
     */
    if (entry.severity === 'SEVERE' || entry.severity === 'ANAPHYLAXIS') {
      pushVerify('PV2-07-004', `${entry.allergen}（${phrase('PV2-07-004', entry.severity)}）需逐家餐厅确认`, String(index));
    }
  }
  if (allergies?.carries_emergency_medication === true) {
    push('FACT', 'PV2-07-004', '随身携带急救药物', 'emergency_med');
  }
  const dining = food?.dining_style;
  if (dining?.budget_level !== undefined) {
    push('PREFER', 'PV2-07-005', `用餐预算取向：${phrase('PV2-07-005', dining.budget_level)}`);
  }
  for (const attitude of dining?.queue_attitude ?? []) {
    /* 「尽量不排长队」升级为 EXCLUDE（字段表：「不排队」可升级为 EXCLUDE）*/
    push(
      attitude === 'AVOID_QUEUE' ? 'EXCLUDE' : 'PREFER',
      'PV2-07-005',
      phrase('PV2-07-005', attitude),
      attitude,
    );
  }

  const interests = profile.interests;
  const top3 = interests?.top3 ?? [];
  if (top3.length > 0) {
    push('PREFER', 'PV2-07-007', `最重要的兴趣，按重要性排序：${top3.join('、')}`);
  }
  for (const [index, item] of (interests?.must_do ?? []).entries()) {
    push(
      'HARD',
      'PV2-07-008',
      `必须安排：${item.text}` +
        (item.date_constraint === undefined ? '' : `（只能在 ${item.date_constraint}）`),
      String(index),
    );
  }
  const wish = interests?.wish_and_exclude;
  if ((wish?.wish ?? []).length > 0) {
    push('PREFER', 'PV2-07-009', `还想去：${(wish?.wish ?? []).join('、')}`);
  }
  if ((wish?.exclude ?? []).length > 0) {
    push('EXCLUDE', 'PV2-07-009', `明确不要安排：${(wish?.exclude ?? []).join('、')}`, 'exclude');
  }
  const shopping = profile.shopping?.intent;
  if (shopping?.enabled === true) {
    const parts = [
      (shopping.brands_or_categories ?? []).length === 0
        ? ''
        : `目标：${(shopping.brands_or_categories ?? []).join('、')}`,
      shopping.budget === undefined ? '' : `购物预算 ${shopping.budget}`,
      shopping.wants_tax_refund === true ? '需要安排退税' : '',
    ].filter((part) => part.length > 0);
    if (parts.length > 0) push('PREFER', 'PV2-07-010', `购物计划：${parts.join('，')}`);
  }

  // ── 08 特别关照 ────────────────────────────────────────
  const special = profile.special;
  const health = special?.health_accessibility_needs;
  if (health !== undefined && (health.values.length > 0 || health.other_text !== undefined)) {
    const text = [phrases('PV2-08-002', health.values), health.other_text ?? ''].filter((p) => p.length > 0).join('、');
    push('HARD', 'PV2-08-002', `需要照顾的实际需求：${text}`);
  }
  const risky = special?.high_risk_activities ?? [];
  if (risky.length > 0) {
    push('FACT', 'PV2-08-003', `计划中的高风险活动：${phrases('PV2-08-003', risky)}`);
    pushVerify('PV2-08-003', `${phrases('PV2-08-003', risky)}需确认保险是否承保`);
  }
  const medication = special?.medication_status?.user_reported;
  if (medication === 'YES' || medication === 'UNSURE') {
    pushVerify(
      'PV2-08-004',
      medication === 'YES'
        ? '旅行期间需携带处方药或受控药物，需核实入境规则'
        : '是否需携带处方药尚不确定，需进一步确认',
    );
  }
  const work = special?.work_constraints;
  if (work?.enabled === true) {
    for (const [index, item] of work.items.entries()) {
      push(
        'HARD',
        'PV2-08-010',
        `不能移动的工作安排：${item.when_text}` +
          (item.requirement_text === undefined ? '' : `，${item.requirement_text}`),
        String(index),
      );
    }
  }

  const documents = profile.documents;
  const nationality = documents?.nationality_residency;
  if (nationality?.nationality !== undefined || nationality?.residency !== undefined) {
    push(
      'FACT',
      'PV2-08-005',
      `国籍：${nationality?.nationality ?? '未填'}，长期居留地：${nationality?.residency ?? '未填'}`,
    );
  }
  const passport = documents?.passport_status?.user_reported;
  if (passport?.status !== undefined || passport?.expiry_date !== undefined) {
    pushVerify(
      'PV2-08-006',
      `护照${passport?.status === undefined ? '' : phrase('PV2-08-006', passport.status)}` +
        `${passport?.expiry_date === undefined ? '' : `，${passport.expiry_date} 到期`}（用户自报，需核验）`,
    );
  }
  const visa = documents?.visa_status?.user_reported;
  if (visa?.status !== undefined) {
    pushVerify(
      'PV2-08-007',
      `目的地签证：${phrase('PV2-08-007', visa.status)}${visa.valid_until === undefined ? '' : `，有效期至 ${visa.valid_until}`}（用户自报，不视为最终结论）`,
    );
  }
  const insurance = profile.insurance?.status?.user_reported;
  if (insurance !== undefined) {
    pushVerify('PV2-08-008', `旅行保险：${phrase('PV2-08-008', insurance)}（用户自报，需核验承保范围）`);
  }
  const safety = profile.safety?.contexts ?? [];
  if (safety.length > 0) {
    push('HARD', 'PV2-08-009', `需要提高安全阈值的场景：${phrases('PV2-08-009', safety)}`);
  }

  // ── 09 确认旅程 ────────────────────────────────────────
  const privacy = profile.privacy;
  if (privacy?.trip_processing_consent === true) {
    /*
     * CONSENT 进约束清单而不是只做一次校验。
     *
     * 规范 4.1 把它排在第二高优先级，含义是「没有这条授权，任何需要敏感数据的
     * 功能都不能做」。把它渲染进 Prompt 让「哪些数据被允许使用」对生成侧也可见 ——
     * 只在入口校验一次的话，下游没有任何地方能看出这份数据是被授权使用的。
     */
    push('CONSENT', 'PV2-09-005', '用户已授权本次服务使用其提供的信息（含敏感项）生成行程');
  }
  const notes = profile.profile?.additional_notes;
  if (notes !== undefined && notes.trim().length > 0) {
    /* INFO：不得据此静默改写硬约束（规范 4 章的类型语义）*/
    push('INFO', 'PV2-09-004', `用户补充说明（仅供参考，不得据此改写硬约束）：${notes.trim()}`);
  }

  return { constraints: drafts.map(toConstraint), verify_items: verify };
}

/** 一个三态选择 → 一条约束。三处调用共用，避免三份各自演化的态到类型映射 */
function pushStance(
  push: (type: PlannerConstraintType, field: PlannerFieldId, text: string, slot?: string) => void,
  field: PlannerFieldId,
  selection: { readonly code: string; readonly stance: string },
  label: string,
): void {
  const type = STANCE_TYPE[selection.stance];
  if (type === undefined) return;
  const verb = type === 'HARD' ? '必须' : type === 'EXCLUDE' ? '不要' : '优先';
  push(type, field, `${label}${verb}：${selection.code}`, selection.code);
}

/**
 * 按 4.1 的优先级排序。
 *
 * Prompt 分段渲染读排好序的清单，因此排序在这里做一次而不是在渲染时做 ——
 * 渲染方各自排的话，`prompt.ts` 与将来的约束报告页会给出不同的顺序，
 * 而用户会以为那是两份不同的约束。
 *
 * 同权重内保持派生顺序（也就是问卷顺序）：那是用户填写的顺序，
 * 比按字母排更容易对照。`sort` 在 Node 上是稳定的，因此不需要额外的 index。
 */
export function sortConstraints(
  constraints: readonly RuntimeConstraint[],
): readonly RuntimeConstraint[] {
  return [...constraints].sort((a, b) => a.decision_weight - b.decision_weight);
}
