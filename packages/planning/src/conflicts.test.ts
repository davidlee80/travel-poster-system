import { describe, expect, it } from 'vitest';

import { FIXTURE_TODAY, makeRequestFixture } from './fixtures.js';
import {
  MAX_FLEXIBILITY_DAYS,
  MIN_DAILY_BUDGET_PER_PERSON_CNY,
  REQUEST_RULE_IDS,
  checkRequestConflicts,
  todayInTimezone,
  type RequestRuleId,
} from './conflicts.js';
import { normalizeTravelRequest } from './normalize.js';
import { TEMPLATE_ID_VALUES, type TravelRequestUI } from '@tps/schemas';

/**
 * N-01～N-14（TP-2-05，设计稿 3.1.2；N-13/N-14 是 P9 新增）。
 *
 * 每条规则**一个违规用例 + 基准用例证明它不误报**。
 * 只测违规不够：一条永远为真的检查同样能通过「违规用例」，
 * 而它会拒绝所有合法请求。
 */

function check(ui: TravelRequestUI, today = FIXTURE_TODAY) {
  return checkRequestConflicts(ui, normalizeTravelRequest(ui), {
    todayInRequestTimezone: today,
  });
}

function rules(ui: TravelRequestUI, today = FIXTURE_TODAY): RequestRuleId[] {
  return check(ui, today).map((violation) => violation.rule);
}

describe('基准请求', () => {
  it('不触发任何规则', () => {
    // 这条是全部「违规用例」的前提：基准若本身违规，
    // 任何一条测试的通过都不能证明被测规则起了作用
    expect(check(makeRequestFixture())).toEqual([]);
  });
});

describe('N-01 出发日期不早于今天', () => {
  it('过去日期违规', () => {
    const violations = check(
      makeRequestFixture({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-03-20', end_date: '2026-03-24', flexibility_days: 0 },
        },
      }),
    );

    const n01 = violations.find((v) => v.rule === 'N-01');
    expect(n01?.code).toBe('REQ_START_DATE_IN_PAST');
    expect(n01?.field).toBe('trip.dates.start_date');
  });

  it('今天出发合法', () => {
    // 边界：等于今天不算过去。写成 `<=` 会让「今天出发」被拒，
    // 而那是一个完全合理的请求
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: FIXTURE_TODAY, end_date: '2026-04-03', flexibility_days: 0 },
      },
    });
    expect(rules(ui)).not.toContain('N-01');
  });

  it('按请求时区判定，不按服务器时区', () => {
    /*
     * 用户在 UTC+14（Pacific/Kiritimati）已经是 4 月 2 日，服务器在 UTC
     * 还是 4 月 1 日。若按服务器时区判「今天」，用户选 4 月 2 日出发会
     * 被当成未来（放行，正确）；但用户选 4 月 1 日出发时，
     * 在他自己的日历上已经是过去，应当被拒。
     */
    const at = new Date('2026-04-01T12:00:00Z');
    expect(todayInTimezone('UTC', at)).toBe('2026-04-01');
    expect(todayInTimezone('Pacific/Kiritimati', at)).toBe('2026-04-02');
    // UTC-11 尚未进入 4 月 1 日
    expect(todayInTimezone('Pacific/Niue', at)).toBe('2026-04-01');
    expect(todayInTimezone('Pacific/Niue', new Date('2026-04-01T05:00:00Z'))).toBe('2026-03-31');
  });
});

describe('N-02 返回日期不早于出发日期', () => {
  const inverted = () =>
    makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-08', flexibility_days: 0 },
      },
    });

  it('日期倒置违规', () => {
    const n02 = check(inverted()).find((v) => v.rule === 'N-02');
    expect(n02?.code).toBe('REQ_DATE_RANGE_INVALID');
    expect(n02?.field).toBe('trip.dates.end_date');
  });

  it('同时触发 N-03（两条各指向不同表单项）', () => {
    // 有意的重叠：日期倒置必然导致天数 ≤ 0。两处高亮比一处更清楚
    expect(rules(inverted())).toEqual(expect.arrayContaining(['N-02', 'N-03']));
  });

  it('同一天往返合法', () => {
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-10', flexibility_days: 0 },
      },
    });
    expect(rules(ui)).not.toContain('N-02');
    expect(rules(ui)).not.toContain('N-03');
  });
});

describe('N-03 行程天数 1～14', () => {
  const withDays = (endDate: string) =>
    makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: endDate, flexibility_days: 0 },
      },
      // 天数变化会改变 N-12 的下限，同步放大预算避免误触
      budget: {
        currency: 'CNY',
        basis: 'TOTAL',
        min: 20_000,
        max: 60_000,
        included_items: ['MEALS'],
      },
    });

  it('15 天违规', () => {
    const n03 = check(withDays('2026-04-24')).find((v) => v.rule === 'N-03');
    expect(n03?.code).toBe('REQ_TRIP_DAYS_OUT_OF_RANGE');
  });

  it.each([
    ['2026-04-10', 1],
    ['2026-04-23', 14],
  ])('边界 %s（%i 天）合法', (endDate) => {
    // 上下边界都必须放行。写成 `< 14` 会让 14 天行程被拒，
    // 而 14 天正是 1.1 明确支持的最大值
    expect(rules(withDays(endDate))).not.toContain('N-03');
  });
});

describe('N-04 预算区间', () => {
  it.each([
    [{ min: 0, max: 100 }, 'min 为 0'],
    [{ min: -10, max: 100 }, 'min 为负'],
    [{ min: 200, max: 100 }, 'max 小于 min'],
  ])('%o 违规（%s）', (range) => {
    const ui = makeRequestFixture({
      budget: {
        currency: 'CNY',
        basis: 'TOTAL',
        included_items: ['MEALS'],
        ...range,
      },
    });
    const n04 = check(ui).find((v) => v.rule === 'N-04');
    expect(n04?.code).toBe('REQ_BUDGET_RANGE_INVALID');
    expect(n04?.field).toBe('budget.min');
  });

  it('min 等于 max 合法', () => {
    // 「预算就是 8000」是常见输入，不该被当成区间错误
    const ui = makeRequestFixture({
      budget: {
        currency: 'CNY',
        basis: 'TOTAL',
        min: 8_000,
        max: 8_000,
        included_items: ['MEALS'],
      },
    });
    expect(rules(ui)).not.toContain('N-04');
  });
});

describe('N-05 每日景点区间', () => {
  it.each([
    [{ attractions_per_day_min: 0, attractions_per_day_max: 3 }, 'min 为 0'],
    [{ attractions_per_day_min: 4, attractions_per_day_max: 2 }, 'max 小于 min'],
  ])('%o 违规（%s）', (pace) => {
    const ui = makeRequestFixture({ pace: { level: 'RELAXED', ...pace } });
    const n05 = check(ui).find((v) => v.rule === 'N-05');
    expect(n05?.code).toBe('REQ_PACE_RANGE_INVALID');
  });

  it('min 等于 max 合法', () => {
    const ui = makeRequestFixture({
      pace: { level: 'RELAXED', attractions_per_day_min: 3, attractions_per_day_max: 3 },
    });
    expect(rules(ui)).not.toContain('N-05');
  });

  it('数值缺省时用档位默认值判定，不误报', () => {
    /*
     * 若在标准化之前检查，缺省的数值字段是 undefined，
     * `undefined < 1` 为 false 而 `max < min` 也是 false —— 看起来通过了，
     * 但那是因为比较毫无意义。检查必须发生在标准化之后。
     */
    const ui = makeRequestFixture({ pace: { level: 'PACKED' } });
    expect(rules(ui)).not.toContain('N-05');
  });
});

describe('N-06 出发地与目的地不同', () => {
  it('相同 place_id 违规', () => {
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '杭州', place_id: 'cn-hangzhou' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-12', flexibility_days: 0 },
      },
    });
    const n06 = check(ui).find((v) => v.rule === 'N-06');
    expect(n06?.code).toBe('REQ_ORIGIN_EQUALS_DESTINATION');
  });

  it('文本相同但缺 place_id 时不判定', () => {
    /*
     * 缺 place_id 时无法可靠判断：「杭州」与「杭州市」是同一地点的不同
     * 写法，而反过来同名的不同地点也存在。误报比漏报更糟 ——
     * 用户会看到一条自己既无法理解也无法修正的错误。
     */
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '杭州' },
        destination: { mode: 'FIXED', text: '杭州', allow_multiple_destinations: false },
        dates: { start_date: '2026-04-10', end_date: '2026-04-12', flexibility_days: 0 },
      },
    });
    expect(rules(ui)).not.toContain('N-06');
  });

  it('同名不同 place_id 合法', () => {
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '朝阳', place_id: 'cn-beijing-chaoyang' },
        destination: {
          mode: 'FIXED',
          text: '朝阳',
          place_id: 'cn-liaoning-chaoyang',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-12', flexibility_days: 0 },
      },
    });
    expect(rules(ui)).not.toContain('N-06');
  });
});

describe('N-07 出行人数至少 1', () => {
  it('全部为空违规', () => {
    const ui = makeRequestFixture({ travelers: { adults: 0, children: [], seniors: [] } });
    const n07 = check(ui).find((v) => v.rule === 'N-07');
    expect(n07?.code).toBe('REQ_TRAVELER_COUNT_INVALID');
  });

  it('只有儿童也算有人', () => {
    // adults 为 0 但有儿童时人数为 1，不该被拒 —— 计数口径是三类相加
    const ui = makeRequestFixture({
      travelers: { adults: 0, children: [{ age: 8 }], seniors: [] },
      budget: {
        currency: 'CNY',
        basis: 'TOTAL',
        min: 5_000,
        max: 9_000,
        included_items: ['MEALS'],
      },
    });
    expect(rules(ui)).not.toContain('N-07');
  });
});

describe('N-08 条件 code 在字典内', () => {
  it('未知 code 违规且指向具体下标', () => {
    /*
     * 静默丢弃会让 MUST 约束凭空消失 —— 例如拼错的
     * accessibility.wheelchar，生成出的计划看起来完全正常，
     * 用户要到出行当天才发现没有无障碍安排。
     */
    const ui = makeRequestFixture({
      conditions: [
        { code: 'interest.food', mode: 'SHOULD', value: true },
        // 绕过编译期枚举，模拟从库里重放的历史请求
        { code: 'accessibility.wheelchar' as never, mode: 'MUST', value: true },
      ],
    });

    const n08 = check(ui).find((v) => v.rule === 'N-08');
    expect(n08?.code).toBe('REQ_CONDITION_CODE_UNKNOWN');
    expect(n08?.field).toBe('conditions[1].code');
  });

  it('字典内的 code 全部通过', () => {
    const ui = makeRequestFixture({
      conditions: [
        { code: 'accessibility.wheelchair', mode: 'MUST', value: true },
        { code: 'diet.halal', mode: 'MUST', value: true },
        { code: 'schedule.no_late_night', mode: 'SHOULD', value: true },
      ],
    });
    expect(rules(ui)).not.toContain('N-08');
  });
});

describe('N-09 弹性日期的天数上限（P9 放开）', () => {
  const withFlexibility = (days: number): TravelRequestUI =>
    makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: days },
      },
    });

  it('五档问卷取值都通过', () => {
    /*
     * 规范 7 把日期弹性列为必填字段（固定 / ±1 / ±3 / 整周 / 只定月份），
     * 因此这条规则从「必须为 0」改成「不超过 30」。前端的 FLEXIBILITY_DAYS
     * 折出的正是这五个数 —— 其中任何一个被拒都意味着两处的口径不一致。
     */
    for (const days of [0, 1, 3, 7, 30]) {
      expect(rules(withFlexibility(days)), `弹性 ${days} 天`).not.toContain('N-09');
    }
  });

  it('超过上限违规', () => {
    const n09 = check(withFlexibility(MAX_FLEXIBILITY_DAYS + 1)).find((v) => v.rule === 'N-09');
    expect(n09?.code).toBe('REQ_DATE_FLEXIBILITY_UNSUPPORTED');
    expect(n09?.field).toBe('trip.dates.flexibility_days');
  });
});

describe('N-10 目的地数量 1～5（P9 放开）', () => {
  /** 造一份多城请求。首个目的地必须与 `trip.destination` 一致（陷阱 3）*/
  const withCities = (names: readonly string[]): TravelRequestUI =>
    makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: names[0] ?? '杭州',
          allow_multiple_destinations: names.length > 1,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      },
      planner_profile: { trip: { destinations: names.map((text) => ({ text })) } },
    });

  it('两到五个城市都通过', () => {
    for (const count of [2, 3, 4, 5]) {
      const names = Array.from({ length: count }, (_unused, i) => `城市${i}`);
      expect(rules(withCities(names)), `${count} 个城市`).not.toContain('N-10');
    }
  });

  it('超过五个违规', () => {
    const names = Array.from({ length: 6 }, (_unused, i) => `城市${i}`);
    const n10 = check(withCities(names)).find((v) => v.rule === 'N-10');
    expect(n10?.code).toBe('REQ_MULTI_DESTINATION_UNSUPPORTED');
    expect(n10?.field).toBe('planner_profile.trip.destinations');
  });

  it('标记与实际数量不一致时违规', () => {
    /*
     * 两者不一致有两种走法，都很糟：标了 true 却只发一个城市，模型会以为
     * 还有城市没告诉它；发了三个城市却没标 true，任何按这个布尔分支的下游
     * 只安排第一个城市 —— 而那份计划看起来完全正常。
     */
    const understated = makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: { mode: 'FIXED', text: '东京', allow_multiple_destinations: false },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      },
      planner_profile: { trip: { destinations: [{ text: '东京' }, { text: '京都' }] } },
    });
    const n10 = check(understated).find((v) => v.rule === 'N-10');
    expect(n10?.field).toBe('trip.destination.allow_multiple_destinations');

    const overstated = makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: { mode: 'FIXED', text: '东京', allow_multiple_destinations: true },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      },
      planner_profile: { trip: { destinations: [{ text: '东京' }] } },
    });
    expect(rules(overstated)).toContain('N-10');
  });

  it('没有 planner_profile 的存量请求不受影响', () => {
    /* P8 及之前的客户端不发问卷，它们恒是单目的地且不标 true */
    expect(rules(makeRequestFixture({}))).not.toContain('N-10');
  });

  it('非 FIXED 模式违规（V2 放宽枚举后这条分支才可达）', () => {
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'SUGGESTED' as never,
          text: '江浙一带',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      },
    });
    expect(rules(ui)).toContain('N-10');
  });
});

describe('N-11 模板已注册', () => {
  it('未注册模板违规', () => {
    const ui = makeRequestFixture({
      output_preferences: {
        language: 'zh-CN',
        template_id: 'travel_poster_v9' as never,
        generate_png: true,
        generate_pdf: true,
      },
    });
    const n11 = check(ui).find((v) => v.rule === 'N-11');
    expect(n11?.code).toBe('REQ_TEMPLATE_UNKNOWN');
  });

  it('已注册的样式套件全部通过', () => {
    /*
     * 遍历 `TEMPLATE_ID_VALUES` 而不是写死值（R-85）：新增套件时这条
     * 自动覆盖。写死的后果是新套件上线后 N-11 对它的判定从未被测过，
     * 而那条规则正是「未知模板该不该报错」的唯一关口。
     */
    for (const templateId of TEMPLATE_ID_VALUES) {
      const ui = makeRequestFixture({
        output_preferences: {
          language: 'zh-CN',
          template_id: templateId,
          generate_png: true,
          generate_pdf: true,
        },
      });
      expect(rules(ui), `${templateId} 被误判`).not.toContain('N-11');
    }
  });
});

describe('N-12 预算物理可行', () => {
  const withBudget = (min: number, max: number) =>
    makeRequestFixture({
      budget: { currency: 'CNY', basis: 'TOTAL', min, max, included_items: ['MEALS'] },
    });

  // 基准 fixture：5 天 × 3 人 × 50 = 750
  const floor = 5 * 3 * MIN_DAILY_BUDGET_PER_PERSON_CNY;

  it('低于物理下限违规', () => {
    const n12 = check(withBudget(floor - 1, 10_000)).find((v) => v.rule === 'N-12');
    expect(n12?.code).toBe('REQ_BUDGET_INFEASIBLE');
    expect(n12?.field).toBe('budget.min');
  });

  it('恰好等于下限合法', () => {
    expect(rules(withBudget(floor, 10_000))).not.toContain('N-12');
  });

  it('PER_PERSON_PER_DAY 用折算后的总额比较', () => {
    /*
     * 每人每天 50 元恰好等于下限。若拿未折算的 min（50）直接与
     * 750 比较，这个完全合理的输入会被误判为不可行。
     */
    const ui = makeRequestFixture({
      budget: {
        currency: 'CNY',
        basis: 'PER_PERSON_PER_DAY',
        min: MIN_DAILY_BUDGET_PER_PERSON_CNY,
        max: 500,
        included_items: ['MEALS'],
      },
    });
    expect(rules(ui)).not.toContain('N-12');
  });

  it('天数非法时跳过，不叠加无意义的错误', () => {
    /*
     * 天数为负时右侧下限是负数，比较结果毫无意义。
     * 用户真正需要修的是 N-02/N-03 报出的问题，
     * 多一条「预算不可行」只会误导。
     */
    const ui = makeRequestFixture({
      trip: {
        origin: { text: '上海', place_id: 'cn-shanghai' },
        destination: {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        },
        dates: { start_date: '2026-04-10', end_date: '2026-04-08', flexibility_days: 0 },
      },
    });
    expect(rules(ui)).not.toContain('N-12');
  });

  it('人数非法时同样跳过', () => {
    const ui = makeRequestFixture({ travelers: { adults: 0, children: [], seniors: [] } });
    expect(rules(ui)).not.toContain('N-12');
  });
});

describe('规则集完整性', () => {
  it('N-01～N-14 全部有实现', () => {
    /*
     * 逐条构造违规输入，断言每个规则 ID 至少被触发过一次。
     * 只靠上面分散的用例不足以说明「12 条都实现了」——
     * 少写一条规则时，缺的那条不会有任何测试失败。
     */
    const triggered = new Set<RequestRuleId>();

    const cases: TravelRequestUI[] = [
      // N-01
      makeRequestFixture({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-01-01', end_date: '2026-01-03', flexibility_days: 0 },
        },
      }),
      // N-02 + N-03
      makeRequestFixture({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-04-10', end_date: '2026-04-08', flexibility_days: 0 },
        },
      }),
      // N-04 + N-12
      makeRequestFixture({
        budget: { currency: 'CNY', basis: 'TOTAL', min: 0, max: 10, included_items: ['MEALS'] },
      }),
      // N-05
      makeRequestFixture({
        pace: { level: 'RELAXED', attractions_per_day_min: 0, attractions_per_day_max: 0 },
      }),
      // N-06
      makeRequestFixture({
        trip: {
          origin: { text: '杭州', place_id: 'cn-hangzhou' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-04-10', end_date: '2026-04-12', flexibility_days: 0 },
        },
      }),
      // N-07
      makeRequestFixture({ travelers: { adults: 0, children: [], seniors: [] } }),
      // N-08
      makeRequestFixture({
        conditions: [{ code: 'nope.nope' as never, mode: 'MUST', value: true }],
      }),
      // N-09：超过 30 天上限（3 天在 P9 之后是合法的）
      makeRequestFixture({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 31 },
        },
      }),
      // N-10：标记与实际数量不一致
      makeRequestFixture({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: true,
          },
          dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
        },
      }),
      // N-13：发了问卷但没勾授权
      makeRequestFixture({ planner_profile: { privacy: { save_preferences: true } } }),
      // N-14：跨境行程缺证件三件套
      makeRequestFixture({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: { mode: 'FIXED', text: '东京', allow_multiple_destinations: false },
          dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
        },
        planner_profile: {
          trip: {
            origin: { text: '上海', country: '中国' },
            destinations: [{ text: '东京', country: '日本' }],
          },
          privacy: { trip_processing_consent: true },
        },
      }),
      // N-11
      makeRequestFixture({
        output_preferences: {
          language: 'zh-CN',
          template_id: 'unknown' as never,
          generate_png: true,
          generate_pdf: true,
        },
      }),
    ];

    for (const ui of cases) {
      for (const rule of rules(ui)) triggered.add(rule);
    }

    expect([...triggered].sort()).toEqual([...REQUEST_RULE_IDS]);
  });

  it('每条违规都带 code、field 与 detail', () => {
    // 13.7 要求 field 必填。缺 field 的错误无法在前端高亮，
    // 用户只能对着一句「输入有误」逐项猜
    for (const violation of check(
      makeRequestFixture({ travelers: { adults: 0, children: [], seniors: [] } }),
    )) {
      expect(violation.code).toMatch(/^REQ_/);
      expect(violation.field.length).toBeGreaterThan(0);
      expect(violation.detail.length).toBeGreaterThan(0);
    }
  });
});
