import { TravelPlanSchema, type TravelPlan, type TravelPlanContent } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { makeValidContext, makeValidPlan } from './plan-fixtures.js';
import { hasBlocking, validatePlan, type PlanViolation } from './plan-rules.js';
import {
  MAX_DETERMINISTIC_ROUNDS,
  MAX_REGENERATIONS,
  resolvePlan,
  type RegenerationRequest,
} from './resolve-plan.js';

/**
 * 两级修复的编排与收敛性（TP-2-13，设计稿 3.2.2）。
 *
 * 验收要求是「注入 100 个随机违规计划，全部在上限内收敛或明确 `FAILED`；
 * 无死循环」。这条要求的实质不是「跑得通」，而是**修复动作不会互相拉锯**：
 * V-12 把整日往后平移，可能撞上 V-13 的收尾时间；V-13 删掉末位条目，
 * 又可能跌到 V-10 的景点下限。任意两条规则的修复动作若互为逆操作，
 * 就会出现「改过去、改回来」的振荡，而 3 轮上限会把它伪装成
 * 「偶尔有几个计划修不好」。
 */

type MutablePlan = TravelPlan & Record<string, any>;

const ctx = makeValidContext();

/** 一个「什么都不改」的重生成：模拟模型帮不上忙的最坏情况 */
const uselessRegenerate = async (request: RegenerationRequest): Promise<TravelPlanContent> =>
  Promise.resolve(request.plan);

describe('终止状态', () => {
  it('零违规 → READY，不调用重生成', async () => {
    let calls = 0;
    const result = await resolvePlan(makeValidPlan(), ctx, {
      regenerate: async (request) => {
        calls += 1;
        return Promise.resolve(request.plan);
      },
    });

    expect(result.status).toBe('READY');
    expect(result.violations).toEqual([]);
    expect(result.deterministicRounds).toBe(0);
    expect(calls).toBe(0);
  });

  it('可修复违规 → REPAIRED', async () => {
    const plan = makeValidPlan() as MutablePlan;
    plan.days[0]!.city = '苏州';

    const result = await resolvePlan(plan, ctx);
    expect(result.status).toBe('REPAIRED');
    expect(hasBlocking(result.violations)).toBe(false);
    expect(result.deterministicRounds).toBeGreaterThan(0);
    expect(result.plan.days[0]!.city).toBe('杭州');
  });

  it('结构性 BLOCKING 修不掉且无重生成 → REJECTED + PLAN_REPAIR_EXHAUSTED', async () => {
    const plan = makeValidPlan() as MutablePlan;
    plan.days.pop();

    const result = await resolvePlan(plan, ctx);
    expect(result.status).toBe('REJECTED');
    expect(result.errorCode).toBe('PLAN_REPAIR_EXHAUSTED');
    expect(hasBlocking(result.violations)).toBe(true);
  });

  it('硬约束不满足 → REJECTED + PLAN_HARD_CONSTRAINT_UNSATISFIABLE', async () => {
    /*
     * 16.3 把这个码定为「立即 FAILED，不重试」，而 3.2.1 又要求 V-30 先走
     * LLM 重生成。两者并不矛盾：用完重生成次数仍然满足不了，才断定
     * 「硬约束不可满足」—— 这时重试确实不会改变结果，必须由用户放宽条件。
     * 若这里返回可重试的 PLAN_REPAIR_EXHAUSTED，客户端会反复重试，
     * 每次都调用 LLM，每次都失败，每次都花钱。
     */
    const plan = makeValidPlan() as MutablePlan;
    plan.constraint_report.satisfied = plan.constraint_report.satisfied.filter(
      (entry) => entry.mode !== 'MUST',
    );

    const result = await resolvePlan(plan, ctx, { regenerate: uselessRegenerate });
    expect(result.status).toBe('REJECTED');
    expect(result.errorCode).toBe('PLAN_HARD_CONSTRAINT_UNSATISFIABLE');
    expect(result.regenerations).toBe(MAX_REGENERATIONS);
  });
});

describe('第二级重生成', () => {
  it('帮不上忙时也只调用上限次数', async () => {
    const plan = makeValidPlan() as MutablePlan;
    plan.days.pop();

    let calls = 0;
    const result = await resolvePlan(plan, ctx, {
      regenerate: async (request) => {
        calls += 1;
        return Promise.resolve(request.plan);
      },
    });

    expect(calls).toBe(MAX_REGENERATIONS);
    expect(result.regenerations).toBe(MAX_REGENERATIONS);
    expect(result.status).toBe('REJECTED');
  });

  it('抛错按失败计入次数，不无限重试', async () => {
    // 3.2.2：单次重生成超时 30 秒，超时按失败计入次数
    const plan = makeValidPlan() as MutablePlan;
    plan.days.pop();

    let calls = 0;
    const result = await resolvePlan(plan, ctx, {
      regenerate: () => {
        calls += 1;
        return Promise.reject(new Error('上游超时'));
      },
    });

    expect(calls).toBe(MAX_REGENERATIONS);
    expect(result.status).toBe('REJECTED');
  });

  it('补齐缺失的一天后收敛为 REPAIRED', async () => {
    const plan = makeValidPlan() as MutablePlan;
    plan.days.pop();

    const result = await resolvePlan(plan, ctx, {
      regenerate: async () => Promise.resolve(makeValidPlan()),
    });

    expect(result.status).toBe('REPAIRED');
    expect(result.regenerations).toBe(1);
    expect(result.plan.days).toHaveLength(5);
  });

  it('重生成收到违规清单与上一版计划', async () => {
    const plan = makeValidPlan() as MutablePlan;
    plan.days.pop();

    const seen: RegenerationRequest[] = [];
    await resolvePlan(plan, ctx, {
      regenerate: async (request) => {
        seen.push(request);
        return Promise.resolve(makeValidPlan());
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.attempt).toBe(1);
    expect(seen[0]!.violations.some((v) => v.rule === 'V-01')).toBe(true);
    expect(seen[0]!.plan.days).toHaveLength(4);
    expect(seen[0]!.normalized.total_days).toBe(5);
  });

  it('程序注入的 ID 在重生成后不丢失', async () => {
    /*
     * 6.3：`plan_id` / `plan_version_id` / `request_id` 由程序注入，
     * 模型不产出它们。重生成结果直接替换会把它们抹掉，
     * 而那要到落库时外键报错才会发现。
     */
    const plan = makeValidPlan() as MutablePlan;
    plan.days.pop();

    const result = await resolvePlan(plan, ctx, {
      regenerate: async () => {
        // 模拟模型输出：只有内容字段，没有任何 ID
        const { plan_id: _p, plan_version_id: _v, request_id: _r, ...content } = makeValidPlan();
        return Promise.resolve(content);
      },
    });

    expect(result.plan.plan_id).toBe('plan_fixture');
    expect(result.plan.plan_version_id).toBe('version_1');
    expect(result.plan.request_id).toBe('request_fixture');
  });
});

describe('假设与不变量', () => {
  it('不修改调用方传入的对象', async () => {
    // 排查 REJECTED 版本时需要的正是模型的原始输出
    const plan = makeValidPlan() as MutablePlan;
    plan.days[0]!.city = '苏州';
    const before = JSON.stringify(plan);

    await resolvePlan(plan, ctx);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it('标准化阶段的假设被带入 constraint_report', async () => {
    // 5.1 要求截断必须可见；只留在 normalized_request 里用户永远看不到
    const truncatedCtx = makeValidContext({
      custom_requirements: { raw_text: '博'.repeat(600) },
    });
    const result = await resolvePlan(makeValidPlan(), truncatedCtx);

    const texts = result.plan.constraint_report.assumptions.map((a) => a.text);
    expect(texts.some((text) => text.includes('截断'))).toBe(true);
  });

  it('修不掉的 REPAIRABLE 降级为假设后放行', async () => {
    // 3.2.2：修复失败降级为 assumptions 记录后放行
    const lowBudgetCtx = makeValidContext({ budget: { min: 100, max: 101 } });
    const result = await resolvePlan(makeValidPlan(), lowBudgetCtx);

    expect(result.status).toBe('REPAIRED');
    expect(result.violations.some((v) => v.rule === 'V-21')).toBe(true);
    expect(result.plan.constraint_report.assumptions.map((a) => a.code)).toContain(
      'BUDGET_SCALED_DOWN',
    );
  });

  it('观察者每轮校验都收到通知，收尾只通知一次', async () => {
    const plan = makeValidPlan() as MutablePlan;
    plan.days[0]!.city = '苏州';

    const passes: readonly PlanViolation[][] = [];
    let settled = 0;
    const result = await resolvePlan(plan, ctx, {
      observer: {
        onValidated: (violations) => {
          (passes as PlanViolation[][]).push([...violations]);
        },
        onSettled: () => {
          settled += 1;
        },
      },
    });

    // 首轮 + 修复后至少各一次
    expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(passes[0]!.some((v) => v.rule === 'V-04')).toBe(true);
    expect(settled).toBe(1);
    expect(result.status).toBe('REPAIRED');
  });
});

// ── 收敛性（100 个随机违规计划）──────────────────────────────

/**
 * 确定性伪随机（mulberry32）。
 *
 * 不用 `Math.random()`：失败的那一个计划必须能被原样复现，
 * 否则「100 个里有 1 个不收敛」这种问题只能靠反复跑碰运气。
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Mutator = (plan: MutablePlan, random: () => number) => void;

const pickDay = (plan: MutablePlan, random: () => number): number =>
  Math.floor(random() * plan.days.length);

/**
 * 违规注入池。
 *
 * 覆盖全部三个级别，并**刻意包含互相牵扯的几对**：
 * 平移（V-12）与收尾时间（V-13）、删条目（V-11）与景点下限（V-10）、
 * 下调预算（V-21）与预算下限（V-22）。振荡只会在这些对上出现。
 */
const MUTATORS: readonly Mutator[] = [
  (plan) => {
    plan.days.pop();
  },
  (plan, random) => {
    plan.days.push(structuredClone(plan.days[pickDay(plan, random)]!));
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.day_number = Math.floor(random() * 30);
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.date = '2026-09-09';
  },
  (plan) => {
    plan.start_date = '2026-05-20';
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.city = '绍兴';
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.schedule = [];
  },
  (plan, random) => {
    const schedule = plan.days[pickDay(plan, random)]!.schedule;
    schedule.reverse();
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) item.duration_minutes = Math.floor(random() * 400) - 100;
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) item.end_time = '05:00';
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) item.location.latitude = 1_000 * random();
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) item.estimated_walking_km = random() * 40;
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) {
      item.start_time = '05:30';
      item.end_time = '06:00';
    }
  },
  (plan, random) => {
    const schedule = plan.days[pickDay(plan, random)]!.schedule;
    const item = schedule[schedule.length - 1];
    if (item !== undefined) {
      item.start_time = '21:30';
      item.end_time = '23:50';
      item.duration_minutes = 140;
    }
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.daily_budget.meal = Math.floor(random() * 5_000);
  },
  (plan, random) => {
    plan.total_budget.total = Math.floor(random() * 1_000_000);
  },
  (plan, random) => {
    const day = plan.days[pickDay(plan, random)]!;
    const entry = day.daily_budget.breakdown[0];
    if (entry !== undefined) entry.amount = -random() * 100;
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) item.estimated_cost.amount = random() * 3.14159;
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.theme = '**主题**·未定'.repeat(4);
  },
  (plan, random) => {
    plan.days[pickDay(plan, random)]!.subtitle = '详见 http://example.com/a 与 <b>公告</b>';
  },
  (plan, random) => {
    const day = plan.days[pickDay(plan, random)]!;
    const first = day.food_recommendations[0];
    if (first !== undefined) {
      day.food_recommendations = [first, structuredClone(first), structuredClone(first)];
    }
  },
  (plan, random) => {
    const spot = plan.days[pickDay(plan, random)]!.photo_spots[0];
    if (spot !== undefined) spot.entity_name = '不存在的地点';
  },
  (plan, random) => {
    const route = plan.days[pickDay(plan, random)]!.route_recommendations[0];
    if (route !== undefined) route.nodes = [];
  },
  (plan) => {
    plan.constraint_report.satisfied = plan.constraint_report.satisfied.filter(
      (entry) => entry.mode !== 'MUST',
    );
  },
  (plan) => {
    plan.constraint_report.violated.push({
      code: 'accommodation.elevator',
      mode: 'MUST',
      reason: '无可用房源。',
      severity: 'BLOCKING',
    });
  },
  (plan, random) => {
    const item = plan.days[pickDay(plan, random)]!.schedule[0];
    if (item !== undefined) item.location.name = 'undefined';
  },
];

describe('收敛性（100 个随机违规计划）', () => {
  it('全部在迭代上限内收敛或明确 REJECTED', async () => {
    const maxTotalRounds = MAX_DETERMINISTIC_ROUNDS * (1 + MAX_REGENERATIONS);
    const outcomes = { READY: 0, REPAIRED: 0, REJECTED: 0 };

    for (let seed = 1; seed <= 100; seed += 1) {
      const random = mulberry32(seed);
      const plan = makeValidPlan() as MutablePlan;

      // 每个计划注入 1～4 处随机违规
      const injections = 1 + Math.floor(random() * 4);
      const applied: number[] = [];
      for (let i = 0; i < injections; i += 1) {
        const index = Math.floor(random() * MUTATORS.length);
        applied.push(index);
        MUTATORS[index]!(plan, random);
      }

      const label = `seed=${seed} mutators=[${applied.join(',')}]`;
      const result = await resolvePlan(plan, ctx, { regenerate: uselessRegenerate });

      outcomes[result.status] += 1;

      // 1. 迭代次数不超上限 —— 死循环的直接表现
      expect(result.deterministicRounds, `${label} 轮次超限`).toBeLessThanOrEqual(maxTotalRounds);
      expect(result.regenerations, `${label} 重生成超限`).toBeLessThanOrEqual(MAX_REGENERATIONS);

      // 2. 状态与违规必须自洽
      if (result.status === 'REJECTED') {
        expect(hasBlocking(result.violations), `${label} REJECTED 却无 BLOCKING`).toBe(true);
        expect(result.errorCode, `${label} REJECTED 却无错误码`).not.toBeNull();
      } else {
        expect(hasBlocking(result.violations), `${label} 放行了带 BLOCKING 的计划`).toBe(false);
        expect(result.errorCode, `${label} 非 REJECTED 却带错误码`).toBeNull();
      }

      // 3. 落库前必须仍是一份合法的 TravelPlan（含 REJECTED 版本，它也要落库供排查）
      expect(TravelPlanSchema.safeParse(result.plan).success, `${label} 修复后不满足 schema`).toBe(
        true,
      );

      // 4. 校验结果与最终计划一致 —— 返回的 violations 不能是过期快照
      expect(validatePlan(result.plan, ctx).filter((v) => v.severity === 'BLOCKING')).toEqual(
        result.violations.filter((v) => v.severity === 'BLOCKING'),
      );
    }

    // 样本必须真的覆盖到两种结局，否则这个测试可能什么都没测到
    expect(outcomes.REPAIRED).toBeGreaterThan(0);
    expect(outcomes.REJECTED).toBeGreaterThan(0);
  });

  it('程序化修复是幂等的：达到不动点后不再改动', async () => {
    /*
     * 振荡的判据。若两条规则的修复动作互为逆操作，把已收敛的结果再喂回去
     * 会重新产生改动 —— 而 3 轮上限会把振荡伪装成「偶尔修不好」。
     */
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = mulberry32(seed);
      const plan = makeValidPlan() as MutablePlan;
      const injections = 1 + Math.floor(random() * 4);
      for (let i = 0; i < injections; i += 1) {
        MUTATORS[Math.floor(random() * MUTATORS.length)]!(plan, random);
      }

      const first = await resolvePlan(plan, ctx, { regenerate: uselessRegenerate });
      const second = await resolvePlan(first.plan, ctx, { regenerate: uselessRegenerate });

      expect(JSON.stringify(second.plan), `seed=${seed} 二次修复又产生了改动（存在振荡）`).toBe(
        JSON.stringify(first.plan),
      );
    }
  });
});
