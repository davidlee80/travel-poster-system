import { makeTravelPlanFixture, type TravelPlan, type TravelRequestUI } from '@tps/schemas';

import { makeRequestFixture, type RequestFixtureOverrides } from './fixtures.js';
import { normalizeTravelRequest } from './normalize.js';
import type { PlanValidationContext } from './plan-rules.js';

/**
 * 「请求 + 计划」配对 fixture（TP-2-12 测试用）。
 *
 * 28 条规则里有 11 条要拿计划跟**请求**比（天数、日期、目的地、节奏、预算、
 * 硬约束……）。因此单独一份合法计划是不够的 —— 必须有一对彼此匹配的
 * 请求与计划，否则每条规则的「通过用例」都会因为另一条规则的违规而失败，
 * 而那种失败最容易被读成「规则实现错了」。
 *
 * 本模块的唯一职责：产出一对**零违规**的请求与计划。任何一条规则的违规
 * 用例都从这里克隆后只改一处。
 */

export const FIXTURE_PLAN_START_DATE = '2026-04-10';
export const FIXTURE_PLAN_DAYS = 5;

/**
 * 与计划 fixture 的花费量级匹配的预算。
 *
 * 请求 fixture 默认是 800～1500 元／人／天，而计划 fixture 的日均花费只有
 * 105 元／人 —— 两者配对会触发 V-22（总额低于预算下限的 60%）。
 * 那条违规是**真的**（这份行程确实远低于该预算），但它会污染其余 27 条
 * 规则的通过用例。因此这里把预算调到与行程内容相称的区间。
 */
const FIXTURE_BUDGET = { min: 100, max: 400 } as const;

export function makeValidRequest(overrides: RequestFixtureOverrides = {}): TravelRequestUI {
  return makeRequestFixture({
    ...overrides,
    budget: { ...FIXTURE_BUDGET, ...overrides.budget },
  });
}

/** 与 `makeValidPlan()` 配对的标准化请求 */
export function makeValidContext(overrides: RequestFixtureOverrides = {}): PlanValidationContext {
  return { normalized: normalizeTravelRequest(makeValidRequest(overrides)) };
}

/** 一份对 `makeValidContext()` 零违规的计划 */
export function makeValidPlan(): TravelPlan {
  return makeTravelPlanFixture({
    totalDays: FIXTURE_PLAN_DAYS,
    startDate: FIXTURE_PLAN_START_DATE,
  });
}
