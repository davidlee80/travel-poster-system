import { PACE_LEVEL_VALUES } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { makeRequestFixture } from './fixtures.js';
import {
  CUSTOM_TEXT_MAX_CHARS,
  DEFAULT_PACE_LEVEL,
  PACE_DEFAULTS,
  computeBudgetTotals,
  computeTotalDays,
  computeTravelerCount,
  normalizeTravelRequest,
  resolvePace,
  truncateCustomText,
} from './normalize.js';

describe('computeTotalDays（3.1.1）', () => {
  it.each([
    ['2026-04-01', '2026-04-01', 1],
    ['2026-04-01', '2026-04-02', 2],
    ['2026-04-01', '2026-04-14', 14],
    // 跨月、跨年、闰日：手工算天数最容易在这三处出错
    ['2026-04-28', '2026-05-02', 5],
    ['2026-12-30', '2027-01-02', 4],
    ['2028-02-27', '2028-03-01', 4],
  ])('%s → %s 共 %i 天（含首尾）', (start, end, expected) => {
    expect(computeTotalDays(start, end)).toBe(expected);
  });

  it('日期倒置时返回非正数而不是抛错', () => {
    /*
     * 3.1.1 是纯计算，判断交给 N-02/N-03。这里抛错的话，
     * 冲突检查就无法引用 total_days，用户一次只能看到一个错误。
     */
    expect(computeTotalDays('2026-04-10', '2026-04-08')).toBe(-1);
  });

  it('不受夏令时切换影响', () => {
    /*
     * 用本地时区做减法时，夏令时切换日的两天相差 23 或 25 小时，
     * 除以 86400000 后取整会少算一天。这里用 UTC 解析规避。
     * 2026-03-08 是美国夏令时开始日。
     */
    expect(computeTotalDays('2026-03-07', '2026-03-09')).toBe(3);
    // 2026-10-25 是欧洲夏令时结束日
    expect(computeTotalDays('2026-10-24', '2026-10-26')).toBe(3);
  });
});

describe('computeTravelerCount（3.1.1）', () => {
  it.each([
    [{ adults: 2, children: [], seniors: [] }, 2],
    [{ adults: 2, children: [{ age: 7 }], seniors: [] }, 3],
    [{ adults: 1, children: [{ age: 3 }, { age: 9 }], seniors: [{ age: 70 }] }, 4],
    // 0 是合法的计算结果，由 N-07 判定为违规
    [{ adults: 0, children: [], seniors: [] }, 0],
  ])('%o → %i 人', (travelers, expected) => {
    expect(computeTravelerCount(travelers)).toBe(expected);
  });
});

describe('resolvePace（5.1）', () => {
  it('数值字段优先于 level', () => {
    /*
     * 5.1：`level` 与数值字段冲突时**以数值字段为准**。
     * 这条常被写反，写反的后果是用户填的具体数字被档位默认值覆盖，
     * 而界面上显示的仍是用户填的值 —— 生成结果与界面不一致。
     */
    const resolved = resolvePace({
      level: 'PACKED',
      attractions_per_day_min: 1,
      attractions_per_day_max: 2,
      walking_limit_km: 3,
      earliest_departure_time: '10:00',
    });

    expect(resolved).toEqual({
      level: 'PACKED',
      attractions_per_day_min: 1,
      attractions_per_day_max: 2,
      walking_limit_km: 3,
      earliest_departure_time: '10:00',
    });
  });

  it('数值缺省时按 level 取默认值', () => {
    expect(resolvePace({ level: 'BALANCED' })).toEqual({
      level: 'BALANCED',
      ...PACE_DEFAULTS.BALANCED,
    });
  });

  it('部分缺省时逐字段回退', () => {
    // 只填了一个数值字段：该字段用用户值，其余三个用档位默认
    const resolved = resolvePace({ level: 'RELAXED', walking_limit_km: 20 });
    expect(resolved.walking_limit_km).toBe(20);
    expect(resolved.attractions_per_day_min).toBe(PACE_DEFAULTS.RELAXED.attractions_per_day_min);
    expect(resolved.earliest_departure_time).toBe(PACE_DEFAULTS.RELAXED.earliest_departure_time);
  });

  it('level 也缺省时落在中间档', () => {
    // 缺省意味着用户没表达偏好，应落中间档而不是最松的一档
    expect(resolvePace({}).level).toBe(DEFAULT_PACE_LEVEL);
    expect(DEFAULT_PACE_LEVEL).toBe('BALANCED');
  });

  it('5.1 的默认值表逐行正确', () => {
    // 表驱动比对，避免抄错某一个数字 —— 抄错的后果是生成节奏与用户选择不符
    expect(PACE_DEFAULTS).toEqual({
      RELAXED: {
        attractions_per_day_min: 2,
        attractions_per_day_max: 3,
        walking_limit_km: 5,
        earliest_departure_time: '09:00',
      },
      BALANCED: {
        attractions_per_day_min: 3,
        attractions_per_day_max: 4,
        walking_limit_km: 8,
        earliest_departure_time: '08:30',
      },
      PACKED: {
        attractions_per_day_min: 4,
        attractions_per_day_max: 6,
        walking_limit_km: 12,
        earliest_departure_time: '08:00',
      },
    });
  });

  it('每个档位都有默认值', () => {
    // 新增档位漏填默认值时，运行期表现是「每天 0 个景点」
    for (const level of PACE_LEVEL_VALUES) {
      expect(PACE_DEFAULTS[level], `${level} 缺少默认值`).toBeDefined();
      expect(PACE_DEFAULTS[level].attractions_per_day_min).toBeGreaterThan(0);
    }
  });
});

describe('computeBudgetTotals（3.1.1）', () => {
  it('PER_PERSON_PER_DAY 乘人数与天数', () => {
    const totals = computeBudgetTotals(
      { currency: 'CNY', basis: 'PER_PERSON_PER_DAY', min: 800, max: 1500, included_items: [] },
      3,
      5,
    );
    expect(totals).toEqual({ total_min: 800 * 15, total_max: 1500 * 15 });
  });

  it('TOTAL 直接取原值', () => {
    // 折算方向写反（对 TOTAL 也乘人天）会让预算凭空放大十几倍，
    // 而生成出的计划「符合预算」，只是那个预算不是用户想的那个
    const totals = computeBudgetTotals(
      { currency: 'CNY', basis: 'TOTAL', min: 8000, max: 15000, included_items: [] },
      3,
      5,
    );
    expect(totals).toEqual({ total_min: 8000, total_max: 15000 });
  });
});

describe('truncateCustomText（5.1）', () => {
  it('未超长时原样返回并去除首尾空白', () => {
    expect(truncateCustomText('  想看运河  ')).toEqual({ text: '想看运河', truncated: false });
  });

  it('恰好等于上限不截断', () => {
    const text = '博'.repeat(CUSTOM_TEXT_MAX_CHARS);
    expect(truncateCustomText(text)).toEqual({ text, truncated: false });
  });

  it('超长时截断到上限并标记', () => {
    const result = truncateCustomText('博'.repeat(CUSTOM_TEXT_MAX_CHARS + 10));
    expect([...result.text]).toHaveLength(CUSTOM_TEXT_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('按码点计数，不把中文或 emoji 算成两个字', () => {
    /*
     * 用 .length 计数时，辅助平面字符（emoji）占 2 个 UTF-16 码元，
     * 250 个 emoji 就会被判为超长；更糟的是 slice 可能把代理对切一半，
     * 产出一个乱码字符。
     */
    const emoji = '🚤'.repeat(CUSTOM_TEXT_MAX_CHARS);
    const result = truncateCustomText(emoji);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(emoji);

    const over = truncateCustomText('🚤'.repeat(CUSTOM_TEXT_MAX_CHARS + 1));
    expect(over.truncated).toBe(true);
    expect([...over.text]).toHaveLength(CUSTOM_TEXT_MAX_CHARS);
    // 没有半个代理对留在末尾
    expect(over.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('normalizeTravelRequest（3.1.1 整体）', () => {
  it('派生全部字段', () => {
    const normalized = normalizeTravelRequest(makeRequestFixture());

    expect(normalized.total_days).toBe(5);
    expect(normalized.traveler_count).toBe(3);
    expect(normalized.has_child).toBe(true);
    expect(normalized.has_senior).toBe(false);
    expect(normalized.budget.total_min).toBe(800 * 3 * 5);
    expect(normalized.budget.total_max).toBe(1500 * 3 * 5);
  });

  it('按 mode 拆分硬约束与软约束', () => {
    /*
     * 拆分而不是保留混合数组：MUST 不可违反、SHOULD 尽量满足，
     * 而 V-30/V-31 只校验 MUST。混合数组会让每个下游自己过滤一遍，
     * 漏一处就等于把硬约束降级成建议。
     */
    const normalized = normalizeTravelRequest(makeRequestFixture());

    expect(normalized.must_conditions.map((c) => c.code)).toEqual(['accommodation.elevator']);
    expect(normalized.should_conditions.map((c) => c.code)).toEqual(['interest.history_culture']);
  });

  it('截断事实记入 assumptions', () => {
    // 悄悄截掉需求再生成一份「看起来完整」的计划，是最容易让用户
    // 产生错误信任的做法。因此截断必须可见
    const normalized = normalizeTravelRequest(
      makeRequestFixture({ custom_requirements: { raw_text: '博'.repeat(600) } }),
    );

    expect(normalized.assumptions.some((a) => a.includes('截断'))).toBe(true);
  });

  it('节奏档位缺省也记入 assumptions', () => {
    const normalized = normalizeTravelRequest(
      makeRequestFixture({
        pace: {
          level: undefined,
          attractions_per_day_min: undefined,
          attractions_per_day_max: undefined,
          walking_limit_km: undefined,
          earliest_departure_time: undefined,
        },
      }),
    );

    expect(normalized.pace.level).toBe(DEFAULT_PACE_LEVEL);
    expect(normalized.assumptions.some((a) => a.includes('节奏'))).toBe(true);
  });

  it('无假设时 assumptions 为空数组而不是 undefined', () => {
    // 下游会 push「无历史参考」（3.2.4），undefined 会让那里崩
    expect(normalizeTravelRequest(makeRequestFixture()).assumptions).toEqual([]);
  });

  it('place_id 缺省时不写入该字段（而不是写 undefined）', () => {
    /*
     * exactOptionalPropertyTypes 下 `{ place_id: undefined }` 与
     * 「没有这个键」是不同的类型。写成前者会让 JSON.stringify 产出
     * `"place_id":null`，而库里存的 normalized_request 从此带一个 null 字段 ——
     * 后续读取时 `place_id !== undefined` 为真，逻辑随之走错分支。
     */
    const normalized = normalizeTravelRequest(
      makeRequestFixture({
        trip: {
          origin: { text: '某小镇' },
          destination: { mode: 'FIXED', text: '另一小镇', allow_multiple_destinations: false },
          dates: { start_date: '2026-04-10', end_date: '2026-04-12', flexibility_days: 0 },
        },
      }),
    );

    expect('origin_place_id' in normalized).toBe(false);
    expect('destination_place_id' in normalized).toBe(false);
    expect(JSON.stringify(normalized)).not.toContain('place_id');
  });
});
