import {
  PLANNER_FIELDS,
  plannerField,
  type PlannerFieldId,
  type PlannerProfileInput,
  type PlannerStance,
} from '@tps/schemas';

import { hasValue, isOptedIn, type PlannerState } from './state';

/**
 * 条件触发引擎（规范 6 与附录 B 的 D-01～D-08）。
 *
 * ## 一张表 + 一个默认值
 *
 * 76 个字段里 36 个有非「始终显示」的触发条件，其余 40 个恒显示。
 * 表里只写那 36 个，默认恒显示 —— 反过来（把 40 个恒显示也写进表）会让
 * 这张表大部分是 `() => true` 的噪声。
 *
 * 代价是「键打错了」会静默变成恒显示。因此 `triggers.test.ts` 有一条反向断言：
 * **元数据表里 trigger 不是「始终显示」的字段，必须在这张表里有条目**
 * （或在 `ALWAYS_VISIBLE_DESPITE_TRIGGER` 白名单里，见下）。
 *
 * ## 有三个字段的「触发条件」其实不是显示条件
 *
 * 字段表那一列混了两种东西：真正的显示条件，与排序/必填强度的说明。
 * 照字面实现会把它们错误地藏起来：
 *
 *   - `PV2-04-007`「多城市或目的地未定时**优先显示**」—— 说的是排序靠前。
 *     藏起来会让单目的地用户无法表达换宿容忍度，而那是规范 10 用来推导
 *     单点/双中心/多城市路线结构的唯一输入。
 *   - `PV2-08-008`「**始终显示**；高风险活动时提升为条件必填」—— 前半句就是答案。
 *   - `PV2-09-001/005/006`「完成前 8 步后 / 提交前」—— 第 9 步的页面职责本身。
 *     把复核面板设成「八步全绿才出现」会让 blocked 状态的用户看不到
 *     blocker 列表，而那正是这一页存在的理由（规范 18）。
 *   - `PV2-06-008`「有相关偏好或抵达时间特殊」—— 没有可判定的上游字段，
 *     且它是 P1 非阻塞项。恒显示，让用户自己决定填不填。
 */

/** 这些字段的 trigger 文本不是显示条件，恒显示。逐条理由见文件头 */
export const ALWAYS_VISIBLE_DESPITE_TRIGGER: readonly PlannerFieldId[] = [
  'PV2-04-007',
  'PV2-06-008',
  'PV2-08-008',
  'PV2-09-001',
  'PV2-09-005',
  'PV2-09-006',
];

// ── 派生上下文 ──────────────────────────────────────────────

/**
 * 触发判定需要的派生值，一次算完。
 *
 * 每个谓词各自现算的话，`isTriggered` 跑一遍全表会把「有没有儿童」算 76 次；
 * 更要紧的是那种写法必然出现两处口径不一致的「有没有儿童」，
 * 而不一致的表现是「儿童需求出现了，但监护人问题没出现」。
 */
export interface TriggerContext {
  readonly travelerCount: number;
  /** 存在 18 岁以下旅行者（含少年）。监护人问题读它 */
  readonly hasMinor: boolean;
  /** 存在儿童或婴幼儿（不含少年）。儿童需求读它 */
  readonly hasChild: boolean;
  readonly isMultiCity: boolean;
  readonly destinationUndecided: boolean;
  /** 跨境。只有出发国与任一目的国都已知且不同时才成立 */
  readonly isInternational: boolean;
  readonly involvesAir: boolean;
  readonly involvesLongHaul: boolean;
  readonly involvesRailOrRental: boolean;
  readonly selfDriveChosen: boolean;
  readonly budgetMode: string | undefined;
  readonly lodgingIncludesHotel: boolean;
  readonly interestCount: number;
  readonly interestsIncludeShopping: boolean;
  readonly interestsIncludeNightlife: boolean;
  readonly lockedTypesChosen: boolean;
  readonly childNeedsFixedNap: boolean;
  readonly healthNeedsDeclared: boolean;
  readonly allergiesDeclared: boolean;
  readonly highRiskActivities: boolean;
  readonly purposeIncludesWork: boolean;
  readonly soloTraveler: boolean;
  readonly lateArrival: boolean;
}

function stanceOf(
  selections: readonly { code: string; stance: PlannerStance }[] | undefined,
  code: string,
): PlannerStance | undefined {
  return selections?.find((entry) => entry.code === code)?.stance;
}

/** 选了且不是「不要」。三态里 PREFER/REQUIRE 都意味着这种方式会出现在方案里 */
function chosen(
  selections: readonly { code: string; stance: PlannerStance }[] | undefined,
  code: string,
): boolean {
  const stance = stanceOf(selections, code);
  return stance === 'PREFER' || stance === 'REQUIRE';
}

export function buildTriggerContext(answers: PlannerProfileInput): TriggerContext {
  const trip = answers.trip;
  const travelers = answers.travelers;
  const profiles = travelers?.profiles ?? [];
  const destinations = trip?.destinations ?? [];

  /*
   * 人数取 `count` 而不是 `profiles.length`：规范 8 要求人数变化自动创建或回收
   * Traveler Card，而两者不一致的那一瞬间（用户刚点 +，卡片还没填）
   * 用 profiles.length 会让「分组需求」在人数到 3 时不出现。
   */
  const travelerCount = travelers?.count ?? profiles.length;

  const isMinor = (p: (typeof profiles)[number]): boolean =>
    p.age_band === 'INFANT' ||
    p.age_band === 'CHILD' ||
    p.age_band === 'TEEN' ||
    (p.age !== undefined && p.age < 18);
  const isChild = (p: (typeof profiles)[number]): boolean =>
    p.age_band === 'INFANT' || p.age_band === 'CHILD' || (p.age !== undefined && p.age < 12);

  const originCountry = trip?.origin?.country;
  /*
   * 跨境判定要求两边国家都已知（D-02）。国家未知时**不**触发国际证件模块 ——
   * 猜错的两个方向都很糟：漏触发让用户拿到一份没查签证的跨境方案；
   * 误触发让国内游用户被问护照有效期，而那会显著降低完成率。
   */
  const isInternational =
    hasValue(originCountry) &&
    destinations.some((d) => hasValue(d.country) && d.country !== originCountry);

  const intercity = answers.transport?.intercity_modes;
  const local = answers.transport?.local_modes;

  const selfDriveChosen =
    chosen(intercity, 'transport.self_drive') || chosen(local, 'transport.self_drive');

  /*
   * 「涉及航空交通」：明确选了飞机，或跨境（本产品的跨境场景基本都要飞），
   * 但用户明确排除飞机时一律不涉及 —— EXCLUDE 是硬边界，
   * 不能被「系统觉得跨境要飞」覆盖（规范 4.1：低优先级不得覆盖高优先级）。
   */
  const flightExcluded = stanceOf(intercity, 'transport.flight') === 'EXCLUDE';
  const involvesAir = !flightExcluded && (chosen(intercity, 'transport.flight') || isInternational);

  const involvesLongHaul =
    involvesAir ||
    isMultiCityOf(destinations.length) ||
    chosen(intercity, 'transport.rail') ||
    chosen(intercity, 'transport.coach') ||
    chosen(intercity, 'transport.ferry');

  const interests = answers.interests?.tags ?? [];
  const lodgingTypes = answers.lodging?.types;
  const sleepNeeds = answers.lodging?.sleep_checkin_needs?.needs ?? [];

  return {
    travelerCount,
    hasMinor: profiles.some(isMinor),
    hasChild: profiles.some(isChild),
    isMultiCity: isMultiCityOf(destinations.length),
    destinationUndecided: trip?.destination_status === 'UNDECIDED',
    isInternational,
    involvesAir,
    involvesLongHaul,
    involvesRailOrRental: chosen(intercity, 'transport.rail') || selfDriveChosen,
    selfDriveChosen,
    budgetMode: answers.budget?.mode,
    lodgingIncludesHotel:
      chosen(lodgingTypes, 'accommodation.hotel') || chosen(lodgingTypes, 'accommodation.resort'),
    interestCount: interests.length,
    interestsIncludeShopping: interests.includes('interest.shopping'),
    interestsIncludeNightlife: interests.includes('interest.nightlife'),
    lockedTypesChosen: (trip?.locked_order_types ?? []).length > 0,
    childNeedsFixedNap: (answers.travelers?.child_needs?.values ?? []).includes('FIXED_NAP'),
    healthNeedsDeclared:
      answers.special?.has_health_or_accessibility_needs === 'YES' ||
      answers.special?.has_health_or_accessibility_needs === 'UNSURE',
    allergiesDeclared: answers.food?.has_allergies === 'YES',
    highRiskActivities: (answers.special?.high_risk_activities ?? []).length > 0,
    purposeIncludesWork: (answers.profile?.trip_purposes?.values ?? []).includes('BLEISURE'),
    soloTraveler: travelerCount === 1,
    lateArrival:
      sleepNeeds.includes('LATE_CHECK_IN') ||
      answers.transport?.time_preferences?.avoid_late_night_arrival === false,
  };
}

function isMultiCityOf(count: number): boolean {
  return count >= 2;
}

// ── 触发表 ──────────────────────────────────────────────────

type TriggerFn = (ctx: TriggerContext, state: PlannerState) => boolean;

/**
 * 36 个非恒显示字段的触发条件。
 *
 * `Partial` 而不是全量 `Record`：只写有条件的那些。完整性由测试反向守护
 * （见文件头）。
 */
const TRIGGERS: Partial<Record<PlannerFieldId, TriggerFn>> = {
  // ── D-01 目的地链 ──
  /** 「完全未定」时不问具体目的地，转入目的地发现分支（规范 7） */
  'PV2-01-003': (ctx) => !ctx.destinationUndecided,
  /** 选了任一订单类型才展开订单卡 */
  'PV2-01-009': (ctx) => ctx.lockedTypesChosen,

  // ── D-01 同行人链 ──
  'PV2-02-002': (ctx) => ctx.travelerCount > 0,
  'PV2-02-003': (ctx) => ctx.hasMinor,
  'PV2-02-005': (ctx) => ctx.hasChild,
  'PV2-02-006': (ctx) => ctx.travelerCount >= 3,

  // ── D-07 预算链。模式切换只换输入形式，不清值（规范 9）──
  'PV2-03-002': (ctx) => ctx.budgetMode !== undefined && ctx.budgetMode !== 'UNKNOWN',
  'PV2-03-003': (ctx) => ctx.budgetMode === 'TOTAL' || ctx.budgetMode === 'PER_PERSON',
  'PV2-03-004': (ctx) => ctx.budgetMode === 'TIER' || ctx.budgetMode === 'UNKNOWN',
  'PV2-03-005': (ctx) => ctx.budgetMode !== undefined && ctx.budgetMode !== 'UNKNOWN',

  // ── 节奏 ──
  /** 儿童需求含固定午睡，或用户主动开启 */
  'PV2-04-006': (ctx, state) => ctx.childNeedsFixedNap || isOptedIn(state, 'PV2-04-006'),

  // ── 交通 ──
  'PV2-05-001': (ctx) => ctx.involvesLongHaul || ctx.isMultiCity || ctx.destinationUndecided,
  'PV2-05-002': (ctx) => ctx.involvesAir,
  'PV2-05-003': (ctx) => ctx.involvesAir,
  'PV2-05-004': (ctx) => ctx.involvesLongHaul,
  // D-03 自驾链
  'PV2-05-006': (ctx) => ctx.selfDriveChosen,
  'PV2-05-007': (ctx) => ctx.involvesAir || ctx.involvesRailOrRental,

  // ── 住宿 ──
  'PV2-06-004': (ctx) => ctx.budgetMode === 'TOTAL' || ctx.budgetMode === 'PER_PERSON',
  'PV2-06-006': (ctx) => ctx.lodgingIncludesHotel,

  // ── D-08 兴趣链 / D-04 过敏链 ──
  'PV2-07-004': (ctx) => ctx.allergiesDeclared,
  'PV2-07-007': (ctx) => ctx.interestCount >= 3,
  'PV2-07-010': (ctx, state) => ctx.interestsIncludeShopping || isOptedIn(state, 'PV2-07-010'),

  // ── 特别关照 ──
  'PV2-08-002': (ctx) => ctx.healthNeedsDeclared,
  'PV2-08-004': (ctx) => ctx.isInternational || ctx.healthNeedsDeclared,
  // D-02 跨境链
  'PV2-08-005': (ctx) => ctx.isInternational,
  'PV2-08-006': (ctx) => ctx.isInternational,
  'PV2-08-007': (ctx) => ctx.isInternational,
  'PV2-08-009': (ctx) => ctx.soloTraveler || ctx.interestsIncludeNightlife || ctx.lateArrival,
  'PV2-08-010': (ctx, state) => ctx.purposeIncludesWork || isOptedIn(state, 'PV2-08-010'),

  // ── 确认旅程 ──
  /*
   * 只在真有未完成的阻塞项时出现。`unresolvedBlockers` 会遍历其余 75 个字段，
   * 因此这一条**必须**跳过自己 —— 见 `unresolvedBlockers` 的实现。
   */
  'PV2-09-002': (_ctx, state) => unresolvedBlockers(state).length > 0,
};

/**
 * 触发表里有条目的字段。
 *
 * 导出它是为了让完整性断言能**直接**比较键集合。曾经试过一种间接判定
 * 「空状态下仍显示 ⇒ 表里没有它」—— 那是错的：`PV2-01-003` 的条件是
 * 「目的地状态 ≠ 完全未定」，空状态下它本就成立。间接判定会把两个已处理的
 * 字段报成漏项，而修那两条假警报的路上很容易顺手把真的漏项也放过去。
 */
export const CONDITIONAL_FIELD_IDS: readonly PlannerFieldId[] = Object.keys(
  TRIGGERS,
) as readonly PlannerFieldId[];

/**
 * 这个字段现在该不该显示。
 *
 * 第 10 步的字段（方案后补充）在主问卷里恒不显示 —— 它们属于生成之后的
 * 行前准备中心（规范 16），出现在 9 步问卷里就违反了「不把用户拖回主问卷」。
 */
export function isTriggered(state: PlannerState, fieldId: PlannerFieldId): boolean {
  const spec = plannerField(fieldId);
  if (spec.level === 'POST_PLAN') return false;
  const trigger = TRIGGERS[fieldId];
  if (trigger === undefined) return true;
  return trigger(buildTriggerContext(state.answers), state);
}

/** 一次算好上下文再批量判定。渲染一整步时用它，避免重复计算派生值 */
export function triggeredFields(state: PlannerState): readonly PlannerFieldId[] {
  const ctx = buildTriggerContext(state.answers);
  return PLANNER_FIELDS.filter((spec) => {
    if (spec.level === 'POST_PLAN') return false;
    const trigger = TRIGGERS[spec.field_id];
    return trigger === undefined || trigger(ctx, state);
  }).map((spec) => spec.field_id);
}

/**
 * 已触发但仍未满足的阻塞字段。
 *
 * 「阻塞」= 元数据的 `blocking` 为 `ALWAYS`，或为 `CONDITIONAL` 且已触发。
 * 只看已触发的字段（规范 6：未触发字段不占完成度、不作为缺失项）。
 *
 * **跳过 PV2-09-002**：它自己的触发条件就是「存在未完成的阻塞项」，
 * 算进来会无限递归。它是一个元字段 —— 承载的是「在第 9 步就地补答」这个动作，
 * 而不是一份独立的用户答案。
 */
export function unresolvedBlockers(state: PlannerState): readonly PlannerFieldId[] {
  const ctx = buildTriggerContext(state.answers);
  return PLANNER_FIELDS.filter((spec) => {
    if (spec.field_id === 'PV2-09-002') return false;
    if (spec.level === 'POST_PLAN') return false;
    if (spec.blocking === 'NEVER') return false;

    const trigger = TRIGGERS[spec.field_id];
    const triggered = trigger === undefined || trigger(ctx, state);
    if (!triggered) return false;

    return !hasValue(readAnswerOf(state, spec.field_id));
  }).map((spec) => spec.field_id);
}

function readAnswerOf(state: PlannerState, fieldId: PlannerFieldId): unknown {
  const spec = plannerField(fieldId);
  const dot = spec.api_key.indexOf('.');
  const block = (state.answers as Record<string, unknown>)[spec.api_key.slice(0, dot)];
  if (typeof block !== 'object' || block === null) return undefined;
  return (block as Record<string, unknown>)[spec.api_key.slice(dot + 1)];
}

/**
 * 这个分支第一次展开时给出的「为什么问你这个」。
 *
 * 规范 6 的「触发解释」：二级/三级问题首次出现时必须说明原因，
 * 「增强私人顾问感」。只有条件触发的字段有 —— 恒显示的字段不需要解释。
 */
export const TRIGGER_REASON: Partial<Record<PlannerFieldId, string>> = {
  'PV2-01-009': '因为你说已经订好了一部分，我们需要把它变成不可移动的锚点。',
  'PV2-02-003': '因为同行中有未成年人，部分航空公司与目的地会要求监护证明。',
  'PV2-02-005': '因为有孩子同行，住宿、交通与每日节奏都需要相应安排。',
  'PV2-02-006': '因为你们有三人以上，我们需要知道要不要分房、分车或分头活动。',
  'PV2-04-006': '因为需要固定午休，这段时间我们不会安排任何行程。',
  'PV2-05-002': '因为这趟旅行会用到飞机，转机与过境规则需要提前确认。',
  'PV2-05-003': '因为涉及航班，舱等与座位会影响长途舒适度和票价。',
  'PV2-05-006': '因为你选择了自驾，我们需要确认目的地是否认可你的证件组合。',
  'PV2-05-007': '因为涉及长途交通，行李件数会影响票价规则与车辆空间。',
  'PV2-06-006': '因为你偏好酒店或度假村，星级与品牌可以缩小候选范围。',
  'PV2-07-004': '因为存在食物过敏，我们会把它当作安全硬约束逐家餐厅核实。',
  'PV2-07-007': '因为你选了三个以上兴趣，排个序能让我们在时间冲突时知道先保留什么。',
  'PV2-07-010': '因为你有明确的购物目标，我们会规划路线、退税与行李空间。',
  'PV2-08-002': '因为你提到存在健康或无障碍需求，我们只问旅行中需要怎样的照顾。',
  'PV2-08-004': '因为这是跨境旅行或存在健康需求，药品入境规则需要核实。',
  'PV2-08-005': '因为出发地与目的地不在同一个国家，签证与入境规则由国籍决定。',
  'PV2-08-006': '因为这是跨境旅行，护照有效期会影响能否做不可退预订。',
  'PV2-08-007': '因为这是跨境旅行，签证或 ETA 的办理时间需要排进时间线。',
  'PV2-08-009': '因为存在独行、夜间活动或深夜抵达，我们会提高安全阈值。',
  'PV2-08-010': '因为行程中有不能移动的工作安排，它会成为硬约束。',
  'PV2-09-002': '这些是会影响生成结果的问题，就地补答即可，不必回到前面的步骤。',
};
