import { toCompact } from '@tps/presentation';
import type { Assumption, TravelPlanContent } from '@tps/schemas';

import {
  BUDGET_MAX_TOLERANCE_RATIO,
  FOOD_MAX_PER_DAY,
  MIN_ROUTE_NODES,
  PLAN_RULES,
  SUBTITLE_MAX_CHARS,
  THEME_MAX_CHARS,
  TITLE_MAX_CHARS,
  WALKING_TOLERANCE_RATIO,
  deriveBudget,
  effectiveWalkingLimitKm,
  latestEndTime,
  round2,
  validatePlan,
  type PlanRuleId,
  type PlanValidationContext,
  type PlanViolation,
} from './plan-rules.js';
import { collectAmountSlots, collectCurrencySlots, collectStringSlots } from './plan-slots.js';
import { normalizeText } from './plan-text.js';
import { dateForDay, minutesToTime, timeToMinutes } from './plan-time.js';

/**
 * 第一级：程序化修复（TP-2-13，设计稿 3.2.2）。
 *
 * 纯函数、无模型调用。处理全部 `REPAIRABLE` 与结构类 `BLOCKING`
 * （V-01 的「多天」方向、V-02、V-03、V-23）。
 *
 * ## 收敛性
 *
 * 3.2.2 说「规则集收敛性由『修复动作只删不增』保证」。这句话对**条目数量**
 * 成立（V-10/V-11/V-13/V-41/V-42/V-43 只删不加），但对**时间**不成立：
 * V-12 把整日行程往后平移，可能因此撞上 V-13 的最晚结束时间；V-13 删掉末位
 * 条目后又可能低于 V-10 的景点下限。这类连锁不是缺陷，而是「用户的节奏偏好
 * 与时间窗互相矛盾」的真实表现 —— 因此终止靠三条：
 *
 *   1. 每一步都单调（时间只往后、条目只减少），不存在 A 改回 B、B 再改回 A；
 *   2. 一轮内不动即为不动点，编排层立即停止（不必等 3 轮跑满）；
 *   3. 3 轮上限兜底。
 *
 * 修不掉的 `REPAIRABLE` 按 3.2.2 降级为 `assumptions` 后放行 —— 那是编排层
 * （resolve-plan.ts）的收尾动作，不在这里。
 */

/** V-07 修复时的最短时长。0 分钟的条目在页面上是一条无意义的空行 */
export const MIN_SCHEDULE_MINUTES = 15;

/** V-21 削减金额的桶顺序（3.2.1：门票 → 其他 → 餐饮） */
const BUDGET_CUT_ORDER = ['TICKET', 'OTHER', 'MEAL'] as const;

export interface RepairResult<T extends TravelPlanContent> {
  readonly plan: T;
  /** 本轮是否真的改动了内容。编排层据此判断是否已到不动点 */
  readonly changed: boolean;
  /** 排查用的动作清单，不面向用户 */
  readonly actions: readonly string[];
}

// ── assumptions ────────────────────────────────────────────

/**
 * 从字段路径里取出「第几天」，用于面向用户的假设文案。
 *
 * `assumptions` 会随计划展示给用户（12.1），因此不能直接把
 * `days[2].schedule[1].end_time` 这种路径给他们看。
 */
function dayPrefix(path: string): string {
  const match = /^days\[(\d+)\]/.exec(path);
  return match === null ? '' : `第 ${Number(match[1]) + 1} 天`;
}

/**
 * 需要写入 `assumptions` 的规则及其面向用户的文案。
 *
 * 只有 3.2.1 明确要求「记入 assumptions」的规则在此：全部 `ADVISORY`
 * （V-14/V-22/V-32/V-33）、以及 V-04 / V-10 下限 / V-21 / V-23。
 * 其余 `REPAIRABLE`（排序、时长重算、四舍五入、文案压缩、清洗）是
 * **静默修正** —— 它们不改变行程的实质内容，逐条告知只会让「系统做了什么
 * 决定」这份清单被噪音淹没，用户反而看不见真正重要的那几条。
 */
interface AssumptionTemplate {
  readonly code: string;
  readonly text: (where: string) => string;
}

/**
 * 用 `Partial<Record<...>>` 而不是全量 switch：这张表的**不完整是有意的**，
 * 只列出会写入假设的 8 条规则。全量 switch 会要求为另外 20 条写
 * `case ... : return null`，而那 20 行不表达任何信息。
 */
const ASSUMPTION_TEMPLATES: Partial<Record<PlanRuleId, AssumptionTemplate>> = {
  'V-04': {
    code: 'CITY_ALIGNED',
    text: (where) => `${where}的城市已按你选择的目的地修正。`,
  },
  'V-10': {
    // 只有「低于下限」会走到这里：超上限已经被删减修复，不留假设
    code: 'PACE_BELOW_MIN',
    text: (where) => `${where}的景点数量少于所选节奏的下限，未强行补足以免行程仓促。`,
  },
  'V-14': {
    code: 'SENIOR_WALKING_LIMIT',
    text: () => '同行有长者，每日步行上限已收紧到 4 公里。',
  },
  'V-21': {
    code: 'BUDGET_SCALED_DOWN',
    text: () => '预估花费超出预算上限，已下调门票、其他与餐饮的预估金额。',
  },
  'V-22': {
    code: 'BUDGET_BELOW_MIN',
    text: () => '预估花费明显低于你的预算下限，可按喜好增加体验项目。',
  },
  'V-23': {
    code: 'CURRENCY_ALIGNED',
    text: () => '金额币种已统一为你选择的币种，未做汇率换算。',
  },
  'V-32': {
    code: 'PREFERENCES_PARTIAL',
    text: () => '部分「尽量满足」的偏好未能全部安排进行程。',
  },
  'V-33': {
    code: 'CHILD_ITEM_MISSING',
    text: (where) => `${where}没有标注适合儿童的安排，带孩子出行时请留意。`,
  },
};

function assumptionFor(rule: PlanRuleId, path: string): { code: string; text: string } | null {
  const template = ASSUMPTION_TEMPLATES[rule];
  if (template === undefined) return null;
  return { code: template.code, text: template.text(dayPrefix(path)) };
}

/**
 * 追加假设，按 `code + text` 去重。
 *
 * 去重是**幂等性要求**而不是优化：修复要跑最多 3 轮，每轮都会重跑规则，
 * 而 `ADVISORY` 违规在修复后依然存在（它们本来就不修）。不去重的话
 * 「同行有长者」会在假设清单里出现三遍。
 */
export function addAssumption(
  plan: TravelPlanContent,
  code: string,
  text: string,
  ruleId: string | null,
): boolean {
  const exists = plan.constraint_report.assumptions.some(
    (entry) => entry.code === code && entry.text === text,
  );
  if (exists) return false;

  const assumption: Assumption = { code, text, rule_id: ruleId };
  plan.constraint_report.assumptions.push(assumption);
  return true;
}

/**
 * 在**修复动作发生的那一刻**记录假设。
 *
 * V-04（覆写城市）与 V-23（覆写币种）的修复会让违规消失，因此不能等修完
 * 再统一从「剩余违规」里推导 —— 那时它们已经不在违规清单里，假设也就永远
 * 记不上。而 3.2.1 对这两条明确写了「记入 assumptions」：用户必须知道
 * 系统改了他的城市或币种。
 */
function recordRepairAssumption(
  plan: TravelPlanContent,
  rule: PlanRuleId,
  path: string,
  actions: string[],
): void {
  const assumption = assumptionFor(rule, path);
  if (assumption === null) return;
  if (addAssumption(plan, assumption.code, assumption.text, rule)) {
    actions.push(`记录假设 ${assumption.code}（${rule}）`);
  }
}

// ── 各规则的修复动作 ────────────────────────────────────────

/**
 * V-44 / V-45：清洗全部字符串。
 *
 * 必填字段清洗后为空时**保持原值不动**：写入空串会让计划不再满足
 * `NonEmptyStringSchema`（落库的 `plan_json` 从此是一份读不回来的数据），
 * 而 V-44 已经把这种情况判为 `BLOCKING` 交给第二级重生成。
 */
function repairStrings(plan: TravelPlanContent, actions: string[]): void {
  for (const slot of collectStringSlots(plan)) {
    const original = slot.get();
    const cleaned = normalizeText(original);
    if (cleaned === original) continue;
    if (slot.required && cleaned.length === 0) continue;

    slot.set(cleaned);
    actions.push(`V-44/V-45 清洗 ${slot.path}`);
  }
}

/**
 * V-02 + V-01（多天方向）+ V-03：结构与日期锚点。
 *
 * 三条一起做，顺序是「按日期排序 → 截断多余尾部 → 重编号 → 重算日期」。
 * 先排序再截断，被截掉的才是日期最靠后的那几天；反过来会随机丢中间某天。
 */
function repairStructure(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const { normalized } = ctx;

  const sorted = [...plan.days].sort((a, b) => a.date.localeCompare(b.date));
  const reordered = sorted.some((day, index) => day !== plan.days[index]);
  if (reordered) {
    plan.days = sorted;
    actions.push('V-02 按日期重排各天');
  }

  if (plan.days.length > normalized.total_days) {
    const dropped = plan.days.length - normalized.total_days;
    plan.days = plan.days.slice(0, normalized.total_days);
    actions.push(`V-01 截断尾部 ${dropped} 天`);
  }

  plan.days.forEach((day, index) => {
    if (day.day_number !== index + 1) {
      day.day_number = index + 1;
      actions.push(`V-02 重编号 days[${index}]`);
    }
    const expected = dateForDay(normalized.start_date, day.day_number);
    if (day.date !== expected) {
      day.date = expected;
      actions.push(`V-03 重算 days[${index}].date`);
    }
    if (day.city !== normalized.destination_name) {
      day.city = normalized.destination_name;
      actions.push(`V-04 覆写 days[${index}].city`);
      recordRepairAssumption(plan, 'V-04', `days[${index}].city`, actions);
    }
  });

  if (plan.start_date !== normalized.start_date) {
    plan.start_date = normalized.start_date;
    actions.push('V-03 覆写 start_date');
  }
  if (plan.end_date !== normalized.end_date) {
    plan.end_date = normalized.end_date;
    actions.push('V-03 覆写 end_date');
  }
  if (plan.total_days !== normalized.total_days) {
    plan.total_days = normalized.total_days;
    actions.push('V-03 覆写 total_days');
  }
}

/** V-08：非法坐标整点置 null，该节点因此退出路线图 */
function repairCoordinates(plan: TravelPlanContent, actions: string[]): void {
  plan.days.forEach((day, d) => {
    day.schedule.forEach((item, s) => {
      const { latitude, longitude } = item.location;
      const badLat = latitude !== null && (latitude < -90 || latitude > 90);
      const badLng = longitude !== null && (longitude < -180 || longitude > 180);
      if (badLat || badLng) {
        item.location.latitude = null;
        item.location.longitude = null;
        actions.push(`V-08 置空 days[${d}].schedule[${s}].location 坐标`);
      }
    });
  });
}

/** V-07：以 `start_time + duration_minutes` 重算结束时间 */
function repairDurations(plan: TravelPlanContent, actions: string[]): void {
  plan.days.forEach((day, d) => {
    day.schedule.forEach((item, s) => {
      const start = timeToMinutes(item.start_time);
      const end = timeToMinutes(item.end_time);

      /*
       * `duration_minutes` 非正时无法据它重算 —— 会得到「结束不晚于开始」，
       * 下一轮 V-07 再报，三轮耗尽。此时改用原时间差（若合理），
       * 否则给一个 15 分钟的地板值。
       */
      let duration = item.duration_minutes;
      if (duration <= 0) {
        duration = end > start ? end - start : MIN_SCHEDULE_MINUTES;
        item.duration_minutes = duration;
        actions.push(`V-07 修正 days[${d}].schedule[${s}].duration_minutes`);
      }

      const expectedEnd = minutesToTime(start + duration);
      if (expectedEnd !== item.end_time) {
        item.end_time = expectedEnd;
        actions.push(`V-07 重算 days[${d}].schedule[${s}].end_time`);
      }
    });
  });
}

/** V-06：按开始时间排序，重叠则后项顺延到前项结束时间 */
function repairOverlaps(plan: TravelPlanContent, actions: string[]): void {
  plan.days.forEach((day, d) => {
    const sorted = [...day.schedule].sort(
      (a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time),
    );
    if (sorted.some((item, index) => item !== day.schedule[index])) {
      day.schedule = sorted;
      actions.push(`V-06 重排 days[${d}].schedule`);
    }

    for (let i = 1; i < day.schedule.length; i += 1) {
      const prev = day.schedule[i - 1]!;
      const current = day.schedule[i]!;
      const prevEnd = timeToMinutes(prev.end_time);
      if (timeToMinutes(current.start_time) < prevEnd) {
        current.start_time = minutesToTime(prevEnd);
        current.end_time = minutesToTime(prevEnd + current.duration_minutes);
        actions.push(`V-06 顺延 days[${d}].schedule[${i}]`);
      }
    }
  });
}

/** V-12：整日平移到最早出发时间之后，保持各条时长 */
function repairEarliestDeparture(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const earliest = timeToMinutes(ctx.normalized.pace.earliest_departure_time);
  plan.days.forEach((day, d) => {
    const first = day.schedule[0];
    if (first === undefined) return;

    const delta = earliest - timeToMinutes(first.start_time);
    if (delta <= 0) return;

    for (const item of day.schedule) {
      const start = timeToMinutes(item.start_time) + delta;
      item.start_time = minutesToTime(start);
      item.end_time = minutesToTime(start + item.duration_minutes);
    }
    actions.push(`V-12 平移 days[${d}].schedule ${delta} 分钟`);
  });
}

/** V-13：压缩末位条目时长，压不下就删除 */
function repairLateEnd(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const limit = timeToMinutes(latestEndTime(ctx.normalized));

  plan.days.forEach((day, d) => {
    while (day.schedule.length > 0) {
      const last = day.schedule[day.schedule.length - 1]!;
      if (timeToMinutes(last.end_time) <= limit) break;

      const start = timeToMinutes(last.start_time);
      if (limit - start >= MIN_SCHEDULE_MINUTES) {
        last.duration_minutes = limit - start;
        last.end_time = minutesToTime(limit);
        actions.push(`V-13 压缩 days[${d}].schedule[${day.schedule.length - 1}] 时长`);
        break;
      }

      /*
       * 不删到空：V-05 要求每日至少一条，删空会把一个 REPAIRABLE
       * 换成一个 BLOCKING，还得再花一次 LLM 重生成才能补回来。
       */
      if (day.schedule.length === 1) break;
      day.schedule.pop();
      actions.push(`V-13 删除 days[${d}] 末位条目`);
    }
  });
}

/** V-11：删除步行距离最大的条目直到进入上限 */
function repairWalking(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const limit = effectiveWalkingLimitKm(ctx.normalized) * WALKING_TOLERANCE_RATIO;

  plan.days.forEach((day, d) => {
    while (day.schedule.length > 1) {
      const total = day.schedule.reduce((acc, item) => acc + item.estimated_walking_km, 0);
      if (total <= limit + 0.005) break;

      let worst = 0;
      day.schedule.forEach((item, index) => {
        if (item.estimated_walking_km > day.schedule[worst]!.estimated_walking_km) {
          worst = index;
        }
      });
      day.schedule.splice(worst, 1);
      actions.push(`V-11 删除 days[${d}].schedule[${worst}]`);
    }
  });
}

/**
 * V-10：超上限时删除最低优先的条目。
 *
 * 3.2.1 的措辞是「按 `estimated_cost` 降序删除末位低优先条目」——
 * 即按花费从高到低排后删末尾，也就是**先删最便宜的**。花得多的通常是
 * 门票类核心项目，删掉它们会把行程削成只剩免费的街区漫步。
 */
function repairAttractionCount(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const max = ctx.normalized.pace.attractions_per_day_max;

  plan.days.forEach((day, d) => {
    while (day.schedule.length > max && day.schedule.length > 1) {
      let cheapest = 0;
      day.schedule.forEach((item, index) => {
        // `<=` 让并列时取更靠后的那条，对应「末位」
        if (item.estimated_cost.amount <= day.schedule[cheapest]!.estimated_cost.amount) {
          cheapest = index;
        }
      });
      day.schedule.splice(cheapest, 1);
      actions.push(`V-10 删除 days[${d}].schedule[${cheapest}]`);
    }
  });
}

/** V-41：餐次去重保留首条，超量截断尾部 */
function repairFood(plan: TravelPlanContent, actions: string[]): void {
  plan.days.forEach((day, d) => {
    const seen = new Set<string>();
    const deduped = day.food_recommendations.filter((food) => {
      if (seen.has(food.meal)) return false;
      seen.add(food.meal);
      return true;
    });

    const trimmed = deduped.slice(0, FOOD_MAX_PER_DAY);
    if (trimmed.length !== day.food_recommendations.length) {
      actions.push(
        `V-41 调整 days[${d}].food_recommendations（${day.food_recommendations.length} → ${trimmed.length}）`,
      );
      day.food_recommendations = trimmed;
    }
  });
}

/** V-42：删除找不到对应行程地点的拍照机位 */
function repairPhotoSpots(plan: TravelPlanContent, actions: string[]): void {
  plan.days.forEach((day, d) => {
    const names = new Set(day.schedule.map((item) => item.location.name));
    const kept = day.photo_spots.filter((spot) => names.has(spot.entity_name));
    if (kept.length !== day.photo_spots.length) {
      actions.push(`V-42 删除 days[${d}] 的 ${day.photo_spots.length - kept.length} 个拍照机位`);
      day.photo_spots = kept;
    }
  });
}

/** V-43：删除节点不足 2 个的路线 */
function repairRoutes(plan: TravelPlanContent, actions: string[]): void {
  plan.days.forEach((day, d) => {
    const kept = day.route_recommendations.filter((route) => route.nodes.length >= MIN_ROUTE_NODES);
    if (kept.length !== day.route_recommendations.length) {
      actions.push(
        `V-43 删除 days[${d}] 的 ${day.route_recommendations.length - kept.length} 条路线`,
      );
      day.route_recommendations = kept;
    }
  });
}

/** V-40：交由 3.2.3 的文案压缩处理超长 */
function repairTextLength(plan: TravelPlanContent, actions: string[]): void {
  const compacted = toCompact(plan.title, TITLE_MAX_CHARS);
  if (compacted !== plan.title) {
    plan.title = compacted;
    actions.push('V-40 压缩 title');
  }

  plan.days.forEach((day, d) => {
    const theme = toCompact(day.theme, THEME_MAX_CHARS);
    if (theme !== day.theme) {
      day.theme = theme;
      actions.push(`V-40 压缩 days[${d}].theme`);
    }
    const subtitle = toCompact(day.subtitle, SUBTITLE_MAX_CHARS);
    if (subtitle !== day.subtitle) {
      day.subtitle = subtitle;
      actions.push(`V-40 压缩 days[${d}].subtitle`);
    }
  });
}

/** V-23：覆写为请求币种，不做汇率换算 */
function repairCurrency(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const expected = ctx.normalized.budget.currency;
  for (const slot of collectCurrencySlots(plan)) {
    if (slot.get() !== expected) {
      slot.set(expected);
      actions.push(`V-23 覆写 ${slot.path}`);
      recordRepairAssumption(plan, 'V-23', slot.path, actions);
    }
  }
}

/** V-24：负数置 0，其余四舍五入到两位小数 */
function repairAmounts(plan: TravelPlanContent, actions: string[]): void {
  for (const slot of collectAmountSlots(plan)) {
    const value = slot.get();
    const fixed = value < 0 ? 0 : round2(value);
    if (fixed !== value) {
      slot.set(fixed);
      actions.push(`V-24 修正 ${slot.path}`);
    }
  }
}

/**
 * V-21：按「门票 → 其他 → 餐饮」顺序下调金额。
 *
 * 3.2.1 还写了「替换对应条目为更低价选项标注」。**这一半不实现**：
 * 程序化修复不可能知道某个景点的「更低价选项」叫什么，编造一个店名或
 * 门票名会让用户看到一个不存在的地方 —— 那比预算数字偏高严重得多。
 * 因此只下调金额，并把下调这件事记入 `assumptions`（见 assumptionFor）。
 */
function repairBudgetCeiling(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  const ceiling = ctx.normalized.budget.total_max * BUDGET_MAX_TOLERANCE_RATIO;
  const travelers = Math.max(1, plan.traveler_count);
  let excess = round2(deriveBudget(plan).total - ceiling);
  if (excess <= 0) return;

  for (const bucket of BUDGET_CUT_ORDER) {
    for (const day of plan.days) {
      for (const entry of day.daily_budget.breakdown) {
        if (excess <= 0) break;
        if (entry.bucket !== bucket || entry.amount <= 0) continue;

        // breakdown 是每人每天金额，对全团总额的贡献要乘人数
        const contribution = round2(entry.amount * travelers);
        const wanted = Math.min(contribution, excess);
        /*
         * 向下取整到两位小数，**不能用四舍五入**：
         * 55 / 3 = 18.3333，四舍五入成 18.33 后实际只削了 54.99，
         * 差的那一分钱让 V-21 在下一轮继续报违规，而每轮都只差一分钱 ——
         * 三轮耗尽后计划带着一条「预算未能完全满足」的假设放行。
         */
        const reduced = Math.max(0, Math.floor((entry.amount - wanted / travelers) * 100) / 100);
        if (reduced === entry.amount) continue;

        excess = round2(excess - (entry.amount - reduced) * travelers);
        entry.amount = reduced;
        actions.push(`V-21 下调 ${bucket} 条目「${entry.label}」`);
        recordRepairAssumption(plan, 'V-21', 'total_budget.total', actions);
      }
    }
  }
}

/** V-20：由 breakdown 与住宿费重算全部派生金额（放在最后，吸收前面所有改动） */
function repairBudgetConsistency(plan: TravelPlanContent, actions: string[]): void {
  const derived = deriveBudget(plan);

  plan.days.forEach((day, d) => {
    const expected = derived.daily[d];
    if (expected === undefined) return;
    const budget = day.daily_budget;
    if (
      budget.ticket !== expected.ticket ||
      budget.transport !== expected.transport ||
      budget.meal !== expected.meal ||
      budget.other !== expected.other ||
      budget.total !== expected.total
    ) {
      budget.ticket = expected.ticket;
      budget.transport = expected.transport;
      budget.meal = expected.meal;
      budget.other = expected.other;
      budget.total = expected.total;
      actions.push(`V-20 重算 days[${d}].daily_budget`);
    }
  });

  const total = plan.total_budget;
  if (
    total.ticket !== derived.ticket ||
    total.transport !== derived.transport ||
    total.meal !== derived.meal ||
    total.other !== derived.other ||
    total.total !== derived.total ||
    total.per_person !== derived.perPerson
  ) {
    total.ticket = derived.ticket;
    total.transport = derived.transport;
    total.meal = derived.meal;
    total.other = derived.other;
    total.total = derived.total;
    total.per_person = derived.perPerson;
    actions.push('V-20 重算 total_budget');
  }
}

/**
 * 把「本轮修复后仍然成立的 ADVISORY 及需要告知的修复」写入 assumptions。
 *
 * 在全部数值修复之后重跑规则，因此 V-22（低于预算下限）看到的是**修复后**
 * 的总额 —— 否则会出现「先因为超上限被下调，又被告知低于下限」这种
 * 自相矛盾的假设清单。
 */
function recordAssumptions(
  plan: TravelPlanContent,
  ctx: PlanValidationContext,
  actions: string[],
): void {
  for (const violation of validatePlan(plan, ctx)) {
    recordRepairAssumption(plan, violation.rule, violation.path, actions);
  }
}

/**
 * 执行一轮程序化修复。
 *
 * 顺序不是随意的：
 *   字符串清洗 → 结构与日期 → 坐标 → 时长 → 重叠 → 平移 → 收尾时间
 *   → 步行 → 景点数 → 内容删减 → 文案长度 → 币种 → 金额 → 预算
 *
 * 三条约束决定了它：
 *   - 清洗放最前：清洗可能把某个必填字段变成空串（那是 BLOCKING），
 *     越早暴露越好；晚放会让后面所有基于文本的判断都跑在未清洗的值上。
 *   - 时间类必须「时长 → 重叠 → 平移 → 收尾」：重叠顺延依赖已经自洽的时长，
 *     平移会制造新的超时，因此收尾时间检查必须在平移之后。
 *   - 预算放最后：删条目不改 breakdown，但下调金额会改，
 *     而 V-20 的重算必须看到最终的 breakdown。
 */
export function repairPlan<T extends TravelPlanContent>(
  plan: T,
  ctx: PlanValidationContext,
): RepairResult<T> {
  const before = JSON.stringify(plan);
  const next = structuredClone(plan);
  const actions: string[] = [];

  repairStrings(next, actions);
  repairStructure(next, ctx, actions);
  repairCoordinates(next, actions);
  repairDurations(next, actions);
  repairOverlaps(next, actions);
  repairEarliestDeparture(next, ctx, actions);
  repairLateEnd(next, ctx, actions);
  repairWalking(next, ctx, actions);
  repairAttractionCount(next, ctx, actions);
  repairFood(next, actions);
  repairPhotoSpots(next, actions);
  repairRoutes(next, actions);
  repairTextLength(next, actions);
  repairCurrency(next, ctx, actions);
  repairAmounts(next, actions);
  repairBudgetCeiling(next, ctx, actions);
  repairBudgetConsistency(next, actions);
  recordAssumptions(next, ctx, actions);

  return { plan: next, changed: JSON.stringify(next) !== before, actions };
}

/** 供编排层为「修不掉的 REPAIRABLE」补一条通用假设（3.2.2 的降级放行） */
export function degradeToAssumption(plan: TravelPlanContent, violation: PlanViolation): boolean {
  const specific = assumptionFor(violation.rule, violation.path);
  if (specific !== null) {
    return addAssumption(plan, specific.code, specific.text, violation.rule);
  }

  const where = dayPrefix(violation.path);
  const scope = where === '' ? '行程' : where;
  return addAssumption(
    plan,
    'RULE_NOT_FULLY_RESOLVED',
    `${scope}的「${PLAN_RULES[violation.rule].title}」未能完全满足。`,
    violation.rule,
  );
}
