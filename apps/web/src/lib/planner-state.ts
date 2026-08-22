import {
  BUDGET_INCLUDED_ITEM_VALUES,
  CONDITION_CODES_BY_DOMAIN,
  type BudgetIncludedItem,
  type BudgetTier,
  type ConditionCode,
  type ExistingBooking,
  type TravelRequestUIInput,
} from '@tps/schemas';

import {
  INITIAL_FORM_STATE,
  buildTravelRequest,
  type BuildRequestOptions,
  type ConditionStance,
  type TravelRequestFormState,
} from './travel-request-form';

/**
 * 采集界面的状态层（TP-8-07，原型的七步工作台）。
 *
 * ## 为什么状态与完成度都是纯函数
 *
 * 完成度百分比是用户唯一能看到的「还差多少」信号，而**看到 62% 的人无法判断
 * 它该不该是 62%**。同理三态的点击循环漏一态、预算区间倒挂，界面上都看不出
 * 对错 —— 前者像手滑，后者表现为提交时一句「请求失败」。
 *
 * 因此这三件事全部放在这里，由 `planner-state.test.ts` 穷举；
 * 组件只做 props → DOM。
 *
 * ## 状态是 `TravelRequestFormState` 的超集
 *
 * 契约相关的 13 个字段名与它逐字相同，因此 `buildTravelRequest` 不需要改 ——
 * 见该文件。超出的部分是原型特有的（路线结构、行动能力档、界面开关）
 * 与完成度记账。
 */

// ── 七步 ────────────────────────────────────────────────────

export const STEP_IDS = [
  'basic',
  'travelers',
  'budget',
  'pace',
  'transport',
  'interests',
  'custom',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABEL: Record<StepId, string> = {
  basic: '基本信息',
  travelers: '同行人员',
  budget: '旅行预算',
  pace: '节奏路线',
  transport: '交通住宿',
  interests: '兴趣活动',
  custom: '特殊需求',
};

/**
 * 每步在完成度里的权重，取自原型。**七项之和必须是 100**
 * —— 否则进度条永远到不了（或超过）100%。由测试断言。
 */
export const STEP_WEIGHTS: Record<StepId, number> = {
  basic: 15,
  travelers: 15,
  budget: 20,
  pace: 12,
  transport: 15,
  interests: 10,
  custom: 13,
};

/**
 * 每步的细项与其权重。**每步细项之和等于该步权重**，由测试断言 ——
 * 加起来偏小的那一步永远无法完成，左栏圆点永远不变绿。
 */
export const STEP_CRITERIA = {
  basic: { route: 5, dates: 6, options: 4 },
  travelers: { counts: 8, details: 7 },
  budget: { range: 10, inclusions: 4, focus: 6 },
  pace: { intensity: 4, limits: 4, route: 4 },
  transport: { mode: 6, lodging: 4, requirements: 5 },
  interests: { selection: 10 },
  /*
   * 原型这一步是 `{ input: 4, confirmed: 9 }`：写了文字得 4 分，点「解析为旅行
   * 条件 → 确认并添加」再得 9 分。那个按钮在本实现里被删掉了（它是 7 条关键词
   * `if`，产出的标签不在 46 码字典内，发出去会被拒），**而 9 分的权重当时留了
   * 下来** —— 于是 `confirmed` 只剩「勾我没有其他特殊需求」一条正向路径，
   * 认真写了特殊需求的用户反而会把它显式清掉。
   *
   * 结果是方向反的：写了文字最高 91%、第 7 步永远不变绿；勾「我没有」才 100%。
   * 越认真的用户分越低，而且他没有任何办法补上那 9 分。
   *
   * 合并成一项 13 分。删掉这个二级划分而不是给它另找一个达成条件：
   * 解析按钮没了之后这一步只有一个动作 ——「就特殊需求给出明确回答」，
   * 而「写了字」与「写完了」在这里无从区分。
   *
   * 用第 7 步自己那三组标签（饮食／无障碍／作息）当第二级也不行：
   * 没有忌口、不需要无障碍的用户会被同样的方式卡住，只是换了个位置。
   */
  custom: { answered: 13 },
} as const satisfies Record<StepId, Record<string, number>>;

// ── 预算档位 ────────────────────────────────────────────────

export interface BudgetTierPreset {
  readonly tier: Exclude<BudgetTier, 'CUSTOM'>;
  readonly name: string;
  readonly icon: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
}

/**
 * 原型第 3 步的四张预设卡片（第五张是「自定义」，没有区间）。
 *
 * 区间**首尾相接**（上一档的 max 就是下一档的 min），由测试断言 ——
 * 有缝隙的话某些预算落不进任何档，而界面上表现为「四张卡都不高亮」。
 */
export const BUDGET_TIER_PRESETS: readonly BudgetTierPreset[] = [
  {
    tier: 'ECONOMY',
    name: '经济穷游',
    icon: '🎒',
    description: '青旅、经济酒店、公共交通',
    min: 300,
    max: 800,
  },
  {
    tier: 'STANDARD',
    name: '舒适标准',
    icon: '✈️',
    description: '住宿、交通与体验均衡',
    min: 800,
    max: 1_500,
  },
  {
    tier: 'QUALITY',
    name: '品质度假',
    icon: '🏨',
    description: '高品质酒店和特色体验',
    min: 1_500,
    max: 3_000,
  },
  {
    tier: 'LUXURY',
    name: '豪华旅行',
    icon: '💎',
    description: '豪华酒店、专车和私人体验',
    min: 3_000,
    max: 6_000,
  },
];

/** 双滑块的下界。N-12 的物理下限是 50 元/人/天，这里留了余量 */
export const BUDGET_DAILY_FLOOR = 100;
/** 双滑块的上界。超过它的预算走数字输入框直接填 */
export const BUDGET_DAILY_CEILING = 10_000;

export const BUDGET_ITEM_LABEL: Record<BudgetIncludedItem, string> = {
  INTERCITY_TRANSPORT: '往返大交通',
  ACCOMMODATION: '住宿',
  MEALS: '餐饮',
  LOCAL_TRANSPORT: '市内交通',
  TICKETS: '门票与活动',
  SHOPPING: '购物',
};

export const EXISTING_BOOKING_LABEL: Record<ExistingBooking, string> = {
  INTERCITY_TRANSPORT: '已有往返交通',
  LODGING: '已有酒店',
  TICKETS: '已有门票或演出',
};

// ── 节奏与路线 ──────────────────────────────────────────────

export type PaceIntensity = 1 | 2 | 3 | 4 | 5;

export const PACE_INTENSITY_LABEL: Record<PaceIntensity, string> = {
  1: '躺平度假',
  2: '常规慢逛',
  3: '节奏均衡',
  4: '充实紧凑',
  5: '特种兵打卡',
};

export interface RouteShape {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
}

/**
 * 原型第 4 步的八种路线结构。
 *
 * **纯前端项**：契约里没有承载它的字段，且八种互斥（选一个就排除其余七个），
 * 而 schema 层表达不了互斥。选中值拼进 `custom_requirements.raw_text`，
 * 由模型读 —— 见 `buildRouteShapeNote`。
 */
export const ROUTE_SHAPES: readonly RouteShape[] = [
  { id: 'hub', name: '中心辐射', glyph: '✳' },
  { id: 'single', name: '单点停留', glyph: '●' },
  { id: 'dual', name: '双中心', glyph: '●—●' },
  { id: 'multi', name: '多城市跳转', glyph: '●—●—●' },
  { id: 'loop', name: '环线自驾', glyph: '↻' },
  { id: 'oneway', name: '单向线路', glyph: 'A→B' },
  { id: 'island', name: '跳岛', glyph: '● ● ●' },
  { id: 'improvise', name: '边走边定', glyph: '?' },
];

// ── 标签分组：渲染位置与完成度记账的唯一来源 ────────────────

/**
 * 每一步渲染哪些条件标签，以及那一组算进哪个细项。
 *
 * ## 为什么这张表必须存在
 *
 * 「标签渲染在哪一步」原来写在 `StepSections.tsx`，「点它给哪一步记分」原来靠
 * **按域推断**。两份信息各写一遍，于是分叉了三处：
 *
 * ```text
 * 第 2 步的「亲子房」「单一住宿基地」  → 按域落到 accommodation → 给第 5 步记分
 * 第 2 步的「儿童安全座椅」「每日午休」→ 按域落到 accessibility/schedule → 谁都不记
 * 第 3 步的「购物」                    → 按域落到 interest → 给第 6 步记分
 * ```
 *
 * 后果是**点了这里、别处变绿**，而按域推断那段代码的注释写的正是
 * 「避免勾了公共交通却让兴趣那步变绿」—— 意图被自己的实现违反了。
 * 更糟的是第 2 步的标签组因此对第 2 步毫无贡献，而 `travelers.details` 的另一条
 * 路径（儿童年龄／长者行动能力）只在有儿童或长者时才渲染 ——
 * 于是**两个成人出门的用户拿不到那 7 分，完成度上限 93%，第 2 步永远不变绿**。
 *
 * 现在把两件事合成一张表：界面从这里取要渲染的 code，记账也从这里查归属。
 * `criterion: null` 表示那一组不参与完成度。
 *
 * 46 个 code 在这张表里**恰好各出现一次**，由测试断言 —— 重复出现就意味着
 * 同一个标签有两个入口，而在其中一个入口点它会让另一步变绿。
 */
export const TAG_GROUPS = [
  {
    /** 第 2 步「同行相关的偏好」。原型把这一组接到 travelers.details */
    codes: [
      'accommodation.family_room',
      'accessibility.child_car_seat',
      'schedule.daily_rest',
      'accommodation.single_base',
    ],
    step: 'travelers',
    criterion: 'details',
    /*
     * `travelers.details` 还有另一个来源：儿童年龄与长者行动能力两个控件。
     *
     * 因此取消这一组的最后一个标签时**不撤销**这个细项 —— 否则「填了儿童年龄、
     * 点了个标签又取消」会把年龄那一份也抹掉，而那个输入框里的值还在。
     * 其余各组是纯标签驱动的，取消最后一个应当退回未达成。
     */
    alsoSetByControls: true,
  },
  {
    /** 第 3 步「愿意重点花钱的项目」。不含 interest.shopping —— 它在第 6 步 */
    codes: [...CONDITION_CODES_BY_DOMAIN.budget],
    step: 'budget',
    criterion: 'focus',
    alsoSetByControls: false,
  },
  {
    codes: [...CONDITION_CODES_BY_DOMAIN.transport],
    step: 'transport',
    criterion: 'mode',
    alsoSetByControls: false,
  },
  {
    codes: [
      'accommodation.hotel',
      'accommodation.homestay',
      'accommodation.apartment',
      'accommodation.resort',
      'accommodation.hostel',
    ],
    step: 'transport',
    criterion: 'lodging',
    alsoSetByControls: false,
  },
  {
    codes: [
      'accommodation.elevator',
      'accommodation.private_bath',
      'accommodation.near_transit',
      'accommodation.breakfast',
      'accommodation.kitchen',
      'accommodation.shared_dorm',
    ],
    step: 'transport',
    criterion: 'requirements',
    alsoSetByControls: false,
  },
  {
    codes: [...CONDITION_CODES_BY_DOMAIN.interest],
    step: 'interests',
    criterion: 'selection',
    alsoSetByControls: false,
  },
  {
    /*
     * 第 7 步「饮食与无障碍」「作息」。**不参与完成度**。
     *
     * 让它们记分会把「没有忌口、不需要无障碍」的用户卡在未完成 ——
     * 与被修掉的 `custom.confirmed` 是同一个形状的坑。这一步靠
     * `custom.answered`（写了文字 或 勾「我没有」）算完。
     *
     * `child_car_seat` 与 `daily_rest` 不在这里：它们的入口在第 2 步，
     * 那里才是用户会想到它们的位置。
     */
    codes: [
      ...CONDITION_CODES_BY_DOMAIN.diet,
      'accessibility.wheelchair',
      'accessibility.stroller',
      'accessibility.low_walking',
      'schedule.no_late_night',
    ],
    step: null,
    criterion: null,
    alsoSetByControls: false,
  },
] as const satisfies readonly {
  readonly codes: readonly ConditionCode[];
  readonly step: StepId | null;
  readonly criterion: string | null;
  /**
   * 该细项是否还有标签之外的来源 —— 有的话取消最后一个标签不撤销它。
   *
   * 每组都要显式写（不是可选字段）：`as const` 之下缺这个键的组会让联合类型上
   * 取不到它，而补 `?` 只会把「忘了想这件事」变成静默的 false。
   */
  readonly alsoSetByControls: boolean;
}[];

/** 便捷别名，供 `StepSections` 取每一组要渲染的 code */
export const TRAVELER_TAG_CODES = TAG_GROUPS[0].codes;
export const BUDGET_FOCUS_CODES = TAG_GROUPS[1].codes;
export const TRANSPORT_CODES = TAG_GROUPS[2].codes;
export const LODGING_TYPE_CODES = TAG_GROUPS[3].codes;
export const LODGING_REQUIREMENT_CODES = TAG_GROUPS[4].codes;
export const INTEREST_CODES = TAG_GROUPS[5].codes;
export const CUSTOM_TAG_CODES = TAG_GROUPS[6].codes;

// ── 长者行动能力 ────────────────────────────────────────────

export const SENIOR_MOBILITY_VALUES = [
  'NORMAL',
  'FREQUENT_REST',
  'LOW_STEPS',
  'WHEELCHAIR',
] as const;
export type SeniorMobility = (typeof SENIOR_MOBILITY_VALUES)[number];

export const SENIOR_MOBILITY_LABEL: Record<SeniorMobility, string> = {
  NORMAL: '正常活动',
  FREQUENT_REST: '可步行，但需要频繁休息',
  LOW_STEPS: '需要减少步行和台阶',
  WHEELCHAIR: '需要轮椅或无障碍设施',
};

/**
 * 行动能力档 → 条件码。
 *
 * 第二轮决策：13「老人行动能力」**拆到既有的两个 `accessibility` 码**，
 * 而不是新造一个四值枚举 —— 落成 code 才受 V-30 硬约束校验保护，
 * 而一个新枚举下游还得再翻译一次。
 *
 * `FREQUENT_REST` 没有对应码，走自由文本（见 `buildMobilityNote`）。
 */
const MOBILITY_CODES: Record<SeniorMobility, readonly ConditionCode[]> = {
  NORMAL: [],
  FREQUENT_REST: [],
  LOW_STEPS: ['accessibility.low_walking'],
  WHEELCHAIR: ['accessibility.wheelchair', 'accessibility.low_walking'],
};

/** 受 `setSeniorMobility` 管理的码。切换档位时先撤掉全部，再按新档加回 */
const ALL_MOBILITY_CODES: readonly ConditionCode[] = [
  'accessibility.low_walking',
  'accessibility.wheelchair',
];

// ── 状态 ────────────────────────────────────────────────────

export interface PlannerState extends TravelRequestFormState {
  // ── 契约字段（P8 增量 0b 新增）──
  readonly budgetTier: BudgetTier | undefined;
  readonly paceIntensity: PaceIntensity;
  readonly existingBookings: readonly ExistingBooking[];
  readonly includedItems: readonly BudgetIncludedItem[];
  readonly attractionsPerDay: string;
  readonly walkingLimitKm: number;
  readonly earliestDeparture: string;
  readonly childAge: number;

  // ── 纯前端（不进契约，或只进自由文本）──
  readonly routeShape: string | undefined;
  readonly seniorMobility: SeniorMobility;
  readonly destinationUndecided: boolean;
  readonly noSpecialRequirements: boolean;
  readonly interestQuery: string;

  // ── 完成度记账 ──
  /**
   * 已达成的细项，键是 `${StepId}.${细项名}`。
   *
   * 记账而不是从字段值推导：原型的规则是「只有用户主动编辑后才计入」，
   * 而默认预填值与用户填出同样的值在字段上无法区分。不记账的话首屏就
   * 显示 40%，而那个数字对用户没有任何信息量。
   */
  readonly completed: readonly string[];
}

export const INITIAL_PLANNER_STATE: PlannerState = {
  ...INITIAL_FORM_STATE,
  adults: 2,
  budgetMin: 800,
  budgetMax: 1_500,

  budgetTier: undefined,
  paceIntensity: 3,
  existingBookings: [],
  includedItems: ['INTERCITY_TRANSPORT', 'ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'],
  attractionsPerDay: '2~3',
  walkingLimitKm: 3,
  earliestDeparture: '09:00',
  childAge: 8,

  routeShape: undefined,
  seniorMobility: 'NORMAL',
  destinationUndecided: false,
  noSpecialRequirements: false,
  interestQuery: '',

  completed: [],
};

// ── 完成度 ──────────────────────────────────────────────────

type CriterionOf<S extends StepId> = keyof (typeof STEP_CRITERIA)[S] & string;

function criterionKey<S extends StepId>(step: S, criterion: CriterionOf<S>): string {
  return `${step}.${criterion}`;
}

/** 置位/清位一个细项。返回新的 completed 数组（去重、稳定顺序） */
function setCriterion<S extends StepId>(
  completed: readonly string[],
  step: S,
  criterion: CriterionOf<S>,
  done: boolean,
): readonly string[] {
  const key = criterionKey(step, criterion);
  const has = completed.includes(key);
  if (done === has) return completed;
  return done ? [...completed, key] : completed.filter((entry) => entry !== key);
}

export function stepScore(state: PlannerState, step: StepId): number {
  const criteria: Record<string, number> = STEP_CRITERIA[step];
  return Object.entries(criteria).reduce(
    (sum, [criterion, weight]) =>
      state.completed.includes(`${step}.${criterion}`) ? sum + weight : sum,
    0,
  );
}

export function stepIsComplete(state: PlannerState, step: StepId): boolean {
  return stepScore(state, step) >= STEP_WEIGHTS[step];
}

/** 这一步有没有被动过 —— 左栏的蓝点用它，绿勾用 `stepIsComplete` */
export function stepIsEdited(state: PlannerState, step: StepId): boolean {
  return state.completed.some((key) => key.startsWith(`${step}.`));
}

export function overallProgress(state: PlannerState): number {
  const total = STEP_IDS.reduce((sum, step) => sum + stepScore(state, step), 0);
  return Math.max(0, Math.min(100, total));
}

// ── 派生：给右栏摘要用 ──────────────────────────────────────

export function tripDays(state: PlannerState): number {
  if (state.startDate.length === 0 || state.endDate.length === 0) return 1;
  const diff = Date.parse(`${state.endDate}T00:00:00`) - Date.parse(`${state.startDate}T00:00:00`);
  if (Number.isNaN(diff) || diff < 0) return 1;
  return Math.floor(diff / 86_400_000) + 1;
}

export function travelerCount(state: PlannerState): number {
  return Math.max(1, state.adults + state.childAges.length + state.seniorCount);
}

/** 预算总额区间。界面上显示，不进契约（契约收的是人均每天的 min/max） */
export function budgetTotal(state: PlannerState): { readonly min: number; readonly max: number } {
  const factor = travelerCount(state) * tripDays(state);
  return { min: state.budgetMin * factor, max: state.budgetMax * factor };
}

/**
 * 路线结构与「频繁休息」拼成的自由文本补充。
 *
 * 这两项在契约里没有落点（见 `ROUTE_SHAPES` 与 `MOBILITY_CODES` 的说明），
 * 因此附加在 `raw_text` 末尾交给模型。前缀写成「补充：」而不是混进用户原文 ——
 * 用户看到的提交内容里应当能分辨哪句是他自己写的。
 */
export function derivedNotes(state: PlannerState): string {
  const notes: string[] = [];

  const shape = ROUTE_SHAPES.find((item) => item.id === state.routeShape);
  if (shape !== undefined) notes.push(`路线结构偏好：${shape.name}`);
  if (state.seniorMobility === 'FREQUENT_REST') notes.push('同行长者可步行，但需要频繁休息');

  return notes.length === 0 ? '' : `补充：${notes.join('；')}。`;
}

// ── Action ──────────────────────────────────────────────────

/** 可直接赋值的文本字段。收窄到这几个，避免 setText 变成万能后门 */
type TextField =
  | 'origin'
  | 'destination'
  | 'startDate'
  | 'endDate'
  | 'customText'
  | 'interestQuery'
  | 'earliestDeparture'
  | 'attractionsPerDay';

export type PlannerAction =
  | { readonly type: 'setText'; readonly field: TextField; readonly value: string }
  | { readonly type: 'toggleDestinationUndecided' }
  | { readonly type: 'toggleExistingBooking'; readonly value: ExistingBooking }
  | {
      readonly type: 'adjustTraveler';
      readonly kind: 'adults' | 'children' | 'seniors';
      readonly delta: number;
    }
  | { readonly type: 'setChildAge'; readonly value: number }
  | { readonly type: 'setSeniorMobility'; readonly value: SeniorMobility }
  | { readonly type: 'selectBudgetTier'; readonly tier: BudgetTier }
  | { readonly type: 'setBudgetDaily'; readonly side: 'min' | 'max'; readonly value: number }
  | { readonly type: 'toggleIncludedItem'; readonly item: BudgetIncludedItem }
  | { readonly type: 'setPaceIntensity'; readonly value: PaceIntensity }
  | { readonly type: 'setWalkingLimit'; readonly value: number }
  | { readonly type: 'setRouteShape'; readonly value: string }
  | { readonly type: 'cycleCondition'; readonly code: ConditionCode }
  | { readonly type: 'toggleNoSpecialRequirements' }
  | { readonly type: 'reset' };

/** 三态的点击循环。写成表：加一态时漏改是编译错误 */
const NEXT_STANCE: Record<ConditionStance | 'NONE', ConditionStance | undefined> = {
  NONE: 'PREFER',
  PREFER: 'REQUIRE',
  REQUIRE: 'EXCLUDE',
  EXCLUDE: undefined,
};

/**
 * 一个 code 影响哪个细项。返回 null 表示不参与完成度。
 *
 * 直接查 `TAG_GROUPS`（标签渲染位置的同一份数据），**不再按域推断** ——
 * 按域推断与界面上的实际分组不一致，表现为「点了这一步的标签、另一步变绿」。
 * 逐条差异见 `TAG_GROUPS` 的说明。
 */
export function criterionForCode(code: ConditionCode): readonly [StepId, string] | null {
  for (const group of TAG_GROUPS) {
    /*
     * 先放宽成 `ConditionCode[]`：`TAG_GROUPS` 是 `as const`，因此 `codes` 是
     * 字面量元组，`includes` 会把入参收窄到该组自己的成员 —— 跨七组求交集
     * 就成了 `never`，任何 code 都传不进去。
     */
    const codes: readonly ConditionCode[] = group.codes;
    if (!codes.includes(code)) continue;
    return group.step === null || group.criterion === null ? null : [group.step, group.criterion];
  }
  return null;
}

/** 这个 code 所在的组是否还有别的来源喂同一个细项 */
function groupAlsoSetByControls(code: ConditionCode): boolean {
  for (const group of TAG_GROUPS) {
    const codes: readonly ConditionCode[] = group.codes;
    if (codes.includes(code)) return group.alsoSetByControls;
  }
  return false;
}

/** 该细项现在还有没有选中的标签 —— 取消最后一个时要退回未达成 */
function anySelectedFor(
  conditions: PlannerState['conditions'],
  target: readonly [StepId, string],
): boolean {
  return Object.keys(conditions).some((code) => {
    const criterion = criterionForCode(code as ConditionCode);
    return criterion !== null && criterion[0] === target[0] && criterion[1] === target[1];
  });
}

function clampBudget(min: number, max: number, changed: 'min' | 'max') {
  const lo = Math.max(BUDGET_DAILY_FLOOR, Math.round(min) || BUDGET_DAILY_FLOOR);
  const hi = Math.max(BUDGET_DAILY_FLOOR, Math.round(max) || BUDGET_DAILY_FLOOR);
  // 顶开被改动的那一侧的对侧，而不是把用户刚拖的那一侧拽回去
  return changed === 'min'
    ? { min: lo, max: Math.max(lo, hi) }
    : { min: Math.min(lo, hi), max: hi };
}

// ── Reducer ─────────────────────────────────────────────────

export function plannerReducer(state: PlannerState, action: PlannerAction): PlannerState {
  switch (action.type) {
    case 'reset':
      return INITIAL_PLANNER_STATE;

    case 'setText': {
      const next: PlannerState = { ...state, [action.field]: action.value };
      return recomputeText(next, action.field);
    }

    case 'toggleDestinationUndecided': {
      const next: PlannerState = { ...state, destinationUndecided: !state.destinationUndecided };
      return recomputeText(next, 'destination');
    }

    case 'toggleExistingBooking': {
      const has = state.existingBookings.includes(action.value);
      const existingBookings = has
        ? state.existingBookings.filter((entry) => entry !== action.value)
        : [...state.existingBookings, action.value];
      return {
        ...state,
        existingBookings,
        completed: setCriterion(state.completed, 'basic', 'options', true),
      };
    }

    case 'adjustTraveler': {
      let next: PlannerState = state;
      if (action.kind === 'adults') {
        // 成人不能减到 0：N-07 要求人数 > 0，减到 0 会让提交必然被拒
        next = { ...next, adults: Math.max(1, Math.min(20, state.adults + action.delta)) };
      } else if (action.kind === 'children') {
        const count = Math.max(0, Math.min(10, state.childAges.length + action.delta));
        next = {
          ...next,
          childAges: Array.from({ length: count }, (_, i) => state.childAges[i] ?? state.childAge),
        };
      } else {
        next = {
          ...next,
          seniorCount: Math.max(0, Math.min(10, state.seniorCount + action.delta)),
        };
      }
      return { ...next, completed: setCriterion(next.completed, 'travelers', 'counts', true) };
    }

    case 'setChildAge':
      return {
        ...state,
        childAge: action.value,
        childAges: state.childAges.map(() => action.value),
        completed: setCriterion(state.completed, 'travelers', 'details', true),
      };

    case 'setSeniorMobility': {
      /*
       * 先撤掉本函数管理的全部码，再按新档加回。
       *
       * 增量式修改（只加不减）会让「先选轮椅、再改回正常」留下一条
       * accessibility.wheelchair —— 而那是硬约束，会实际改变生成结果，
       * 且界面上完全看不出它还在。
       */
      const conditions = { ...state.conditions };
      for (const code of ALL_MOBILITY_CODES) delete conditions[code];
      for (const code of MOBILITY_CODES[action.value]) conditions[code] = 'REQUIRE';

      return {
        ...state,
        seniorMobility: action.value,
        conditions,
        completed: setCriterion(state.completed, 'travelers', 'details', true),
      };
    }

    case 'selectBudgetTier': {
      const preset = BUDGET_TIER_PRESETS.find((item) => item.tier === action.tier);
      const bounds = preset === undefined ? { min: state.budgetMin, max: state.budgetMax } : preset;
      return {
        ...state,
        budgetTier: action.tier,
        budgetMin: bounds.min,
        budgetMax: bounds.max,
        completed: setCriterion(state.completed, 'budget', 'range', true),
      };
    }

    case 'setBudgetDaily': {
      const raw =
        action.side === 'min'
          ? { min: action.value, max: state.budgetMax }
          : { min: state.budgetMin, max: action.value };
      const bounds = clampBudget(raw.min, raw.max, action.side);
      return {
        ...state,
        ...bounds,
        budgetMin: bounds.min,
        budgetMax: bounds.max,
        /*
         * 手动调整即切到自定义档。不切的话界面上「舒适标准」仍然高亮，
         * 而实际区间已经不是它了 —— 用户看到的档位名与发出的 min/max 不符。
         */
        budgetTier: 'CUSTOM',
        completed: setCriterion(state.completed, 'budget', 'range', true),
      };
    }

    case 'toggleIncludedItem': {
      const has = state.includedItems.includes(action.item);
      /*
       * 至少留一个：契约允许不传 included_items（走默认集），但**不允许显式
       * 传空数组**。界面上放行「全不选」会让提交必然失败，
       * 而错误码是 REQ_SCHEMA_INVALID —— 定位不到任何表单项。
       */
      if (has && state.includedItems.length === 1) return state;

      const includedItems = has
        ? state.includedItems.filter((entry) => entry !== action.item)
        : BUDGET_INCLUDED_ITEM_VALUES.filter(
            (entry) => entry === action.item || state.includedItems.includes(entry),
          );
      return {
        ...state,
        includedItems,
        completed: setCriterion(state.completed, 'budget', 'inclusions', true),
      };
    }

    case 'setPaceIntensity':
      return {
        ...state,
        paceIntensity: action.value,
        completed: setCriterion(state.completed, 'pace', 'intensity', true),
      };

    case 'setWalkingLimit':
      return {
        ...state,
        walkingLimitKm: action.value,
        completed: setCriterion(state.completed, 'pace', 'limits', true),
      };

    case 'setRouteShape':
      return {
        ...state,
        routeShape: action.value,
        completed: setCriterion(state.completed, 'pace', 'route', true),
      };

    case 'cycleCondition': {
      const next = NEXT_STANCE[state.conditions[action.code] ?? 'NONE'];
      const conditions = { ...state.conditions };
      // 回到未选时删键而不是留 undefined：后者会被 Object.entries 数进去，
      // 于是右栏显示「1 项」而三个分组都是空的
      if (next === undefined) delete conditions[action.code];
      else conditions[action.code] = next;

      const criterion = criterionForCode(action.code);
      if (criterion === null) return { ...state, conditions };

      /*
       * 还有标签在选中 → 置位；全取消了 → 通常撤位。
       *
       * 例外是 `alsoSetByControls` 的组（第 2 步）：那个细项另有来源（儿童年龄、
       * 长者行动能力），撤位会把别人挣的分一起抹掉，而那两个输入框里的值还在。
       */
      const stillSelected = anySelectedFor(conditions, criterion);
      const keep = stillSelected || groupAlsoSetByControls(action.code);

      return {
        ...state,
        conditions,
        /*
         * `criterion[1] as never`：`setCriterion` 的第三参按步骤收窄到该步的
         * 细项名，而这里的步骤是运行期算出来的（`criterionForCode`），
         * 编译期无法把两者关联。`as never` 是这个泛型签名下唯一能通过的写法 ——
         * 对应关系由 `TAG_GROUPS` 与 `STEP_CRITERIA` 一起保证，
         * 且「标签只给自己那一步记分」有测试守着。
         */
        completed: setCriterion(state.completed, criterion[0], criterion[1] as never, keep),
      };
    }

    case 'toggleNoSpecialRequirements': {
      const noSpecialRequirements = !state.noSpecialRequirements;
      /*
       * 「我没有」是一个明确的回答，与「还没填」不同 —— 因此它把整步算完。
       *
       * 取消勾选时退回未达成：勾选时已经把 `customText` 清空了，所以此刻这一步
       * 确实什么都没有。这里不去看 `customText` 是因为它必然是空串。
       */
      return {
        ...state,
        noSpecialRequirements,
        customText: noSpecialRequirements ? '' : state.customText,
        completed: setCriterion(state.completed, 'custom', 'answered', noSpecialRequirements),
      };
    }

    default: {
      /*
       * 穷尽性检查：漏一个 action 分支是编译错误而不是「点了没反应」。
       * 后者在界面上极难定位 —— 用户以为是自己没点中。
       */
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * 文本字段变化后重算相关细项。
 *
 * 抽出来是因为 `origin` / `destination` / `startDate` / `endDate` 四个字段
 * 共同决定 basic 的两个细项，而「目的地未定」这个开关也参与其中 ——
 * 分散在各 case 里必然漏一处。
 */
function recomputeText(state: PlannerState, field: TextField | 'destination'): PlannerState {
  let completed = state.completed;

  if (field === 'origin' || field === 'destination') {
    const hasRoute =
      state.origin.trim().length > 0 &&
      (state.destination.trim().length > 0 || state.destinationUndecided);
    completed = setCriterion(completed, 'basic', 'route', hasRoute);
  }

  if (field === 'startDate' || field === 'endDate') {
    // 日期倒置不算达成：N-02 会拒它，给分会让用户以为填好了
    const both = state.startDate.length > 0 && state.endDate.length > 0;
    const ordered = both && Date.parse(state.endDate) >= Date.parse(state.startDate);
    completed = setCriterion(completed, 'basic', 'dates', ordered);
  }

  if (field === 'customText') {
    const hasText = state.customText.trim().length > 0;
    /*
     * 写了文字就是给出了明确回答，整步算完 —— 与勾「我没有」等价。
     *
     * 原来这里只给 `input` 的 4 分，还额外把 `confirmed` 清掉，于是写了文字
     * 的用户被锁在 91%（见 `STEP_CRITERIA.custom` 的说明）。
     */
    completed = setCriterion(completed, 'custom', 'answered', hasText);
    return {
      ...state,
      // 打字即取消「我没有其他特殊需求」—— 两者是互斥的回答
      noSpecialRequirements: hasText ? false : state.noSpecialRequirements,
      completed,
    };
  }

  if (field === 'attractionsPerDay' || field === 'earliestDeparture') {
    completed = setCriterion(completed, 'pace', 'limits', true);
  }

  return { ...state, completed };
}

// ── 构造请求 ────────────────────────────────────────────────

/**
 * `PlannerState` → 请求体。
 *
 * 在 `buildTravelRequest` 的产物上补三类东西，而不是重写它：
 *   1. 增量 0b 新增的三个契约字段（`existing_bookings`、`tier`、`intensity`）
 *   2. 原型采集到但基础表单没有的 pace 数值项与 `included_items`
 *   3. 无契约落点的两项（路线结构、「频繁休息」）拼进 `raw_text`
 *
 * 复用而不是另写一份：`buildTravelRequest` 里那些「界面看不出对错」的映射
 * （三态 → mode/value、无障碍与饮食强制 MUST）已有 20 条测试守着，
 * 复制一份必然与它分叉，而分叉的表现是「勾了轮椅却发 SHOULD」。
 */
export function buildPlannerRequest(
  state: PlannerState,
  options: BuildRequestOptions,
): TravelRequestUIInput {
  const base = buildTravelRequest(state, options);
  const notes = derivedNotes(state);
  const rawText = [state.customText.trim(), notes].filter((part) => part.length > 0).join(' ');

  /** 「2~3」→ [2, 3]；「尽可能多」→ 只给下限，让模型自行决定上限 */
  const attractions = ((): { min?: number; max?: number } => {
    const matched = /^(\d+)(?:~(\d+))?$/.exec(state.attractionsPerDay);
    if (matched === null) return { min: 4 };
    const min = Number(matched[1]);
    const max = matched[2] === undefined ? min : Number(matched[2]);
    return { min, max };
  })();

  return {
    ...base,
    trip: { ...base.trip, existing_bookings: [...state.existingBookings] },
    budget: {
      ...base.budget,
      included_items: [...state.includedItems],
      ...(state.budgetTier === undefined ? {} : { tier: state.budgetTier }),
    },
    pace: {
      ...base.pace,
      intensity: state.paceIntensity,
      walking_limit_km: state.walkingLimitKm,
      earliest_departure_time: state.earliestDeparture,
      ...(attractions.min === undefined ? {} : { attractions_per_day_min: attractions.min }),
      ...(attractions.max === undefined ? {} : { attractions_per_day_max: attractions.max }),
    },
    custom_requirements: { raw_text: rawText },
  };
}
