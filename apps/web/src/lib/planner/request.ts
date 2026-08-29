import {
  SCHEMA_VERSIONS,
  type BudgetBasis,
  type BudgetIncludedItem,
  type ConditionCode,
  type Currency,
  type ExistingBooking,
  type PaceLevel,
  type PlannerProfileInput,
  type PlannerStance,
  type TravelRequestUIInput,
} from '@tps/schemas';

import { conditionToContract } from '../travel-request-form';
import type { PlannerState } from './state';

/**
 * 九步问卷 → `TravelRequestUI`（规范 21.2 的可追溯提交）。
 *
 * ## 一份请求体里有两套东西
 *
 * `planner_profile` 是**答案的逐字记录**；`trip` / `travelers` / `budget` /
 * `pace` / `conditions` / `custom_requirements` 是**投影**，喂给 P1～P8 已经
 * 建好的生成链路（N-01～N-12、V-30/V-32、Prompt 渲染）。两者都发：
 *
 *   - 投影让既有链路一行不改仍然工作；
 *   - 逐字记录让 76 个 field_id 各自有独立 binding，且 `source_field_id`
 *     能指回具体字段。
 *
 * ## 投影是有损的，而每一处损失都写在注释里
 *
 * 「餐厅预订」与「接送」两种已有订单类型在 P8 的 `ExistingBooking` 里没有对应值；
 * 「人均总预算」在 P8 只有「人均每天」与「全程总额」两种口径。这类损失**不会
 * 让信息消失** —— 原值仍在 `planner_profile` 里，由 P9-6 的 `constraints.ts`
 * 读出来进 Prompt。这里记下来是为了让下一个人不必反推「为什么少了两项」。
 *
 * ## 为什么不在这里做本地必填校验
 *
 * 「能不能生成」由 `buildSnapshot` 的 `tripState` 与 `blockers` 决定
 * （规范 5.3、18），而那是状态层已经算好的东西。在这里再实现一遍会造出
 * 第二套判定，而两套不一致的表现是「按钮说可以生成，点了被拒」。
 */

// ── 声明式映射表 ────────────────────────────────────────────

/**
 * 日期弹性 → `flexibility_days`。
 *
 * 「只定月份」折成 30 天而不是「无上限」：`flexibility_days` 是一个整数，
 * 表达不了「没有具体日期」。这是本轮可做到的最接近的表达，而
 * `planner_profile.trip.date_flexibility` 保留了原始语义 ——
 * 后台真要做「月内选窗口」时读它，而不是从 30 这个数字反推。
 */
const FLEXIBILITY_DAYS: Record<string, number> = {
  FIXED: 0,
  PLUS_MINUS_1: 1,
  PLUS_MINUS_3: 3,
  WHOLE_WEEK: 7,
  MONTH_ONLY: 30,
};

/**
 * 步行量档位 → 每日公里上限。
 *
 * `OVER_12KM` 取 15 而不是无上限：`walking_limit_km` 参与 V-20 的每日校验，
 * 而没有上限意味着那条校验对这档用户完全失效 —— 一个愿意走 12 km 以上的人
 * 仍然不想走 40 km。
 */
const WALKING_LIMIT_KM: Record<string, number> = {
  UP_TO_3KM: 3,
  KM_3_TO_5: 5,
  KM_5_TO_8: 8,
  KM_8_TO_12: 12,
  OVER_12KM: 15,
};

/**
 * 行动能力 → 每日公里上限的**封顶值**。
 *
 * 字段表对步行量那一列写着「不与行动能力冲突；若冲突取更保守值」。取更保守值
 * 而不是报冲突：这两个字段问的是不同的事（「你愿意走多少」与「你能走多少」），
 * 而一个说「愿意走 12 km」同时说「不能久站」的用户没有自相矛盾 ——
 * 他只是不知道我们会把前者当成上限。
 */
const MOBILITY_WALKING_CAP: Record<string, number> = {
  LESS_WALKING: 4,
  NO_LONG_STANDING: 6,
  AVOID_STAIRS: 8,
  FREQUENT_REST: 5,
};

/** 每日核心项目数 → `attractions_per_day_min/max`。`SYSTEM` 不投影（交给系统就是不设约束）*/
const ATTRACTIONS_PER_DAY: Record<string, readonly [number, number]> = {
  ONE: [1, 1],
  TWO_TO_THREE: [2, 3],
  FOUR_TO_FIVE: [4, 5],
  AS_MANY: [5, 8],
};

/**
 * 五档节奏 → P8 的三档 `PaceLevel`。
 *
 * 1–2 → 慢，3 → 均衡，4–5 → 紧凑。压缩是有损的（「躺平」与「轻松」压成同一档），
 * 因此 `pace.intensity` 同时发原始的 1–5 值 —— 契约 5.1 规定
 * 「数值字段与 level 冲突时以数值为准」，因此下游拿到的是未压缩的那个。
 */
function paceLevelOf(level: number | undefined): PaceLevel {
  if (level === undefined) return 'BALANCED';
  if (level <= 2) return 'RELAXED';
  return level >= 4 ? 'PACKED' : 'BALANCED';
}

/**
 * 年龄段 → 代表年龄。
 *
 * P8 的 `TravelerChildSchema.age` 是**必填**的 0～17 整数，而 V2 的年龄段是
 * 可选的具体年龄 + 必填的档位。用户没填具体年龄时必须给一个数，
 * 因此这里用档位的代表值。取值理由：
 *
 *   - `INFANT` 取 1 —— 婴幼儿票价与设施规则的分界通常在 2 岁；
 *   - `CHILD` 取 8 —— 儿童票的常见区间是 3～11 岁，取中值；
 *   - `TEEN` 取 15 —— 12～17，取中值。
 *
 * 具体年龄一旦填了就用填的（见 `projectTravelers`），因此这些代表值只在
 * 「用户跳过了具体年龄」时生效，而那时任何数都是估计 ——
 * 与其留空让 schema 拒掉整个请求，不如给一个档内合理值。
 */
const AGE_BAND_REPRESENTATIVE: Record<string, number> = {
  INFANT: 1,
  CHILD: 8,
  TEEN: 15,
};

/**
 * 旅行档次 → 每人每天预算区间。
 *
 * ## 为什么这张表存在，尽管字段表说「档次不绑定固定人民币/天」
 *
 * `budget.min` / `budget.max` 在契约里是**必填**的，而 V2 允许用户回答
 * 「只知道档次」或「暂时没概念」。字段表那句话的下半句是「金额由目的地动态
 * 估算」，而目的地物价估算器不在本轮范围内（也不在任何已有模块里）。
 *
 * 三条选择：让这类用户无法生成、把 min/max 改成可选（N-12 随即会因为
 * 「每人每天 0 元」拒掉请求）、或给一个声明式的档位区间。只有第三条能
 * 交付一份可生成的请求，因此选它 —— 并且：
 *
 *   1. 区间按币种查表，不做汇率换算（与 P9-6 的 N-12 每币种下限同性质）；
 *   2. `planner_profile.budget.mode` 保留了「用户其实没给金额」这件事，
 *      P9-6 的 `normalize.ts` 据此往 `assumptions` 里记一条 ——
 *      规范要求「系统替你做了什么决定」对用户可见，而 assumptions 会随计划返回。
 *
 * 数值取常见目的地的中位区间，且**只区分档位**，不区分目的地 ——
 * 假装能区分目的地会让这张表看起来比它实际更权威。
 */
export const TIER_PER_PERSON_PER_DAY: Record<
  Currency,
  Record<string, readonly [number, number]>
> = {
  CNY: {
    ECONOMY: [300, 600],
    COMFORT: [600, 1_200],
    QUALITY: [1_200, 2_500],
    LUXURY: [2_500, 6_000],
  },
  JPY: {
    ECONOMY: [6_000, 12_000],
    COMFORT: [12_000, 25_000],
    QUALITY: [25_000, 50_000],
    LUXURY: [50_000, 120_000],
  },
  USD: { ECONOMY: [50, 100], COMFORT: [100, 200], QUALITY: [200, 400], LUXURY: [400, 900] },
  EUR: { ECONOMY: [45, 90], COMFORT: [90, 180], QUALITY: [180, 350], LUXURY: [350, 800] },
  GBP: { ECONOMY: [40, 80], COMFORT: [80, 160], QUALITY: [160, 320], LUXURY: [320, 700] },
  HKD: {
    ECONOMY: [350, 700],
    COMFORT: [700, 1_400],
    QUALITY: [1_400, 2_800],
    LUXURY: [2_800, 6_500],
  },
};

/** 档次缺省时按「舒适型」估算 —— 它是四档里的中位，猜错的幅度最小 */
const DEFAULT_TIER = 'COMFORT';

/**
 * 已有订单类型 → P8 的 `ExistingBooking`。
 *
 * `RESTAURANT` 与 `TRANSFER` 没有对应值，因此不进投影。它们不会消失 ——
 * `planner_profile.trip.locked_orders` 里逐条记着，P9-6 的 `constraints.ts`
 * 把每一张不可改退的订单派生成一条 LOCKED 约束进 Prompt。
 * 往 `EXISTING_BOOKING_VALUES` 里加两个成员是另一种做法，代价是改动
 * P8 的枚举而下游（Prompt 的 `describeBookings`）并不区分这五类。
 */
const EXISTING_BOOKING_OF: Record<string, ExistingBooking> = {
  INTERCITY_TRANSPORT: 'INTERCITY_TRANSPORT',
  LODGING: 'LODGING',
  TICKETS: 'TICKETS',
};

/**
 * 饮食方式 → 条件码。
 *
 * `OTHER` 不进这张表：它的内容在 `other_text` 里，是自由文本。
 * 硬塞一个码会让「其他：不吃牛肉」变成一个查不到标签的条件，
 * 而 N-08 会以 `REQ_CONDITION_CODE_UNKNOWN` 拒掉整个请求。
 */
const DIET_CODE_OF: Record<string, ConditionCode> = {
  VEGETARIAN: 'diet.vegetarian',
  VEGAN: 'diet.vegan',
  HALAL: 'diet.halal',
  KOSHER: 'diet.kosher',
  NO_SPICY: 'diet.no_spicy',
  ALCOHOL_FREE: 'diet.alcohol_free',
};

/** 行动能力 → 无障碍码。`NORMAL` 不产出条件 —— 「正常活动」不是一个需要满足的约束 */
const MOBILITY_CODE_OF: Record<string, ConditionCode> = {
  LESS_WALKING: 'accessibility.low_walking',
  NO_LONG_STANDING: 'accessibility.low_walking',
  AVOID_STAIRS: 'accommodation.elevator',
  FREQUENT_REST: 'accessibility.low_walking',
};

/** 儿童需求 → 条件码。`KIDS_MEAL` / `OTHER` 没有对应码，留在 planner_profile 里 */
const CHILD_NEED_CODE_OF: Record<string, ConditionCode> = {
  STROLLER_ACCESS: 'accessibility.stroller',
  CAR_SEAT: 'accessibility.child_car_seat',
  FIXED_NAP: 'schedule.daily_rest',
  FAMILY_ROOM: 'accommodation.family_room',
};

/** 健康与无障碍需求 → 条件码。其余四项是功能性描述，没有对应码 */
const HEALTH_NEED_CODE_OF: Record<string, ConditionCode> = {
  WHEELCHAIR_OR_WALKER: 'accessibility.wheelchair',
  NO_LONG_STANDING: 'accessibility.low_walking',
};

// ── 条件投影 ────────────────────────────────────────────────

interface ProjectedCondition {
  readonly code: ConditionCode;
  readonly mode: 'MUST' | 'SHOULD';
  readonly value: boolean;
}

/**
 * 同一个 code 被多处派生时留哪一条。
 *
 * 数字小 = 优先。顺序照规范 4.1 的运行时优先级：`HARD > EXCLUDE > PREFER`。
 * 也就是说「必须有电梯」压过「不要电梯」——
 * 看起来反直觉，但这两条同时出现只可能来自两个不同来源（一个是三态标签上的
 * 明确排除，另一个是从「不能上台阶」派生的硬需求），而那时**安全侧优先**。
 * 界面上那个被压过的排除标签仍然显示着用户选的态，因此他能看到并改。
 *
 * 去重本身是必须的：N-08 会拒掉重复 code（`REQ_CONDITION_CODE_DUPLICATE`），
 * 而 `accessibility.low_walking` 有三个派生来源。
 */
function precedenceOf(condition: ProjectedCondition): number {
  if (condition.mode === 'MUST') return condition.value ? 0 : 1;
  return 2;
}

function stanceConditions(
  selections: readonly { readonly code: string; readonly stance: PlannerStance }[] | undefined,
): readonly ProjectedCondition[] {
  return (selections ?? []).map((entry) =>
    conditionToContract(entry.code as ConditionCode, entry.stance),
  );
}

/** 从一张映射表投影一组枚举值。域为 `accessibility` / `diet` 时 `conditionToContract` 自动升 MUST */
function mapped(
  values: readonly string[] | undefined,
  table: Record<string, ConditionCode>,
  stance: PlannerStance,
): readonly ProjectedCondition[] {
  return (values ?? []).flatMap((value) => {
    const code = table[value];
    return code === undefined ? [] : [conditionToContract(code, stance)];
  });
}

/**
 * 76 字段 → `conditions[]`。
 *
 * 只投影**有对应条件码**的答案。没有对应码的答案（过敏原名称、必去清单、
 * 想去/不要的自由文本、工作时段）不硬塞码 —— 一个字典外的 code 会让 N-08
 * 拒掉整个请求，而它们由 P9-6 的 `constraints.ts` 以 `RuntimeConstraint`
 * 的形式进 Prompt。
 */
export function projectConditions(answers: PlannerProfileInput): readonly ProjectedCondition[] {
  const out: ProjectedCondition[] = [];

  /* 四组三态标签：用户的态直接就是契约的 mode/value */
  out.push(...stanceConditions(answers.transport?.intercity_modes));
  out.push(...stanceConditions(answers.transport?.local_modes));
  out.push(...stanceConditions(answers.lodging?.types));
  out.push(...stanceConditions(answers.lodging?.amenities));
  out.push(...stanceConditions(answers.budget?.scope_and_priorities?.priorities));

  /*
   * 兴趣主题：PREFER。Top 3 的排序在 conditions[] 里表达不了（没有 rank），
   * 因此它只进 planner_profile 与 P9-6 的约束清单。
   *
   * `as ConditionCode`：契约里 `interests.tags` 的**输入**类型是 `string`
   * （`ConditionCodeSchema` 是带 transform 的正则，为的是让配置中心能发布
   * 七个既有域下的新码 —— 见 `conditions.ts`）。写死联合会让新发布的标签
   * 在前端被拒。字典外的码由服务端的 N-08 以精确错误码拦住，
   * 那是这条断言的兜底。
   */
  for (const code of answers.interests?.tags ?? []) {
    out.push(conditionToContract(code as ConditionCode, 'PREFER'));
  }

  /* 饮食：REQUIRE。`conditionToContract` 对 diet 域本来就强制 MUST，
   * 这里显式传 REQUIRE 是为了让读者不必去查那个函数 */
  out.push(...mapped(answers.food?.dietary_requirements?.values, DIET_CODE_OF, 'REQUIRE'));

  /* 无障碍与照护：同样是 MUST 域 */
  const mobility = answers.travelers?.mobility_level;
  out.push(...mapped(mobility === undefined ? [] : [mobility], MOBILITY_CODE_OF, 'REQUIRE'));
  out.push(...mapped(answers.travelers?.child_needs?.values, CHILD_NEED_CODE_OF, 'REQUIRE'));
  out.push(
    ...mapped(answers.special?.health_accessibility_needs?.values, HEALTH_NEED_CODE_OF, 'REQUIRE'),
  );

  /* 房型含家庭房 / 连通房 → 家庭房码。连通房在 P8 没有码，留给 constraints.ts */
  if ((answers.lodging?.room_configuration ?? []).some((room) => room.bed_type === 'FAMILY')) {
    out.push(conditionToContract('accommodation.family_room', 'REQUIRE'));
  }

  /* 位置优先级里的「交通便利」是唯一有对应码的一项 */
  if ((answers.lodging?.location_priorities ?? []).includes('TRANSIT_CONVENIENT')) {
    out.push(conditionToContract('accommodation.near_transit', 'PREFER'));
  }

  /*
   * 「一次都不换酒店」→ 单一落脚点（HARD）。
   *
   * 规范 10 明确「由后台推导路线结构，不要求用户懂中心辐射等术语」，
   * 而 `accommodation.single_base` 正是那个推导结果。只有 `ZERO` 投影 ——
   * 「最多换 1 次」不是单点，把它也算进去会让双中心行程被硬约束拦掉。
   */
  if (answers.pace?.hotel_change_tolerance === 'ZERO') {
    out.push(conditionToContract('accommodation.single_base', 'REQUIRE'));
  }

  /* 固定午休 */
  if (answers.pace?.rest_window?.enabled === true) {
    out.push(conditionToContract('schedule.daily_rest', 'REQUIRE'));
  }

  /* 避免深夜抵达 */
  if (answers.transport?.time_preferences?.avoid_late_night_arrival === true) {
    out.push(conditionToContract('schedule.no_late_night', 'REQUIRE'));
  }

  /*
   * 转机容忍度 → `transport.avoid_transfer`。
   *
   * 「只接受直飞」是硬约束（REQUIRE），「最多 1 次转机」是偏好（PREFER）——
   * 后者本身允许转机，用 MUST 会让所有带转机的方案被 V-30 拒掉。
   * 「可多次转机」不产出条件：它是放宽而不是约束。
   */
  const transfer = answers.transport?.flight_constraints?.transfer_tolerance;
  if (transfer === 'DIRECT_ONLY')
    out.push(conditionToContract('transport.avoid_transfer', 'REQUIRE'));
  else if (transfer === 'DIRECT_PREFERRED' || transfer === 'MAX_ONE_TRANSFER') {
    out.push(conditionToContract('transport.avoid_transfer', 'PREFER'));
  }

  /* 排除项里「多次转机」与「夜间长途」有对应码，其余五项留给 constraints.ts */
  const exclusions = answers.risk?.exclusions ?? [];
  if (exclusions.includes('MULTI_TRANSFER')) {
    out.push(conditionToContract('transport.avoid_transfer', 'REQUIRE'));
  }
  if (exclusions.includes('OVERNIGHT_GROUND') || exclusions.includes('RED_EYE_FLIGHT')) {
    out.push(conditionToContract('schedule.no_late_night', 'REQUIRE'));
  }

  return dedupe(out);
}

function dedupe(conditions: readonly ProjectedCondition[]): readonly ProjectedCondition[] {
  const best = new Map<ConditionCode, ProjectedCondition>();
  for (const condition of conditions) {
    const current = best.get(condition.code);
    if (current === undefined || precedenceOf(condition) < precedenceOf(current)) {
      best.set(condition.code, condition);
    }
  }
  return [...best.values()];
}

// ── 各块投影 ────────────────────────────────────────────────

interface ProjectedTravelers {
  readonly adults: number;
  readonly children: readonly { readonly age: number }[];
  readonly seniors: readonly { readonly age?: number }[];
}

/**
 * 旅行者卡 → P8 的 adults / children / seniors。
 *
 * 没有卡片时全部按成人算：`travelers.count` 是必填且阻塞的，而卡片可能还没填完。
 * 把人数丢掉（adults: 0）会让 N-xx 报「至少 1 位成人」，
 * 而用户明明在第 2 步填了人数。
 */
export function projectTravelers(answers: PlannerProfileInput): ProjectedTravelers {
  const profiles = answers.travelers?.profiles ?? [];
  const count = answers.travelers?.count ?? profiles.length;
  if (profiles.length === 0) return { adults: Math.max(1, count), children: [], seniors: [] };

  let adults = 0;
  const children: { age: number }[] = [];
  const seniors: { age?: number }[] = [];

  for (const profile of profiles) {
    const representative = AGE_BAND_REPRESENTATIVE[profile.age_band];
    if (representative !== undefined) {
      /* 填了具体年龄就用它；`min(17)` 是 P8 的结构性上限 */
      children.push({ age: Math.min(17, profile.age ?? representative) });
      continue;
    }
    if (profile.age_band === 'SENIOR') {
      seniors.push(profile.age === undefined ? {} : { age: profile.age });
      continue;
    }
    adults += 1;
  }

  /*
   * 卡片比人数少时按人数补足成人。
   *
   * 规范 8 允许用户改了人数还没填完卡片就往下走，而 P8 的 `adults` 决定
   * 预算折算与房间推导 —— 按 2 张卡片算一个 4 人行程会让预算差一倍。
   */
  const filled = adults + children.length + seniors.length;
  if (filled < count) adults += count - filled;

  return { adults, children, seniors };
}

interface ProjectedBudget {
  readonly currency?: Currency;
  readonly basis: BudgetBasis;
  readonly min: number;
  readonly max: number;
  readonly tier?: 'ECONOMY' | 'STANDARD' | 'QUALITY' | 'LUXURY';
  /**
   * PV2-03-006 的「这笔预算包含哪些项目」。
   *
   * 用户没勾时省略，由契约填 `DEFAULT_BUDGET_ITEMS`（住宿 / 餐饮 / 市内交通 / 门票）。
   * 勾了就必须发 —— 见 `projectBudget` 里那段说明。
   */
  /*
   * 可变数组而不是 `readonly`：`TravelRequestUIInput` 那一侧是 Zod 推出来的
   * 可变类型，`readonly` 赋不进去。这里就地展开成新数组（见 `projectBudget`），
   * 因此不存在把 `planner_profile` 里那份数组的引用漏出去的问题。
   */
  readonly included_items?: BudgetIncludedItem[];
}

/** V2 的四档 → P8 的四档。P8 的 `STANDARD` 是「舒适」的旧译名，`CUSTOM` 在 V2 不存在 */
const P8_TIER_OF: Record<string, 'ECONOMY' | 'STANDARD' | 'QUALITY' | 'LUXURY'> = {
  ECONOMY: 'ECONOMY',
  COMFORT: 'STANDARD',
  QUALITY: 'QUALITY',
  LUXURY: 'LUXURY',
};

/**
 * 预算 → P8 的 basis / min / max / tier。
 *
 * 四种模式各自的口径：
 *
 * | V2 模式      | P8 basis             | min/max 来源                        |
 * | ------------ | -------------------- | ----------------------------------- |
 * | `TOTAL`      | `TOTAL`              | 目标区间原样                        |
 * | `PER_PERSON` | `TOTAL`              | 目标区间 × 人数（**不是**每天）     |
 * | `TIER`       | `PER_PERSON_PER_DAY` | 档位表                              |
 * | `UNKNOWN`    | `PER_PERSON_PER_DAY` | 档位表（档次缺省时按舒适型）        |
 *
 * `PER_PERSON` 折成总额而不是「人均每天」：V2 的「人均总预算」是**整趟**的
 * 人均，而 P8 的 `PER_PERSON_PER_DAY` 是每人**每天**。直接当成后者会让预算
 * 被乘上天数 —— 一个 8000 元人均总预算的 7 天行程会变成 56000。
 */
export function projectBudget(
  answers: PlannerProfileInput,
  travelerCount: number,
): ProjectedBudget {
  const currency: Currency = answers.budget?.currency ?? 'CNY';
  const mode = answers.budget?.mode;
  const range = answers.budget?.target_range;
  const tier = answers.budget?.travel_tier;
  const p8Tier = tier === undefined ? undefined : P8_TIER_OF[tier];

  /*
   * 预算口径**必须发**。
   *
   * 本文件头部曾写着「`included_items` 刻意不发 —— 值与 schema 默认值逐字相同」，
   * 那句话在 P8 成立（那个表单没有这个输入），但 P9 加了 PV2-03-006 之后就不成立了：
   * 契约默认值 `DEFAULT_BUDGET_ITEMS` 只有 4 项（住宿 / 餐饮 / 市内交通 / 门票），
   * 而问卷有 6 项 —— 用户取消勾选住宿（已订好、住亲友家）或勾上往返大交通与购物，
   * 都与默认不同。
   *
   * 不发的后果不是「少一个字段」而是**口径分叉**：`planner_profile` 那一份是发的，
   * `constraints.ts` 会把它渲染成 FACT 约束进 Prompt，于是模型按用户口径算总额；
   * 而 `normalized.budget.included_items` 拿的是默认值，V-21/V-22 按默认口径比上限。
   * 用户说「预算含机票」，模型把机票算进去，V-21 判超预算，repair 去砍门票餐饮。
   *
   * 空数组不发：契约的 `.min(1)` 会拒掉它，而「一项都不含」不是用户会有意表达的意思
   * （那样 min/max 就没有含义了）。
   */
  const scope = answers.budget?.scope_and_priorities?.included_items ?? [];
  const includedItems = scope.length > 0 ? { included_items: [...scope] } : {};

  if ((mode === 'TOTAL' || mode === 'PER_PERSON') && range !== undefined) {
    const factor = mode === 'PER_PERSON' ? Math.max(1, travelerCount) : 1;
    return {
      ...(answers.budget?.currency === undefined ? {} : { currency }),
      basis: 'TOTAL',
      min: range.min * factor,
      max: range.max * factor,
      ...(p8Tier === undefined ? {} : { tier: p8Tier }),
      ...includedItems,
    };
  }

  const table = TIER_PER_PERSON_PER_DAY[currency];
  const estimated = table[tier ?? DEFAULT_TIER] ?? table[DEFAULT_TIER];
  /*
   * `?? [0, 0]` 是给 `noUncheckedIndexedAccess` 的：`DEFAULT_TIER` 一定在表里
   * （四个档位每个币种都有，由 `request.test.ts` 断言），因此这条回退取不到。
   * 写 `!` 断言也能过编译，但那会让「哪天有人删了一个档位」变成运行期崩溃。
   */
  const [min, max] = estimated ?? [0, 0];
  return {
    ...(answers.budget?.currency === undefined ? {} : { currency }),
    basis: 'PER_PERSON_PER_DAY',
    min,
    max,
    ...(p8Tier === undefined ? {} : { tier: p8Tier }),
    ...includedItems,
  };
}

interface ProjectedPace {
  readonly level: PaceLevel;
  readonly intensity?: number;
  readonly attractions_per_day_min?: number;
  readonly attractions_per_day_max?: number;
  readonly walking_limit_km?: number;
  readonly earliest_departure_time?: string;
}

export function projectPace(answers: PlannerProfileInput): ProjectedPace {
  const pace = answers.pace;
  const activities = pace?.core_activities_per_day;
  const perDay = activities === undefined ? undefined : ATTRACTIONS_PER_DAY[activities];

  /* 步行上限取「愿意走」与「能走」的较小值（字段表：若冲突取更保守值）*/
  const willing =
    pace?.walking_tolerance === undefined ? undefined : WALKING_LIMIT_KM[pace.walking_tolerance];
  const mobility = answers.travelers?.mobility_level;
  const cap = mobility === undefined ? undefined : MOBILITY_WALKING_CAP[mobility];
  const walking =
    willing === undefined ? cap : cap === undefined ? willing : Math.min(willing, cap);

  return {
    level: paceLevelOf(pace?.level),
    ...(pace?.level === undefined ? {} : { intensity: pace.level }),
    ...(perDay === undefined
      ? {}
      : { attractions_per_day_min: perDay[0], attractions_per_day_max: perDay[1] }),
    ...(walking === undefined ? {} : { walking_limit_km: walking }),
    ...(pace?.daily_window?.start === undefined
      ? {}
      : { earliest_departure_time: pace.daily_window.start }),
  };
}

// ── 提交前的清洗与盖章 ──────────────────────────────────────

/**
 * 提交前对答案树做三件事：剔空占位行、补自报日期、补确认时间。
 *
 * ## 为什么在一份结构克隆上就地改，而不是逐层展开重建
 *
 * 逐层展开（`{...answers, trip: {...trip, destinations: […]}}`）在
 * `exactOptionalPropertyTypes` 之下会为每一层都产出一个「可选属性拿到了
 * `T | undefined`」的类型错误，而消掉它们要在九处各写一遍
 * `...(x === undefined ? {} : { x })`。那不是类型安全，那是把三条简单规则
 * 埋进 60 行三目运算里 —— 而埋进去之后「哪几个列表会被剔空」再也看不出来。
 *
 * 因此改成：JSON 往返做一份克隆（答案树全部是 JSON 安全的标量、数组与对象），
 * 然后按下面两张**声明式的表**处理。JSON 往返顺带做了一件正确的事：
 * 丢掉值为 `undefined` 的键 —— 契约里那些键要么有值要么不存在。
 */

type Mutable = Record<string, unknown>;

/**
 * 需要剔除空占位行的列表。
 *
 * 「添加一个目的地」会先插入一个 `{ text: '' }` 的空行让用户填 —— 这是正常的
 * 编辑中间态。但契约里 `text` 是 `NonEmptyStringSchema`，带着空行提交会被
 * `REQ_SCHEMA_INVALID` 拒，而那个错误码定位不到任何表单项。
 *
 * `key` 为 `null` 表示这是一个字符串数组（品牌、想去、不要），
 * 否则表示「这一行的这个键为空就算空行」。
 *
 * 只剔**结构上非法**的空值，不做业务判断：一张只填了名称的订单卡不会被剔
 * （它合法但不完整，由 `validation.ts` 在界面上提示）。
 */
const PRUNE_EMPTY: readonly { readonly path: readonly string[]; readonly key: string | null }[] = [
  { path: ['trip', 'destinations'], key: 'text' },
  { path: ['trip', 'locked_orders'], key: 'name' },
  { path: ['interests', 'must_do'], key: 'text' },
  { path: ['interests', 'wish_and_exclude', 'wish'], key: null },
  { path: ['interests', 'wish_and_exclude', 'exclude'], key: null },
  { path: ['lodging', 'class_and_brand', 'brands'], key: null },
  { path: ['shopping', 'intent', 'brands_or_categories'], key: null },
  { path: ['special', 'work_constraints', 'items'], key: 'when_text' },
  { path: ['pretrip', 'loyalty_programs'], key: 'brand' },
];

/**
 * 包在 `user_reported` 里、需要盖自报日期的五个字段（规范 4.3）。
 *
 * 在提交时盖而不是在控件里：`reported_on` 的语义是「用户把这条自报**交出去**的
 * 那一天」，供后台判断这条自报是否已经过期。每次按键写一个 `new Date()`
 * 会把它变成「最后一次编辑的时间」，也会让 reducer 变成非纯函数
 * （见 `field-io.ts` 的同类说明）。
 */
const REPORTED_PATHS: readonly (readonly string[])[] = [
  ['transport', 'self_drive'],
  ['documents', 'passport_status'],
  ['documents', 'visa_status'],
  ['insurance', 'status'],
  ['special', 'medication_status'],
];

/** 沿路径取一个对象。中途取不到就返回 undefined —— 那个块用户没填过 */
function at(root: Mutable, path: readonly string[]): Mutable | undefined {
  let node: unknown = root;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Mutable)[segment];
  }
  return typeof node === 'object' && node !== null && !Array.isArray(node)
    ? (node as Mutable)
    : undefined;
}

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * 提交前的答案树。
 *
 * `today` / `now` 由调用方传入而不是这里现取 —— 纯函数才能被穷举测试，
 * 而「盖了什么时间戳」正是要被测的东西。
 */
export function prepareProfile(
  answers: PlannerProfileInput,
  today: string,
  now: string,
): PlannerProfileInput {
  /*
   * 一处受控的断言。放弃的是「这棵树的形状仍然匹配契约」的编译期校验 ——
   * `JSON.parse` 的返回类型是 `any`，而下面三段循环按运行期字符串路径改它。
   *
   * 三段循环都不改变形状：剔行只让数组变短，盖章只往已存在的对象里加一个
   * 契约里声明过的可选键。形状本身由 `request.test.ts` 拿
   * `TravelRequestUISchema` 实际解析一遍来保证 —— 那比类型检查更强，
   * 因为它同时验证了枚举值与长度上限。
   */
  const clone = JSON.parse(JSON.stringify(answers)) as Mutable;

  for (const rule of PRUNE_EMPTY) {
    const parent = at(clone, rule.path.slice(0, -1));
    const leaf = rule.path[rule.path.length - 1];
    if (parent === undefined || leaf === undefined) continue;
    const list = parent[leaf];
    if (!Array.isArray(list)) continue;
    parent[leaf] = list.filter((row) =>
      rule.key === null
        ? !blank(row)
        : typeof row === 'object' && row !== null && !blank((row as Mutable)[rule.key]),
    );
  }

  for (const path of REPORTED_PATHS) {
    const node = at(clone, path);
    /*
     * 只在**已经有自报内容**且还没盖过章时盖。
     *
     * 没有 `user_reported` 的节点不该被盖章：那意味着用户根本没回答这个字段，
     * 而一个只有 `reported_on` 的对象会被 schema 拒（`user_reported` 必填），
     * 也会让 `hasValue` 把它算成「已回答」。
     */
    if (node === undefined || node['user_reported'] === undefined) continue;
    if (node['reported_on'] === undefined) node['reported_on'] = today;
  }

  const snapshot = at(clone, ['review', 'constraints_snapshot']);
  if (snapshot !== undefined && snapshot['acknowledged_at'] === undefined) {
    snapshot['acknowledged_at'] = now;
  }

  return clone;
}

// ── 出口 ────────────────────────────────────────────────────

export interface BuildPlannerRequestOptions {
  readonly clientRequestId: string;
  readonly timezone: string;
  /** `YYYY-MM-DD`。只用于 `reported_on`，不参与任何业务判断 */
  readonly today: string;
  /** ISO 8601 时刻。只用于 `acknowledged_at` */
  readonly now: string;
}

/**
 * 九步答案 → 请求体。
 *
 * ## 目的地为什么发两处
 *
 * `travel_requests` 表有 `destination_name VARCHAR(200) NOT NULL` 与
 * `destination_place_id` 两个**提取列**，若干 CHECK 约束依赖它们。因此
 * `trip.destination`（单个）必须发，而多城序列在
 * `planner_profile.trip.destinations` 里。两者由 `TravelRequestUISchema` 的
 * `superRefine` 断言一致 —— 不一致时报带 `field` 的错误而不是静默取其一。
 *
 * ## `output_preferences` / `locale` 刻意不发
 *
 * 它们的值与 schema 默认值逐字相同（见 `travel-request-form.ts` 的同类说明）。
 *
 * **`included_items` 不在这一类里。** 这里原来把它也列为「不发」，理由是同一句
 * 「与默认值逐字相同」—— 那句话是从 P8 的表单注释抄过来的，在那里成立，
 * 而 P9 加了 PV2-03-006（6 个可勾选项，契约默认只有 4 项）之后就不成立了。
 * 现在它照 `projectBudget` 里的说明如实发出。
 */
export function buildPlannerRequest(
  state: PlannerState,
  options: BuildPlannerRequestOptions,
): TravelRequestUIInput {
  const answers = prepareProfile(state.answers, options.today, options.now);
  const trip = answers.trip;
  const destinations = trip?.destinations ?? [];
  const primary = destinations[0];
  const travelers = projectTravelers(answers);
  const travelerCount = travelers.adults + travelers.children.length + travelers.seniors.length;

  const bookings = (trip?.locked_order_types ?? []).flatMap((type) => {
    const booking = EXISTING_BOOKING_OF[type];
    return booking === undefined ? [] : [booking];
  });

  const flexibility =
    trip?.date_flexibility === undefined ? undefined : FLEXIBILITY_DAYS[trip.date_flexibility];

  return {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: options.clientRequestId,
    timezone: options.timezone,

    trip: {
      origin: {
        text: trip?.origin?.text ?? '',
        ...(trip?.origin?.place_id === undefined ? {} : { place_id: trip.origin.place_id }),
      },
      destination: {
        text: primary?.text ?? '',
        ...(primary?.place_id === undefined ? {} : { place_id: primary.place_id }),
        /*
         * 多城时置 true。P8 的 N-10 目前拒绝 `true`（V1 不支持多目的地），
         * 由 P9-6 改成「1～5 个」—— 在那之前多城请求会被 N-10 以精确错误码拒，
         * 而那正是想要的行为：宁可报错，不要静默只安排第一个城市。
         */
        allow_multiple_destinations: destinations.length > 1,
      },
      dates: {
        start_date: trip?.dates?.start_date ?? '',
        end_date: trip?.dates?.end_date ?? '',
        ...(flexibility === undefined ? {} : { flexibility_days: flexibility }),
      },
      ...(bookings.length === 0 ? {} : { existing_bookings: bookings }),
    },

    travelers: {
      adults: travelers.adults,
      ...(travelers.children.length === 0 ? {} : { children: [...travelers.children] }),
      ...(travelers.seniors.length === 0 ? {} : { seniors: [...travelers.seniors] }),
    },

    budget: projectBudget(answers, travelerCount),
    pace: projectPace(answers),
    conditions: [...projectConditions(answers)],
    custom_requirements: { raw_text: (answers.profile?.additional_notes ?? '').trim() },

    /*
     * 输出样式套件（R-85 P3）。**没选时整个键不出现。**
     *
     * 不恒发一个 `{ template_id: null }`：契约那边是
     * `template_id: TemplateIdSchema.default(TEMPLATE_ID_VALUES[0])` 加整块
     * `.prefault({})`，因此不传就自动拿默认套件 —— 而传 `null` 会被
     * `z.enum` 直接拒（REQ_SCHEMA_INVALID）。
     *
     * 也不在这里把默认套件写成字面量：那会让「谁是默认」多一个声明处，
     * 而两处必然漂移。默认值只在契约里声明一次。
     */
    ...(state.templateId === null ? {} : { output_preferences: { template_id: state.templateId } }),

    planner_profile: answers,
  };
}
