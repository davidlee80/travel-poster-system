import { CONDITION_LABEL } from '@tps/presentation';
import { plannerField, type PlannerFieldId } from '@tps/schemas';

/**
 * 选项值 → 展示文案。
 *
 * ## 为什么按 api_key 分层而不是一张扁平表
 *
 * 枚举值跨字段重名。`SHOPPING` 同时出现在四个字段里，而四处的文案不同：
 *
 *   profile.trip_purposes        SHOPPING → 购物
 *   profile.top_goals            SHOPPING → 购物效率
 *   budget.scope_and_priorities  SHOPPING → 购物开支
 *   lodging.location_priorities  SHOPPING → 购物方便
 *
 * 扁平表会静默取其中一个，而症状是「第 1 步显示购物，第 6 步也显示购物」——
 * 两个问题看起来问了同一件事。`OTHER` / `NONE` / `FIVE` 这类通用值同理。
 *
 * ## 为什么条件码的文案不在这里
 *
 * 61 个条件码的中文标签在 `@tps/presentation` 的 `CONDITION_LABEL` 里，
 * 那是 `Record<ConditionCode, string>` —— 新增码漏配标签是**编译错误**。
 * 在这里再抄一份会失去那个保护，且两份必然漂移。
 */

/** api_key → 该字段的选项文案 */
export const OPTION_LABEL: Record<string, Record<string, string>> = {
  // ── 01 旅行轮廓 ──
  'trip.destination_status': {
    CONFIRMED: '已经确定',
    SHORTLISTED: '有几个备选',
  },
  'trip.date_flexibility': {
    FIXED: '日期固定',
    PLUS_MINUS_1: '前后可差 1 天',
    PLUS_MINUS_3: '前后可差 3 天',
    WHOLE_WEEK: '整周都可以调',
    MONTH_ONLY: '只定月份',
  },
  'trip.locked_order_types': {
    INTERCITY_TRANSPORT: '往返交通',
    LODGING: '酒店',
    TICKETS: '门票 / 活动',
    RESTAURANT: '餐厅',
    TRANSFER: '接送',
  },
  'profile.trip_purposes': {
    LEISURE: '休闲度假',
    HONEYMOON: '蜜月纪念',
    FAMILY: '亲子陪伴',
    FOOD: '美食',
    PHOTOGRAPHY: '摄影',
    SHOPPING: '购物',
    SKI: '滑雪',
    SHOW_SPORTS: '演出赛事',
    BLEISURE: '商务 + 休闲',
    VISIT_RELATIVES: '探亲',
    OTHER: '其他',
  },
  'profile.top_goals': {
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

  'trip.locked_orders': {
    /*
     * 订单类型在这里再出现一次（`trip.locked_order_types` 也有）。
     *
     * 不复用那一份：两处的语境不同 —— 那里是「已经有哪些不可变的预订」的
     * 复选卡片，这里是订单卡上的「类型」下拉。文案现在恰好相同，
     * 但把它们指向同一份表意味着将来改一处会静默改掉另一处。
     */
    INTERCITY_TRANSPORT: '往返交通',
    LODGING: '酒店',
    TICKETS: '门票 / 活动',
    RESTAURANT: '餐厅',
    TRANSFER: '接送',
    CHANGEABLE: '可改可退',
    NON_REFUNDABLE: '不可改退',
    /* 「不清楚」按不可改退处理（规范 7），但仍与上一项分开存 —— 后台核实后要能区分 */
    UNKNOWN: '不清楚',
  },

  // ── 02 同行伙伴 ──
  'travelers.profiles': {
    SELF: '本人',
    PARTNER: '伴侣',
    FRIEND: '朋友',
    CHILD: '孩子',
    PARENT: '父母',
    OTHER: '其他',
    INFANT: '婴幼儿',
    /*
     * `CHILD` 同时是同行关系与年龄段的成员，两者在这个字段里都会出现。
     * 值相同意味着一份表放不下两个文案 —— 而「孩子」在两处读起来都对，
     * 因此不拆。若将来两处需要不同文案（如年龄段要写「儿童 3–11 岁」），
     * 必须把年龄段挪到独立的 api_key 键下，而不是在这里二选一。
     */
    TEEN: '少年',
    ADULT: '成人',
    SENIOR: '长者',
  },
  'travelers.minor_guardianship': {
    BOTH_PARENTS: '双亲陪同',
    SINGLE_PARENT: '单亲陪同',
    NON_PARENT_GUARDIAN: '非父母监护人',
    UNACCOMPANIED: '独自出行',
  },
  'travelers.mobility_level': {
    NORMAL: '正常活动',
    LESS_WALKING: '希望少走',
    NO_LONG_STANDING: '不能久站',
    AVOID_STAIRS: '避免大量台阶',
    FREQUENT_REST: '需要频繁休息',
  },
  'travelers.child_needs': {
    STROLLER_ACCESS: '婴儿车通行',
    CAR_SEAT: '儿童安全座椅',
    FIXED_NAP: '固定午睡',
    KIDS_MEAL: '儿童餐',
    FAMILY_ROOM: '亲子房',
    OTHER: '其他',
  },
  'travelers.grouping_needs': {
    SEPARATE_ROOMS: '分房',
    SEPARATE_CARS: '分车',
    SPLIT_ACTIVITIES: '可以分组活动',
    ALWAYS_TOGETHER: '大部分时间一起',
  },

  // ── 03 预算取舍 ──
  'budget.mode': {
    TOTAL: '整个旅行总预算',
    PER_PERSON: '人均总预算',
    TIER: '只知道旅行档次',
    UNKNOWN: '暂时没概念',
  },
  'budget.currency': {
    CNY: 'CNY ¥',
    JPY: 'JPY JP¥',
    USD: 'USD $',
    EUR: 'EUR €',
    GBP: 'GBP £',
    HKD: 'HKD HK$',
  },
  'budget.travel_tier': {
    ECONOMY: '经济型',
    COMFORT: '舒适型',
    QUALITY: '品质型',
    LUXURY: '奢华型',
  },
  'budget.scope_and_priorities': {
    INTERCITY_TRANSPORT: '往返大交通',
    ACCOMMODATION: '住宿',
    MEALS: '餐饮',
    LOCAL_TRANSPORT: '市内交通',
    TICKETS: '活动门票',
    SHOPPING: '购物开支',
  },

  // ── 04 旅行节奏 ──
  'pace.walking_tolerance': {
    UP_TO_3KM: '≤ 3 km',
    KM_3_TO_5: '3–5 km',
    KM_5_TO_8: '5–8 km',
    KM_8_TO_12: '8–12 km',
    OVER_12KM: '12 km+',
  },
  'pace.core_activities_per_day': {
    ONE: '1 个',
    TWO_TO_THREE: '2–3 个',
    FOUR_TO_FIVE: '4–5 个',
    AS_MANY: '尽量多',
    SYSTEM: '交给系统',
  },
  'pace.free_time': {
    NONE: '几乎不留',
    ABOUT_1H: '1 小时左右',
    H2_TO_3: '2–3 小时',
    HALF_DAY: '半天',
    DEPENDS: '视情况',
  },
  'pace.hotel_change_tolerance': {
    ZERO: '一次都不换',
    ONE: '最多换 1 次',
    TWO: '最多换 2 次',
    THREE_PLUS: '3 次以上也行',
    FOR_EXPERIENCE: '为了体验可以接受',
  },
  'risk.exclusions': {
    RED_EYE_FLIGHT: '红眼航班',
    OVERNIGHT_GROUND: '夜间长途交通',
    MULTI_TRANSFER: '多次转机',
    REMOTE_AREA: '偏远地区',
    LAST_MINUTE_CHANGE: '临时变更',
    HIGH_RISK_ACTIVITY: '高风险活动',
    LONG_QUEUE: '长时间排队',
  },

  // ── 05 路上怎么走 ──
  'transport.flight_constraints': {
    DIRECT_ONLY: '只接受直飞',
    DIRECT_PREFERRED: '优先直飞',
    MAX_ONE_TRANSFER: '最多 1 次转机',
    MULTI_TRANSFER_OK: '可多次转机',
  },
  'transport.flight_comfort': {
    ECONOMY: '经济舱',
    PREMIUM_ECONOMY: '超级经济舱',
    BUSINESS: '商务舱',
    FIRST: '头等舱',
    WINDOW: '靠窗',
    AISLE: '过道',
    TOGETHER: '连座',
  },
  'transport.time_preferences': {
    EARLY_MORNING: '清晨',
    MORNING: '上午',
    AFTERNOON: '下午',
    EVENING: '晚间',
  },
  'transport.self_drive': {
    UNDER_1Y: '不足 1 年',
    Y1_TO_3: '1–3 年',
    OVER_3Y: '3 年以上',
    VALID_LICENSE: '持有效驾照',
    HAS_IDP: '有 IDP / 翻译件',
    NEEDS_CHECK: '需要核验',
    SEDAN: '普通轿车',
    SUV: 'SUV',
    VAN_7: '7 座',
    WITH_CHILD_SEAT: '带儿童座椅',
  },
  'transport.luggage_profile': {
    NONE: '没有',
    STROLLER: '婴儿车',
    CAMERA_GEAR: '摄影器材',
    SPORTS_GEAR: '运动装备',
    OTHER: '其他',
  },

  // ── 06 住得更舒服 ──
  'lodging.room_configuration': {
    DOUBLE: '1 张大床',
    TWIN: '2 张单人床',
    EXTRA_BED: '大床 + 加床',
    CONNECTING: '连通房',
    FAMILY: '家庭房',
    SEPARATE: '分开的房间',
  },
  'lodging.location_priorities': {
    TRANSIT_CONVENIENT: '交通便利',
    WALK_TO_SIGHTS: '景点步行可达',
    QUIET: '安静好睡',
    NIGHTLIFE: '夜生活方便',
    SHOPPING: '购物方便',
    SEA_OR_NATURE: '海景 / 自然',
    HOTEL_ITSELF: '酒店本身',
  },
  'lodging.class_and_brand': {
    ANY: '无要求',
    THREE_PLUS: '3 星以上',
    FOUR_PLUS: '4 星以上',
    FIVE: '5 星',
  },
  'lodging.sleep_checkin_needs': {
    VERY_QUIET: '非常安静',
    HIGH_FLOOR: '高楼层',
    NON_SMOKING: '非吸烟房',
    LATE_CHECK_IN: '晚到入住',
    EARLY_CHECK_IN: '提前入住',
    LATE_CHECK_OUT: '晚退房',
  },

  // ── 07 吃好也玩好 ──
  'food.experience_tags': {
    LOCAL_SPECIALTY: '当地特色',
    FINE_DINING: 'Fine Dining',
    STREET_FOOD: '街头美食',
    MARKET: '市场',
    CAFE_DESSERT: '咖啡甜品',
    BAR_IZAKAYA: '酒吧 / 居酒屋',
    CHINESE: '中餐',
    JAPANESE: '日料',
    WESTERN: '西餐',
  },
  'food.dietary_requirements': {
    VEGETARIAN: '素食',
    VEGAN: '纯素',
    HALAL: '清真',
    KOSHER: '犹太洁食',
    NO_SPICY: '不吃辣',
    ALCOHOL_FREE: '不饮酒',
    OTHER: '其他',
  },
  'food.has_allergies': { NO: '没有', YES: '有', UNSURE: '不确定' },
  'food.allergy_details': {
    MILD: '轻微',
    MODERATE: '中等',
    SEVERE: '严重',
    ANAPHYLAXIS: '过敏性休克风险',
  },
  'food.dining_style': {
    MOSTLY_CASUAL: '普通为主',
    MODERATE: '适中，特色餐愿意多花',
    QUALITY_FIRST: '品质餐厅优先',
    WILL_BOOK_AHEAD: '愿意提前预约',
    WILL_QUEUE: '愿意排队',
    AVOID_QUEUE: '尽量不排长队',
  },

  // ── 08 特别关照 ──
  'special.has_health_or_accessibility_needs': { NO: '没有', YES: '有', UNSURE: '不确定' },
  'special.health_accessibility_needs': {
    WHEELCHAIR_OR_WALKER: '轮椅 / 助行',
    HEARING_VISION_AID: '视听辅助',
    PREGNANCY: '孕期',
    CHRONIC_CONDITION: '慢性病影响',
    NO_LONG_STANDING: '不能久站',
    MEDICAL_DEVICE: '医疗设备',
    OTHER: '其他',
  },
  'special.high_risk_activities': {
    HIGH_ALTITUDE: '高原',
    SCUBA_DIVING: '水肺潜水',
    SKIING: '滑雪',
    MOUNTAINEERING: '登山',
    EXTREME_SPORTS: '跳伞 / 极限项目',
  },
  'special.medication_status': { NO: '不需要', YES: '需要', UNSURE: '不确定' },
  'documents.passport_status': {
    VALID: '在有效期内',
    APPLYING: '待办理',
    RENEWING: '更新中',
  },
  'documents.visa_status': {
    HELD: '已有',
    NOT_APPLIED: '未办理',
    IN_PROGRESS: '办理中',
    UNSURE: '不确定',
    MAYBE_EXEMPT: '可能免签',
  },
  'insurance.status': {
    HELD: '已有',
    NONE: '没有',
    WILL_BUY: '待购买',
    UNSURE: '不确定',
  },
  'safety.contexts': {
    SOLO_TRAVEL: '独自旅行',
    SOLO_FEMALE: '女性独行',
    HEAVY_NIGHTLIFE: '夜生活较多',
    LATE_NIGHT_ARRIVAL: '深夜抵达',
    REMOTE_AREA: '偏远地区',
  },

  // ── 09 确认旅程 ──
  'service.notification_preferences': {
    REALTIME: '实时提醒',
    DAILY_MORNING: '每日晨报',
    DAILY_EVENING: '每日晚报',
    IMPORTANT_ONLY: '仅重要变化',
    IN_APP: '站内通知',
    EMAIL: '邮件',
  },

  // ── 10 行前准备中心 ──
  'pretrip.connectivity': {
    SUPPORTED: '支持 eSIM',
    NOT_SUPPORTED: '不支持 eSIM',
    UNSURE: '不确定',
    ESIM: 'eSIM',
    ROAMING: '漫游',
    PHYSICAL_SIM: '实体 SIM',
    WIFI: '随身 Wi-Fi',
  },
  'pretrip.payment_methods': {
    VISA: 'Visa',
    MASTERCARD: 'Mastercard',
    AMEX: 'Amex',
    APPLE_PAY: 'Apple Pay',
    GOOGLE_PAY: 'Google Pay',
    CASH: '现金',
    OTHER: '其他',
  },
  'pretrip.loyalty_programs': {
    AIRLINE: '航空',
    HOTEL: '酒店',
    CAR_RENTAL: '租车',
    CREDIT_CARD: '信用卡',
  },
  'pretrip.emergency_contact': {
    NEVER: '不共享',
    EMERGENCY_ONLY: '仅紧急时',
    DURING_TRIP: '旅行期间共享',
  },
  'service.monitoring_topics': {
    WEATHER: '天气',
    FLIGHT_OR_TRAIN: '航班车次',
    ATTRACTION_CLOSURE: '景点关闭',
    TRANSIT_DISRUPTION: '公交中断',
    SAFETY_ALERT: '安全警报',
    BOOKING_CONFIRMATION: '预订确认',
  },
};

/**
 * 取一个选项值的展示文案。
 *
 * 顺序：该字段自己的选项表 → 条件码表 → 原值。回退到原值而不是空串：
 * 一个显示 `LEISURE` 的选项至少让人看出漏配了文案，
 * 而一个空按钮看起来像渲染错误。
 */
export function optionLabel(value: string, apiKey?: string): string {
  if (apiKey !== undefined) {
    const own = OPTION_LABEL[apiKey]?.[value];
    if (own !== undefined) return own;
  }
  const condition = (CONDITION_LABEL as Record<string, string | undefined>)[value];
  return condition ?? value;
}

/**
 * 高度敏感字段在右栏只显示抽象状态（规范 17.2 与 20）。
 *
 * 规范给的例子是「存在严重食物过敏需求」而不是具体过敏原。这张表的每一条都是
 * 「有这件事」而不是「这件事的内容」—— 右栏是一个常驻可见的面板，
 * 在咖啡馆里被旁人看到具体病史或证件状态与被看到「存在健康需求」性质不同。
 */
/*
 * 表里恰好是「高度敏感 **且** 会出现在右栏」的六个字段。
 *
 * 另外三个高度敏感字段（授权、紧急联系人、导入文件）的摘要分组是「不展示」，
 * 它们在 `buildSummary` 里更早就被跳过了，因此给它们配文案是死代码。
 *
 * 敏感级别为「敏感」而不是「高度敏感」的字段（国籍、自驾资格、监护人）
 * **照常显示具体值** —— 规范 20 的原文只对高度敏感提这个要求，
 * 把范围扩大会让右栏变成一串「已登记 XX」，而它存在的价值是让用户看到
 * 自己实际告诉了系统什么。
 */
export const ABSTRACT_SUMMARY: Partial<Record<PlannerFieldId, string>> = {
  'PV2-07-003': '存在食物过敏需求',
  'PV2-07-004': '存在需逐家核实的过敏安全约束',
  'PV2-08-001': '存在需要照顾的健康或无障碍需求',
  'PV2-08-002': '已登记无障碍与照护需求',
  'PV2-08-004': '存在随行药品合规事项待确认',
  'PV2-08-006': '护照状态待核验',
};

/** 这个字段在右栏是否只显示抽象状态 */
export function isMasked(fieldId: PlannerFieldId): boolean {
  return plannerField(fieldId).sensitivity === 'HIGH';
}
