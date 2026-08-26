import type { BudgetIncludedItem } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { makeValidContext, makeValidPlan } from './plan-fixtures.js';
import { comparableTotal, deriveBudget, validatePlan } from './plan-rules.js';
import { repairPlan } from './repair-plan.js';

/**
 * 预算口径对齐（`budget.included_items`）。
 *
 * ## 这组断言防的是什么
 *
 * 用户在第 3 步勾「这笔预算包含哪些项目」。若他不勾住宿（已经订好、住亲友家），
 * 而 V-21 仍拿一个含房费的总额去比一个不含房费的上限，就会判超预算，
 * `repair-plan.ts` 随即去砍门票与餐饮 —— 计划本来合规，被削掉的是用户真正想要的。
 *
 * ## 夹具的基线数字
 *
 * `makeValidPlan()` + `makeValidContext()`：3 人 5 天，
 * `total_budget` = 门票 0 / 交通 375 / 餐饮 1050 / 住宿 1600 / 其他 150 = **3175**，
 * 契约默认口径是 `[ACCOMMODATION, MEALS, LOCAL_TRANSPORT, TICKETS]`。
 * 下面每条用例都从这几个数推，不另造夹具 —— 另造一份就要自己维持它对
 * 28 条规则零违规，而那是 `makeValidPlan` 已经保证的事。
 */

const DEFAULT_SCOPE: readonly BudgetIncludedItem[] = [
  'ACCOMMODATION',
  'MEALS',
  'LOCAL_TRANSPORT',
  'TICKETS',
];

/** 夹具的派生总额，供各条用例做算术 */
const BASE = deriveBudget(makeValidPlan());

describe('comparableTotal 按口径折算', () => {
  it('默认口径下与 deriveBudget().total 逐字相同', () => {
    /*
     * 这是「可选新增不破存量」的落点：不改口径的请求走到的比较必须与从前
     * 一模一样。数值相等还不够 —— 用 `BASE.total` 而不是硬写 3175，
     * 这样夹具金额哪天变了，这条断言仍然在断言「两者相同」。
     */
    expect(comparableTotal(makeValidPlan(), DEFAULT_SCOPE)).toBe(BASE.total);
  });

  it('不含住宿时精确扣掉住宿费', () => {
    const scope: BudgetIncludedItem[] = ['MEALS', 'LOCAL_TRANSPORT', 'TICKETS'];
    expect(comparableTotal(makeValidPlan(), scope)).toBe(BASE.total - BASE.accommodation);
  });

  it('不含餐饮时扣掉餐饮', () => {
    const scope: BudgetIncludedItem[] = ['ACCOMMODATION', 'LOCAL_TRANSPORT', 'TICKETS'];
    expect(comparableTotal(makeValidPlan(), scope)).toBe(BASE.total - BASE.meal);
  });

  it('大交通与市内交通都不含时整桶扣掉，不需要拆', () => {
    const scope: BudgetIncludedItem[] = ['ACCOMMODATION', 'MEALS', 'TICKETS'];
    expect(comparableTotal(makeValidPlan(), scope)).toBe(BASE.total - BASE.transport);
  });

  it('多项叠加时逐项扣除，而「其他」桶恒在口径内', () => {
    /*
     * 只含餐饮：住宿、门票、两种交通都扣掉，剩下餐饮 + **其他**。
     * `included_items` 里没有「其他」这一项，因此 `other` 桶永远扣不掉 ——
     * 这不是遗漏：那个桶装的是杂项开支，任何口径下都算在总额里。
     */
    const scope: BudgetIncludedItem[] = ['MEALS'];
    expect(comparableTotal(makeValidPlan(), scope)).toBe(BASE.meal + BASE.other);
  });
});

describe('两个可选字段缺省读作 0', () => {
  it('不含大交通、而计划没声明 intercity_transport → 不扣', () => {
    /*
     * 这正是**契约默认口径**的情形（默认不含往返大交通），因此它必须等于
     * 「什么都不扣」。读成「不知道」的话，每一份默认请求都要带一句
     * 「无法区分往返大交通与市内交通」的说明 —— 一句 100% 出现的废话，
     * 放在告知「签证未核验」的同一个位置上。
     */
    const scope: BudgetIncludedItem[] = ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'];
    const plan = makeValidPlan();
    expect(plan.total_budget.intercity_transport).toBeUndefined();
    expect(comparableTotal(plan, scope)).toBe(BASE.total);
  });

  it('声明了 intercity_transport 就按它扣', () => {
    const plan = makeValidPlan();
    plan.total_budget.intercity_transport = 200;
    const scope: BudgetIncludedItem[] = ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'];
    expect(comparableTotal(plan, scope)).toBe(BASE.total - 200);
  });

  it('只不含市内交通时，扣的是交通桶减去大交通那部分', () => {
    const plan = makeValidPlan();
    plan.total_budget.intercity_transport = 100;
    const scope: BudgetIncludedItem[] = [
      'ACCOMMODATION',
      'MEALS',
      'TICKETS',
      'INTERCITY_TRANSPORT',
    ];
    expect(comparableTotal(plan, scope)).toBe(BASE.total - (BASE.transport - 100));
  });

  it('声明了 shopping 且口径不含购物时扣掉它', () => {
    const plan = makeValidPlan();
    plan.total_budget.shopping = 50;
    expect(comparableTotal(plan, DEFAULT_SCOPE)).toBe(BASE.total - 50);
  });

  it('口径含购物时不扣，即使声明了金额', () => {
    const plan = makeValidPlan();
    plan.total_budget.shopping = 50;
    const scope: BudgetIncludedItem[] = [...DEFAULT_SCOPE, 'SHOPPING'];
    expect(comparableTotal(plan, scope)).toBe(BASE.total);
  });
});

describe('V-21 / V-22 按口径判定', () => {
  /** 夹具默认 `basis: PER_PERSON_PER_DAY`，因此 max 要按「每人每天」给 */
  function contextWithBudget(
    perPersonPerDayMax: number,
    scope?: readonly BudgetIncludedItem[],
  ): ReturnType<typeof makeValidContext> {
    const ctx = makeValidContext({ budget: { min: 1, max: perPersonPerDayMax } });
    if (scope === undefined) return ctx;
    /*
     * 就地改 `included_items` 而不是给 `makeValidRequest` 传 —— 那条路径要
     * 走一遍 normalize 的折算，而这里要固定的恰恰是折算之后的 total_max。
     * 改的是一份刚构造出来的对象，不影响其他用例。
     */
    return {
      ...ctx,
      normalized: {
        ...ctx.normalized,
        budget: { ...ctx.normalized.budget, included_items: [...scope] },
      },
    };
  }

  it('含住宿口径下超上限 → V-21', () => {
    /* 上限 100/人/天 × 3 人 × 5 天 = 1500，容差后 1650 < 3175 */
    const violations = validatePlan(makeValidPlan(), contextWithBudget(100));
    expect(violations.some((v) => v.rule === 'V-21')).toBe(true);
  });

  it('同一份计划、同一个上限，不含住宿时不再超 → 无 V-21', () => {
    /*
     * 这一条是整轮改动的核心：3175 − 1600 = 1575 < 1650。
     * 改动前它会报 V-21，然后 repair 去砍门票餐饮。
     */
    const scope: BudgetIncludedItem[] = ['MEALS', 'LOCAL_TRANSPORT', 'TICKETS'];
    const violations = validatePlan(makeValidPlan(), contextWithBudget(100, scope));
    expect(violations.some((v) => v.rule === 'V-21')).toBe(false);
  });

  it('不含住宿时下限也按同一口径 → V-22', () => {
    /*
     * 下限 min=1 时不会触发 V-22，因此这条用 makeValidContext 的默认下限区间。
     * 默认 total_min = 1500，60% = 900；扣掉住宿后 1575 仍高于 900 →
     * 不该报。把住宿与餐饮都扣掉（525）才低于 900。
     */
    const noAccommodationOrMeals: BudgetIncludedItem[] = ['LOCAL_TRANSPORT', 'TICKETS'];
    const ctx = makeValidContext();
    const narrowed = {
      ...ctx,
      normalized: {
        ...ctx.normalized,
        budget: { ...ctx.normalized.budget, included_items: noAccommodationOrMeals },
      },
    };
    const violations = validatePlan(makeValidPlan(), narrowed);
    expect(violations.some((v) => v.rule === 'V-22')).toBe(true);
  });
});

describe('V-20 的子集一致性', () => {
  it('intercity_transport 超过交通桶时报违规', () => {
    const plan = makeValidPlan();
    plan.total_budget.intercity_transport = BASE.transport + 1;
    const violations = validatePlan(plan, makeValidContext());
    expect(
      violations.some((v) => v.rule === 'V-20' && v.path === 'total_budget.intercity_transport'),
    ).toBe(true);
  });

  it('shopping 超过其他桶时报违规', () => {
    const plan = makeValidPlan();
    plan.total_budget.shopping = BASE.other + 1;
    const violations = validatePlan(plan, makeValidContext());
    expect(violations.some((v) => v.rule === 'V-20' && v.path === 'total_budget.shopping')).toBe(
      true,
    );
  });

  it('负数金额同样报违规 —— schema 只要求 finite', () => {
    const plan = makeValidPlan();
    plan.total_budget.shopping = -1;
    const violations = validatePlan(plan, makeValidContext());
    expect(violations.some((v) => v.rule === 'V-20' && v.path === 'total_budget.shopping')).toBe(
      true,
    );
  });

  it('恰好等于所属桶时通过 —— 全部金额都属于那一类是合法的', () => {
    const plan = makeValidPlan();
    plan.total_budget.intercity_transport = BASE.transport;
    const violations = validatePlan(plan, makeValidContext());
    expect(
      violations.some((v) => v.rule === 'V-20' && v.path === 'total_budget.intercity_transport'),
    ).toBe(false);
  });

  it('两个字段都缺省时不产生任何 V-20 违规', () => {
    const violations = validatePlan(makeValidPlan(), makeValidContext());
    expect(violations.filter((v) => v.rule === 'V-20')).toEqual([]);
  });
});

describe('修复与校验用同一个基准', () => {
  it('口径外的桶不被削 —— 削它对可比总额毫无影响', () => {
    /*
     * 用户口径只含住宿与市内交通（不含门票、不含餐饮）。可比总额 =
     * 住宿 1600 + 交通 375 = 1975，上限给 40/人/天 → 600，容差后 660，超支。
     *
     * 削减顺序是「门票 → 其他 → 餐饮」，而这三者**全部在口径之外**
     * （其他桶恒在口径内，因为 included_items 里没有「其他」这一项）。
     * 因此本轮只能削「其他」那 150。
     *
     * 这条断言盯的是「门票与餐饮一分钱没动」：削它们既减不掉超支，
     * 又实实在在拿掉了用户想要的东西。
     */
    const scope: BudgetIncludedItem[] = ['ACCOMMODATION', 'LOCAL_TRANSPORT'];
    const ctx = makeValidContext({ budget: { min: 1, max: 40 } });
    const narrowed = {
      ...ctx,
      normalized: {
        ...ctx.normalized,
        budget: { ...ctx.normalized.budget, included_items: scope },
      },
    };

    const before = makeValidPlan();
    const mealBefore = before.total_budget.meal;
    const result = repairPlan(before, narrowed);

    const meals = result.plan.days.flatMap((day) =>
      day.daily_budget.breakdown.filter((entry) => entry.bucket === 'MEAL'),
    );
    expect(meals.every((entry) => entry.amount > 0)).toBe(true);
    expect(result.plan.total_budget.meal).toBe(mealBefore);
  });

  it('口径内的桶照旧被削 —— 默认口径的行为一个字不变', () => {
    const ctx = makeValidContext({ budget: { min: 1, max: 40 } });
    const result = repairPlan(makeValidPlan(), ctx);
    expect(result.actions.some((action) => action.startsWith('V-21 下调'))).toBe(true);
  });
});
