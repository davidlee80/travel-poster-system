import type { TravelPlan, TravelPlanDay } from './travel-plan.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * 契约 fixture（设计稿第一阶段「静态示例数据渲染」）。
 *
 * 用途：
 *   - P1 的模板渲染与视觉回归基线（TP-1-05、TP-1-16）
 *   - 派生字段与压缩规则的单测输入（TP-1-08、TP-1-09）
 *   - schema 自身的往返校验
 *
 * 用代码生成而不是手写 14 天 JSON：手写 14 天会有几千行且必然出现
 * 复制粘贴导致的日期/天号错位，而这些正是业务规则 V-02/V-03 要抓的问题 ——
 * 用错误的 fixture 测试正确性没有意义。
 *
 * fixture 数据本身是**合法**的（不触发任何 BLOCKING 违规），
 * 违规用例由业务规则的测试各自构造（P2 TP-2-12）。
 */

const DAY_THEMES = [
  { theme: '西湖初见·湖山入画', subtitle: '从断桥到北山街，先把西湖的轮廓走一遍' },
  { theme: '灵隐问禅·山径听泉', subtitle: '在飞来峰的石刻与茶山之间放慢脚步' },
  { theme: '运河人文·古今交融', subtitle: '在水巷与博物馆之间，慢慢读懂杭州的另一面' },
  { theme: '宋韵寻踪·南宋遗痕', subtitle: '沿御街与官窑，看一座都城留下的细节' },
  { theme: '龙井茶山·春水初沸', subtitle: '从茶园到炒茶灶，喝懂一杯明前龙井' },
  { theme: '钱塘江畔·城市天际', subtitle: '看江与城如何在这一段互相塑形' },
  { theme: '良渚回望·五千年前', subtitle: '在土台与玉器之间，触到文明的起点' },
] as const;

const PERIODS = ['MORNING', 'AFTERNOON', 'EVENING'] as const;

const SCHEDULE_TEMPLATES = [
  {
    title: '拱宸桥与大运河博物馆',
    description: '参观运河沿岸历史建筑与专题展览。',
    location: {
      name: '拱宸桥',
      place_id: 'hz-gongchen-bridge',
      latitude: 30.3201,
      longitude: 120.1421,
    },
    duration_minutes: 150,
    walking: 1.2,
    cost: 0,
    // V-33 要求 has_child 时每日至少一条适合儿童的安排（R-20）
    childFriendly: true,
  },
  {
    title: '大兜路历史街区漫步',
    description: '沿街茶楼与老宅，适合傍晚慢走。',
    location: { name: '大兜路', place_id: 'hz-dadoulu', latitude: 30.3092, longitude: 120.1487 },
    duration_minutes: 90,
    walking: 1.8,
    cost: 0,
    childFriendly: false,
  },
  {
    title: '运河水上巴士游览',
    description: '从武林门码头乘船，沿岸看城市与河道的关系。',
    location: {
      name: '武林门码头',
      place_id: 'hz-wulinmen-pier',
      latitude: 30.2765,
      longitude: 120.1612,
    },
    duration_minutes: 60,
    walking: 0.6,
    cost: 10,
    childFriendly: true,
  },
] as const;

/** 把日期加上若干天，返回 `YYYY-MM-DD` */
function addDays(startDate: string, days: number): string {
  const [y, m, d] = startDate.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildDay(dayNumber: number, startDate: string): TravelPlanDay {
  const themeIndex = (dayNumber - 1) % DAY_THEMES.length;
  const themeEntry = DAY_THEMES[themeIndex] ?? DAY_THEMES[0];

  const schedule = SCHEDULE_TEMPLATES.map((tpl, index) => {
    const period = PERIODS[index] ?? 'AFTERNOON';
    const startHour = 9 + index * 4;
    const start = `${String(startHour).padStart(2, '0')}:30`;
    const endMinutes = startHour * 60 + 30 + tpl.duration_minutes;
    const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    return {
      period,
      start_time: start,
      end_time: end,
      title: tpl.title,
      description: tpl.description,
      duration_minutes: tpl.duration_minutes,
      location: { ...tpl.location },
      estimated_walking_km: tpl.walking,
      estimated_cost: { amount: tpl.cost, currency: 'CNY' as const },
      child_friendly: tpl.childFriendly,
    };
  });

  const breakdown = [
    { label: '门票', amount: 0, bucket: 'TICKET' as const },
    { label: '运河船票', amount: 10, bucket: 'TRANSPORT' as const },
    { label: '地铁往返', amount: 15, bucket: 'TRANSPORT' as const },
    { label: '早餐与午餐', amount: 70, bucket: 'MEAL' as const },
    { label: '茶水与杂项', amount: 10, bucket: 'OTHER' as const },
  ];

  const sumBucket = (bucket: 'TICKET' | 'TRANSPORT' | 'MEAL' | 'OTHER'): number =>
    breakdown.filter((b) => b.bucket === bucket).reduce((acc, b) => acc + b.amount, 0);

  return {
    day_number: dayNumber,
    date: addDays(startDate, dayNumber - 1),
    city: '杭州',
    theme: themeEntry.theme,
    subtitle: themeEntry.subtitle,
    daily_summary: '这一天更适合慢节奏，白天看展，傍晚逛运河。',

    schedule,

    food_recommendations: [
      {
        meal: 'BREAKFAST',
        name: '葱包桧与小馄饨',
        description: '杭州经典街头早餐。',
        entity_type: 'DISH',
      },
      {
        meal: 'LUNCH',
        name: '片儿川',
        description: '雪菜笋片配面，杭州人的日常。',
        entity_type: 'DISH',
      },
      {
        meal: 'DINNER',
        name: '大兜路河鲜小馆',
        description: '沿河老店，做本地家常河鲜。',
        entity_type: 'RESTAURANT',
      },
    ],

    route_recommendations: [
      { type: 'RELAXED', title: '轻松休闲路线', nodes: ['拱宸桥', '运河游船', '大兜路'] },
      {
        type: 'CLASSIC',
        title: '经典必看路线',
        nodes: ['拱宸桥', '大运河博物馆', '桥西直街', '大兜路'],
      },
    ],

    must_do: ['漫步拱宸桥历史街区', '体验运河水上交通'],

    photo_spots: [
      { name: '拱宸桥桥头远景', entity_name: '拱宸桥', preferred_time: 'MORNING' },
      { name: '运河夜景与倒影', entity_name: '大兜路', preferred_time: 'NIGHT' },
    ],

    transport_tips: [
      { text: '运河水上巴士 1 号线可直达拱宸桥，比地铁少一次换乘。', mode: 'BOAT' },
      { text: '桥西直街到大兜路步行约 20 分钟，沿河走比打车快。', mode: 'WALK' },
    ],

    ticket_reminders: [
      {
        entity_name: '中国大运河博物馆',
        text: '免费参观但需提前一天在公众号预约当日时段。',
        advance_days: 1,
        price: { amount: 0, currency: 'CNY' },
      },
    ],

    booking_tips: [
      { text: '大兜路沿街茶楼晚市 18:00 后满座，建议提前电话留位。', category: 'RESTAURANT' },
    ],

    daily_budget: {
      ticket: sumBucket('TICKET'),
      transport: sumBucket('TRANSPORT'),
      meal: sumBucket('MEAL'),
      other: sumBucket('OTHER'),
      total: breakdown.reduce((acc, b) => acc + b.amount, 0),
      currency: 'CNY',
      breakdown,
    },
  };
}

export interface FixtureOptions {
  readonly totalDays: number;
  readonly startDate?: string;
  readonly planId?: string;
  readonly planVersionId?: string;
  readonly requestId?: string;
}

/** 构造一个结构合法、不触发任何 BLOCKING 违规的 TravelPlan */
export function makeTravelPlanFixture(options: FixtureOptions): TravelPlan {
  const {
    totalDays,
    startDate = '2026-10-01',
    planId = 'plan_fixture',
    planVersionId = 'version_1',
    requestId = 'request_fixture',
  } = options;

  const days = Array.from({ length: totalDays }, (_, i) => buildDay(i + 1, startDate));

  const dailyTotal = days.reduce((acc, d) => acc + d.daily_budget.total, 0);
  const travelerCount = 3;
  const accommodation = totalDays * 320;
  const grandTotal = dailyTotal * travelerCount + accommodation;

  return {
    schema_version: SCHEMA_VERSIONS.travelPlan,
    status: 'READY',
    plan_id: planId,
    plan_version_id: planVersionId,
    request_id: requestId,

    title: `杭州${totalDays}日文化慢游计划`,
    summary: '围绕西湖、运河、人文博物馆和杭帮美食展开。',

    destination: { name: '杭州', place_id: 'cn-hangzhou' },
    start_date: startDate,
    end_date: addDays(startDate, totalDays - 1),
    total_days: totalDays,
    traveler_count: travelerCount,
    currency: 'CNY',

    total_budget: {
      ticket: days.reduce((a, d) => a + d.daily_budget.ticket, 0) * travelerCount,
      transport: days.reduce((a, d) => a + d.daily_budget.transport, 0) * travelerCount,
      meal: days.reduce((a, d) => a + d.daily_budget.meal, 0) * travelerCount,
      accommodation,
      other: days.reduce((a, d) => a + d.daily_budget.other, 0) * travelerCount,
      total: grandTotal,
      per_person: Math.round((grandTotal / travelerCount) * 100) / 100,
      currency: 'CNY',
    },

    days,

    constraint_report: {
      /*
       * 这里的 code 必须与 @tps/planning 的请求 fixture 一一对应：
       * V-30 要求「每个 must_conditions 都出现在 satisfied 中」，
       * 缺一个就是 BLOCKING。两份 fixture 各自「看起来都合法」而配对后
       * 触发 BLOCKING，会让 28 条规则的每个通过用例都因为同一个无关原因失败。
       */
      satisfied: [
        {
          code: 'interest.history_culture',
          mode: 'SHOULD',
          evidence: '每一天都安排了博物馆或历史街区。',
        },
        {
          code: 'accommodation.elevator',
          mode: 'MUST',
          evidence: '推荐的住宿区域均为有电梯的连锁酒店。',
        },
      ],
      violated: [],
      assumptions: [],
    },
  };
}

/** 三档标准 fixture：覆盖单日、中等、SLA 上限（设计稿 21.2 分档） */
export const TRAVEL_PLAN_FIXTURES = {
  oneDay: () => makeTravelPlanFixture({ totalDays: 1 }),
  sevenDays: () => makeTravelPlanFixture({ totalDays: 7 }),
  fourteenDays: () => makeTravelPlanFixture({ totalDays: 14 }),
} as const;
