import { describe, expect, it } from 'vitest';

import { makeRequestFixture } from './fixtures.js';
import { prepareTravelRequest } from './prepare-request.js';

/**
 * 请求预处理入口（3.1）。
 *
 * 关注三步的**顺序与失败形态**，各步内部的正确性由 normalize.test.ts
 * 与 conflicts.test.ts 覆盖。
 */

/** 与 fixture 的 2026-04-10 出发日配套：此刻早于出发日，N-01 不触发 */
const NOW = new Date('2026-04-01T02:00:00Z');

describe('prepareTravelRequest', () => {
  it('合法请求返回标准化结果', () => {
    const result = prepareTravelRequest(makeRequestFixture(), { now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.total_days).toBe(5);
      expect(result.normalized.schema_version).toBe('normalized_travel_request_v1');
    }
  });

  it('结构错误返回 REQ_SCHEMA_INVALID 与字段路径', () => {
    /*
     * 结构性错误无法给出业务语义的 field —— 连字段都读不出来。
     * 但至少要指出**哪个路径**解析失败，否则客户端只能看到
     * 「请求格式不正确」而无从下手。
     */
    const result = prepareTravelRequest(
      { ...makeRequestFixture(), budget: { currency: 'USD' } },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('REQ_SCHEMA_INVALID');
      expect(result.field).toMatch(/^budget/);
      // 结构失败时不跑冲突检查 —— 那些检查依赖读得出来的字段
      expect(result.violations).toEqual([]);
    }
  });

  it('完全不是对象也不抛异常', () => {
    // 入口要能接住任意 unknown：抛异常会变成 500，而这是 400
    for (const raw of [null, undefined, 42, 'x', []]) {
      const result = prepareTravelRequest(raw, { now: NOW });
      expect(result.ok).toBe(false);
    }
  });

  it('业务冲突返回具体码并带全部违规', () => {
    const result = prepareTravelRequest(
      makeRequestFixture({ travelers: { adults: 0, children: [], seniors: [] } }),
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('REQ_TRAVELER_COUNT_INVALID');
      expect(result.field).toBe('travelers.adults');
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('多条冲突时 code 取第一条，列表完整', () => {
    /*
     * 13.7 的错误体只有一个 code，而客户端要靠它分支。取声明顺序的第一条
     * 而不是「最严重」的一条：N-01～N-12 之间没有严重度差别（全部 400
     * 且不可重试），而「最严重」需要一套排序规则 —— 那套规则会成为
     * 第二个真相源。完整列表在 violations 里，前端可高亮全部出错项。
     */
    const result = prepareTravelRequest(
      makeRequestFixture({
        trip: {
          origin: { text: '杭州', place_id: 'cn-hangzhou' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: true,
          },
          /* 弹性 31 天超过 P9 的上限 30，因此仍然触发 N-09（5 天在 P9 之后是合法的）*/
          dates: { start_date: '2026-04-12', end_date: '2026-04-10', flexibility_days: 31 },
        },
      }),
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rules = result.violations.map((violation) => violation.rule);
      expect(rules).toEqual(expect.arrayContaining(['N-02', 'N-03', 'N-06', 'N-09', 'N-10']));
      // 第一条按 checkRequestConflicts 的声明顺序，即 N-02
      expect(result.violations[0]!.rule).toBe('N-02');
      expect(result.code).toBe(result.violations[0]!.code);
    }
  });

  it('N-01 的判定用请求时区，而不是服务器时区', () => {
    /*
     * 此刻 UTC 是 2026-04-01T23:30，Asia/Shanghai 已经是 04-02。
     * 用户选 04-01 出发，在自己的日历上已是过去，必须被拒 ——
     * 若按 UTC 判定则会放行，用户拿到一份出发日已过的计划。
     */
    const lateNight = new Date('2026-04-01T23:30:00Z');
    const result = prepareTravelRequest(
      makeRequestFixture({
        timezone: 'Asia/Shanghai',
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-04-01', end_date: '2026-04-03', flexibility_days: 0 },
        },
      }),
      { now: lateNight },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.rule)).toContain('N-01');
    }
  });
});
