import { CONDITION_CODE_VALUES, TravelRequestUISchema, type ConditionCode } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  BUDGET_TIER_PRESETS,
  INITIAL_PLANNER_STATE,
  PACE_INTENSITY_LABEL,
  ROUTE_SHAPES,
  STEP_CRITERIA,
  STEP_IDS,
  STEP_WEIGHTS,
  TAG_GROUPS,
  buildPlannerRequest,
  criterionForCode,
  overallProgress,
  plannerReducer,
  stepIsComplete,
  stepScore,
  type PlannerState,
} from './planner-state.js';

/**
 * 采集界面的状态层（TP-8-07）。
 *
 * 这里守的是**界面上看不出对错的三件事**：
 *   - 完成度百分比的权重分配（看到 62% 时没人能判断它该不该是 62%）
 *   - 三态的点击循环（漏一态的表现是「点不出红色」，容易被当成手滑）
 *   - 预算区间的归一化（min > max 的倒挂区间会被服务端 N-04 拒，
 *     而用户只看到「请求失败」）
 *
 * 组件层不测：它们只做 props → DOM，而那部分由视觉基线与人工核对覆盖。
 */

/** 走一串 action，返回末态。比嵌套调用可读 */
function run(
  state: PlannerState,
  ...actions: readonly Parameters<typeof plannerReducer>[1][]
): PlannerState {
  return actions.reduce(plannerReducer, state);
}

describe('七步与完成度权重', () => {
  it('七步权重之和恰好 100', () => {
    /*
     * 不是 100 的话进度条永远到不了（或超过）100%，而那个数字是用户唯一能
     * 看到的「还差多少」信号。
     */
    const total = STEP_IDS.reduce((sum, id) => sum + STEP_WEIGHTS[id], 0);
    expect(total).toBe(100);
  });

  it('每一步的细项权重之和等于该步权重', () => {
    // 细项加起来比步骤权重小 → 那一步永远无法完成，圆点永远不变绿
    for (const id of STEP_IDS) {
      const sum = Object.values(STEP_CRITERIA[id]).reduce((a, b) => a + b, 0);
      expect(sum, `${id} 的细项权重之和不等于 ${STEP_WEIGHTS[id]}`).toBe(STEP_WEIGHTS[id]);
    }
  });

  it('46 个条件码在 TAG_GROUPS 里各出现恰好一次', () => {
    /*
     * 出现两次 = 同一个标签有两个入口，而在其中一个入口点它会让**另一步**变绿
     * （历史上就有三处：第 2 步的亲子房/单一住宿基地记到第 5 步、第 3 步的购物
     * 记到第 6 步）。出现零次 = 那个 code 在界面上无从表达。
     */
    const seen = new Map<string, number>();
    for (const group of TAG_GROUPS) {
      for (const code of group.codes) seen.set(code, (seen.get(code) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([code]) => code);
    expect(duplicated, '这些 code 有多个入口').toEqual([]);

    const missing = CONDITION_CODE_VALUES.filter((code) => !seen.has(code));
    expect(missing, '这些 code 在界面上没有入口').toEqual([]);
  });

  it('点一个标签只给它所在的那一步记分', () => {
    /*
     * 这是「点了这里、别处变绿」的守卫。原来按域推断归属，而域与界面上的实际
     * 分组不一致 —— 用户点第 2 步的「亲子房」，第 5 步的圆点亮了。
     */
    for (const group of TAG_GROUPS) {
      for (const code of group.codes) {
        const state = plannerReducer(INITIAL_PLANNER_STATE, { type: 'cycleCondition', code });
        const scored = STEP_IDS.filter((step) => stepScore(state, step) > 0);

        if (group.step === null) {
          expect(scored, `${code} 不该给任何一步记分`).toEqual([]);
        } else {
          expect(scored, `${code} 只该给 ${group.step} 记分`).toEqual([group.step]);
        }
      }
    }
  });

  it('criterionForCode 与 TAG_GROUPS 一致', () => {
    for (const group of TAG_GROUPS) {
      for (const code of group.codes as readonly ConditionCode[]) {
        const criterion = criterionForCode(code);
        if (group.step === null) {
          expect(criterion, `${code} 不该有细项`).toBeNull();
        } else {
          expect(criterion, `${code} 的细项`).toEqual([group.step, group.criterion]);
        }
      }
    }
  });

  it('一次真实的完整填写能走到 100%，且七步全部变绿', () => {
    /*
     * 这条断言此前**不存在** —— 既有用例只验「权重之和是 100」与「上限不超过
     * 100」，而那两条对「某个细项压根没有正向路径」完全无感。
     *
     * 实际就漏过一个：`custom.confirmed` 的 9 分原本靠原型的「解析为旅行条件」
     * 按钮达成，按钮删了权重留着，于是写了特殊需求的用户被锁在 91%。
     *
     * 用一条走到底的路径守它：任何一个细项失去可达路径，这里就红。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      // 第 1 步
      { type: 'setText', field: 'origin', value: '上海' },
      { type: 'setText', field: 'destination', value: '杭州' },
      { type: 'setText', field: 'startDate', value: '2026-10-01' },
      { type: 'setText', field: 'endDate', value: '2026-10-03' },
      { type: 'toggleExistingBooking', value: 'LODGING' },
      /*
       * 第 2 步：**只有成人**，不加儿童也不加长者。
       *
       * 这是第二处缺陷的复现路径：`travelers.details` 的 7 分原来只能由
       * 儿童年龄／长者行动能力两个控件达成，而它们只在有儿童或长者时才渲染 ——
       * 两个成人出门的用户拿不到那 7 分，完成度上限 93%，第 2 步永远不变绿。
       * 现在第 2 步的标签组接到了这个细项（原型本来就是这么接的）。
       */
      { type: 'adjustTraveler', kind: 'adults', delta: 1 },
      { type: 'cycleCondition', code: 'accommodation.single_base' },
      // 第 3 步
      { type: 'selectBudgetTier', tier: 'STANDARD' },
      { type: 'toggleIncludedItem', item: 'SHOPPING' },
      { type: 'cycleCondition', code: 'budget.lodging_quality' },
      // 第 4 步
      { type: 'setPaceIntensity', value: 4 },
      { type: 'setWalkingLimit', value: 5 },
      { type: 'setRouteShape', value: 'hub' },
      // 第 5 步
      { type: 'cycleCondition', code: 'transport.public_transit' },
      { type: 'cycleCondition', code: 'accommodation.hotel' },
      { type: 'cycleCondition', code: 'accommodation.elevator' },
      // 第 6 步
      { type: 'cycleCondition', code: 'interest.food' },
      // 第 7 步：写了真实的特殊需求，**不是**勾「我没有」
      { type: 'setText', field: 'customText', value: '孩子对花生过敏，长辈腿脚不好。' },
    );

    for (const id of STEP_IDS) {
      expect(stepIsComplete(state, id), `${id} 应当已完成`).toBe(true);
    }
    expect(overallProgress(state)).toBe(100);
  });

  it('默认预填值不计入完成度', () => {
    /*
     * 原型的规则：只有用户主动编辑后才计入。不遵守它的话首屏就显示 40%，
     * 而那个数字对用户没有任何信息量 —— 他什么都还没填。
     */
    expect(overallProgress(INITIAL_PLANNER_STATE)).toBe(0);
    for (const id of STEP_IDS) {
      expect(stepScore(INITIAL_PLANNER_STATE, id), `${id} 初始不应有分`).toBe(0);
      expect(stepIsComplete(INITIAL_PLANNER_STATE, id)).toBe(false);
    }
  });

  it('填完出发地目的地与日期后，第一步拿到 route + dates 的分', () => {
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'origin', value: '上海' },
      { type: 'setText', field: 'destination', value: '杭州' },
      { type: 'setText', field: 'startDate', value: '2026-10-01' },
      { type: 'setText', field: 'endDate', value: '2026-10-03' },
    );

    const expected = STEP_CRITERIA.basic.route + STEP_CRITERIA.basic.dates;
    expect(stepScore(state, 'basic')).toBe(expected);
    // 还差 options 那一项，因此整步未完成
    expect(stepIsComplete(state, 'basic')).toBe(false);
  });

  it('目的地未定时，只填出发地也算 route 达成', () => {
    /*
     * 03「目的地尚未确定」是纯前端项（V1 不支持），但它必须影响完成度 ——
     * 否则勾了它的用户永远差 5 分而界面上看不出差在哪。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'origin', value: '上海' },
      { type: 'toggleDestinationUndecided' },
    );
    expect(stepScore(state, 'basic')).toBeGreaterThanOrEqual(STEP_CRITERIA.basic.route);
  });

  it('日期倒置不算 dates 达成', () => {
    // N-02 会拒它。本地不重复实现业务规则，但也不该给分让用户以为填好了
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'startDate', value: '2026-10-05' },
      { type: 'setText', field: 'endDate', value: '2026-10-01' },
    );
    expect(stepScore(state, 'basic')).toBe(0);
  });

  it('完成度是各步已达细项的权重和，上限 100', () => {
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'origin', value: '上海' },
      { type: 'setText', field: 'destination', value: '杭州' },
      { type: 'setText', field: 'startDate', value: '2026-10-01' },
      { type: 'setText', field: 'endDate', value: '2026-10-03' },
    );
    expect(overallProgress(state)).toBe(STEP_CRITERIA.basic.route + STEP_CRITERIA.basic.dates);
    expect(overallProgress(state)).toBeLessThanOrEqual(100);
  });
});

describe('三态流转', () => {
  it('点击顺序是 未选 → 偏好 → 必须 → 不要 → 未选', () => {
    let state = INITIAL_PLANNER_STATE;
    const stances = [];
    for (let i = 0; i < 4; i += 1) {
      state = plannerReducer(state, { type: 'cycleCondition', code: 'interest.food' });
      stances.push(state.conditions['interest.food']);
    }
    expect(stances).toEqual(['PREFER', 'REQUIRE', 'EXCLUDE', undefined]);
  });

  it('回到未选时把键删掉而不是留一个 undefined', () => {
    /*
     * 留着 `{'interest.food': undefined}` 的话，`Object.entries` 会数出一条，
     * 于是右栏摘要显示「1 项」而三个分组都是空的。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'cycleCondition', code: 'interest.food' },
    );
    expect('interest.food' in state.conditions).toBe(false);
  });

  it('兴趣标签一旦选中，第 6 步的 selection 细项达成', () => {
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'cycleCondition',
      code: 'interest.city_walk',
    });
    expect(stepScore(state, 'interests')).toBe(STEP_CRITERIA.interests.selection);
    expect(stepIsComplete(state, 'interests')).toBe(true);
  });

  it('标签按域计入对应步骤，而不是全部计到兴趣上', () => {
    /*
     * 第 5 步（交通住宿）有三个细项：交通方式、住宿类型、住宿要求。
     * 全都算到 interests 上会让「勾了公共交通，兴趣那步却变绿」——
     * 而用户点的是另一个区块。
     */
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'cycleCondition',
      code: 'transport.public_transit',
    });
    expect(stepScore(state, 'transport')).toBe(STEP_CRITERIA.transport.mode);
    expect(stepScore(state, 'interests')).toBe(0);
  });

  it('budget 域的标签计到第 3 步的 focus 细项', () => {
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'cycleCondition',
      code: 'budget.lodging_quality',
    });
    expect(stepScore(state, 'budget')).toBe(STEP_CRITERIA.budget.focus);
  });

  it('取消最后一个标签后，对应细项退回未达成', () => {
    // 只加不减的实现会让完成度只增不降，而那让它变成一个没有信息量的数字
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'cycleCondition', code: 'interest.city_walk' }, // PREFER
      { type: 'cycleCondition', code: 'interest.city_walk' }, // REQUIRE
      { type: 'cycleCondition', code: 'interest.city_walk' }, // EXCLUDE
      { type: 'cycleCondition', code: 'interest.city_walk' }, // 未选
    );
    expect(stepScore(state, 'interests')).toBe(0);
  });
});

describe('预算档位与区间', () => {
  it('五个档位的区间与原型一致且首尾相接', () => {
    expect(BUDGET_TIER_PRESETS.map((t) => t.tier)).toEqual([
      'ECONOMY',
      'STANDARD',
      'QUALITY',
      'LUXURY',
    ]);
    // 首尾相接：上一档的 max 就是下一档的 min，否则会有落在缝里的预算
    for (let i = 1; i < BUDGET_TIER_PRESETS.length; i += 1) {
      expect(BUDGET_TIER_PRESETS[i]!.min).toBe(BUDGET_TIER_PRESETS[i - 1]!.max);
    }
  });

  it('选档位把区间与 tier 一起设好', () => {
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'selectBudgetTier',
      tier: 'QUALITY',
    });
    const preset = BUDGET_TIER_PRESETS.find((t) => t.tier === 'QUALITY')!;
    expect(state.budgetMin).toBe(preset.min);
    expect(state.budgetMax).toBe(preset.max);
    expect(state.budgetTier).toBe('QUALITY');
    expect(stepScore(state, 'budget')).toBe(STEP_CRITERIA.budget.range);
  });

  it('拖动滑块自动切到自定义档', () => {
    /*
     * 不切的话界面上「舒适标准」仍然高亮，而实际区间已经不是它了 ——
     * 用户看到的档位名与发出去的 min/max 不符。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'selectBudgetTier', tier: 'STANDARD' },
      { type: 'setBudgetDaily', side: 'min', value: 950 },
    );
    expect(state.budgetTier).toBe('CUSTOM');
    expect(state.budgetMin).toBe(950);
  });

  it('min 超过 max 时把另一侧顶上去，不产生倒挂区间', () => {
    // 倒挂区间会被 N-04 拒（REQ_BUDGET_RANGE_INVALID），而用户只看到「请求失败」
    const raised = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setBudgetDaily',
      side: 'min',
      value: 9_000,
    });
    expect(raised.budgetMax).toBeGreaterThanOrEqual(raised.budgetMin);

    const lowered = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setBudgetDaily',
      side: 'max',
      value: 50,
    });
    expect(lowered.budgetMin).toBeLessThanOrEqual(lowered.budgetMax);
  });

  it('预算下限不低于 100', () => {
    // 滑块下界。N-12 的物理下限是 50 元/人/天，100 给它留了余量
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setBudgetDaily',
      side: 'min',
      value: 0,
    });
    expect(state.budgetMin).toBeGreaterThanOrEqual(100);
  });

  it('包含项至少留一个：取消最后一个不生效', () => {
    /*
     * 契约允许不传 included_items（走默认集），但**不允许显式传空数组**。
     * 界面上放行「全不选」会让提交必然失败，而错误码是 REQ_SCHEMA_INVALID
     * —— 定位不到任何表单项。
     */
    let state = INITIAL_PLANNER_STATE;
    for (const item of [...INITIAL_PLANNER_STATE.includedItems]) {
      state = plannerReducer(state, { type: 'toggleIncludedItem', item });
    }
    expect(state.includedItems.length).toBeGreaterThan(0);
  });
});

describe('节奏与路线（第 4 步）', () => {
  it('五档强度各有中文名', () => {
    for (const intensity of [1, 2, 3, 4, 5] as const) {
      expect(PACE_INTENSITY_LABEL[intensity].length).toBeGreaterThan(0);
    }
  });

  it('设置强度计入 intensity 细项，且值原样保留', () => {
    /*
     * 原样保留而不是折算成 PaceLevel：契约里 intensity 与 level 并存，
     * 且「数值与 level 冲突时以数值为准」。在状态层就折算会丢掉两档。
     */
    const state = plannerReducer(INITIAL_PLANNER_STATE, { type: 'setPaceIntensity', value: 5 });
    expect(state.paceIntensity).toBe(5);
    expect(stepScore(state, 'pace')).toBe(STEP_CRITERIA.pace.intensity);
  });

  it('八种路线结构，选中即计入 route 细项', () => {
    expect(ROUTE_SHAPES).toHaveLength(8);
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setRouteShape',
      value: ROUTE_SHAPES[0]!.id,
    });
    expect(state.routeShape).toBe(ROUTE_SHAPES[0]!.id);
    expect(stepScore(state, 'pace')).toBe(STEP_CRITERIA.pace.route);
  });
});

describe('第 2 步的标签组与儿童年龄共用同一个细项', () => {
  it('只有成人时也能靠标签组完成第 2 步', () => {
    /*
     * `travelers.details` 的另一条路径（儿童年龄／长者行动能力）只在有儿童或
     * 长者时才渲染控件，因此两个成人出门的用户只剩标签这一条路。
     * 原来第 2 步的标签按域记到了第 5 步 —— 于是那 7 分谁都拿不到。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'adjustTraveler', kind: 'adults', delta: 1 },
      { type: 'cycleCondition', code: 'accommodation.single_base' },
    );
    expect(stepIsComplete(state, 'travelers')).toBe(true);
  });

  it('取消标签不抹掉儿童年龄挣来的分', () => {
    /*
     * 两个来源共用一个细项，因此撤位要小心：把标签点上再取消，
     * 不能连带把「填了儿童年龄」那一份也撤掉 —— 那个输入框里的值还在。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'adjustTraveler', kind: 'children', delta: 1 },
      { type: 'setChildAge', value: 6 },
      // 点四次回到未选
      { type: 'cycleCondition', code: 'accommodation.family_room' },
      { type: 'cycleCondition', code: 'accommodation.family_room' },
      { type: 'cycleCondition', code: 'accommodation.family_room' },
      { type: 'cycleCondition', code: 'accommodation.family_room' },
    );
    expect(state.conditions['accommodation.family_room']).toBeUndefined();
    expect(stepIsComplete(state, 'travelers')).toBe(true);
  });

  it('纯标签驱动的细项，取消最后一个仍然退回未达成', () => {
    // 只有第 2 步那一组是双来源，其余各组不该跟着变宽松
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'cycleCondition', code: 'interest.food' },
    );
    expect(state.conditions['interest.food']).toBeUndefined();
    expect(stepIsComplete(state, 'interests')).toBe(false);
    expect(stepScore(state, 'interests')).toBe(0);
  });
});

describe('第 7 步：特殊需求', () => {
  it('写了文字就把整步算完（回归：曾经只给 4/13）', () => {
    /*
     * 原型这一步是 `{ input: 4, confirmed: 9 }`，那 9 分靠「解析为旅行条件 →
     * 确认并添加」达成。那个按钮被删掉后权重留了下来，于是写了文字的用户
     * 最高只能拿 4/13、第 7 步永远不变绿，而勾「我没有」反而满分 ——
     * 越认真的用户分越低，且没有任何办法补上。
     */
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setText',
      field: 'customText',
      value: '孩子对花生过敏',
    });
    expect(stepScore(state, 'custom')).toBe(STEP_WEIGHTS.custom);
    expect(stepIsComplete(state, 'custom')).toBe(true);
  });

  it('清空文字后退回未达成', () => {
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'customText', value: '孩子对花生过敏' },
      { type: 'setText', field: 'customText', value: '   ' },
    );
    expect(stepIsComplete(state, 'custom')).toBe(false);
  });

  it('写文字与勾「我没有」两条路径等价 —— 都是明确回答', () => {
    const byText = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setText',
      field: 'customText',
      value: '不要红眼航班',
    });
    const byCheckbox = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'toggleNoSpecialRequirements',
    });
    expect(stepScore(byText, 'custom')).toBe(stepScore(byCheckbox, 'custom'));
  });

  it('勾「没有其他特殊需求」直接把整步算完，并清空文字', () => {
    /*
     * 「我没有」是一个明确的回答，与「还没填」不同。不给满分的话，
     * 认真回答了「没有」的用户永远卡在 87%。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'customText', value: '随便写点' },
      { type: 'toggleNoSpecialRequirements' },
    );
    expect(state.customText).toBe('');
    expect(stepIsComplete(state, 'custom')).toBe(true);
  });

  it('勾了「没有」之后又开始打字，则取消该勾选但整步仍算完成', () => {
    /*
     * 两者互斥，因此勾选被取消 —— 但用户此刻给出的是另一种明确回答，
     * 这一步照样算完。
     *
     * 这条断言原来写的是 `stepIsComplete(...) === false`，把缺陷本身编码进了
     * 测试：那正是「写了文字反而不算完成」的表现。
     */
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'toggleNoSpecialRequirements' },
      { type: 'setText', field: 'customText', value: '老人走不了太多路' },
    );
    expect(state.noSpecialRequirements).toBe(false);
    expect(stepIsComplete(state, 'custom')).toBe(true);
  });
});

describe('同行人计数', () => {
  it('成人不能减到 0，儿童与长者可以', () => {
    // adults 是必填字段且 N-07 要求人数 > 0，减到 0 会让提交必然被拒
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'adjustTraveler', kind: 'adults', delta: -5 },
      { type: 'adjustTraveler', kind: 'children', delta: -5 },
    );
    expect(state.adults).toBe(1);
    expect(state.childAges).toEqual([]);
  });

  it('加儿童时补一个默认年龄，减时从末尾去掉', () => {
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'adjustTraveler', kind: 'children', delta: 1 },
      { type: 'adjustTraveler', kind: 'children', delta: 1 },
    );
    expect(state.childAges).toHaveLength(2);
    expect(stepScore(state, 'travelers')).toBe(STEP_CRITERIA.travelers.counts);

    const back = plannerReducer(state, { type: 'adjustTraveler', kind: 'children', delta: -1 });
    expect(back.childAges).toHaveLength(1);
  });

  it('长者行动能力选到「需轮椅」时落成硬约束码', () => {
    /*
     * 第二轮决策：13「老人行动能力」拆到既有的两个 accessibility 码，
     * 而不是新造一个四值枚举。落成 code 才受 V-30 校验保护。
     */
    const state = plannerReducer(INITIAL_PLANNER_STATE, {
      type: 'setSeniorMobility',
      value: 'WHEELCHAIR',
    });
    expect(state.conditions['accessibility.wheelchair']).toBe('REQUIRE');
  });

  it('行动能力改回「正常」时撤掉那两个码', () => {
    const state = run(
      INITIAL_PLANNER_STATE,
      { type: 'setSeniorMobility', value: 'WHEELCHAIR' },
      { type: 'setSeniorMobility', value: 'NORMAL' },
    );
    expect('accessibility.wheelchair' in state.conditions).toBe(false);
    expect('accessibility.low_walking' in state.conditions).toBe(false);
  });
});

describe('重置', () => {
  it('回到初始态且完成度归零', () => {
    const dirty = run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'origin', value: '上海' },
      { type: 'cycleCondition', code: 'interest.food' },
      { type: 'selectBudgetTier', tier: 'LUXURY' },
    );
    expect(overallProgress(dirty)).toBeGreaterThan(0);

    const clean = plannerReducer(dirty, { type: 'reset' });
    expect(clean).toEqual(INITIAL_PLANNER_STATE);
    expect(overallProgress(clean)).toBe(0);
  });
});

describe('buildPlannerRequest：新字段真的发出去了', () => {
  const options = { clientRequestId: 'planner-1', timezone: 'Asia/Shanghai' };

  /** 填到能通过 schema 的最小程度 */
  function ready(...actions: readonly Parameters<typeof plannerReducer>[1][]): PlannerState {
    return run(
      INITIAL_PLANNER_STATE,
      { type: 'setText', field: 'origin', value: '上海' },
      { type: 'setText', field: 'destination', value: '杭州' },
      { type: 'setText', field: 'startDate', value: '2026-10-01' },
      { type: 'setText', field: 'endDate', value: '2026-10-03' },
      ...actions,
    );
  }

  function parsed(state: PlannerState) {
    const result = TravelRequestUISchema.safeParse(buildPlannerRequest(state, options));
    if (!result.success) {
      throw new Error(`构造出的请求不合法：${JSON.stringify(result.error.issues)}`);
    }
    return result.data;
  }

  it('产物满足契约', () => {
    expect(parsed(ready()).schema_version).toBe('travel_request_ui_v1');
  });

  it('三个新契约字段被带上', () => {
    const request = parsed(
      ready(
        { type: 'toggleExistingBooking', value: 'LODGING' },
        { type: 'selectBudgetTier', tier: 'QUALITY' },
        { type: 'setPaceIntensity', value: 5 },
      ),
    );
    expect(request.trip.existing_bookings).toEqual(['LODGING']);
    expect(request.budget.tier).toBe('QUALITY');
    expect(request.pace.intensity).toBe(5);
  });

  it('没选档位时不发 tier，而不是发一个猜的值', () => {
    // 「没选档位」与「档位是经济」不是一回事 —— 契约刻意不给它默认值
    expect(parsed(ready()).budget.tier).toBeUndefined();
  });

  it('「2~3 个景点」拆成上下限', () => {
    const request = parsed(ready());
    expect(request.pace.attractions_per_day_min).toBe(2);
    expect(request.pace.attractions_per_day_max).toBe(3);
  });

  it('「尽可能多」只给下限，不编一个上限', () => {
    const request = parsed(
      ready({ type: 'setText', field: 'attractionsPerDay', value: '尽可能多' }),
    );
    expect(request.pace.attractions_per_day_min).toBeGreaterThan(0);
    expect(request.pace.attractions_per_day_max).toBeUndefined();
  });

  it('包含项按界面所选提交', () => {
    const request = parsed(ready({ type: 'toggleIncludedItem', item: 'SHOPPING' }));
    expect(request.budget.included_items).toContain('SHOPPING');
  });

  it('路线结构与「频繁休息」拼进自由文本，且与用户原文可分辨', () => {
    /*
     * 这两项在契约里没有落点。拼进 raw_text 时加「补充：」前缀 ——
     * 混进用户原文的话，他在结果页看到的「你的需求」里会出现自己没写过的句子。
     */
    const request = parsed(
      ready(
        { type: 'setText', field: 'customText', value: '想看运河。' },
        { type: 'setRouteShape', value: 'island' },
        { type: 'adjustTraveler', kind: 'seniors', delta: 1 },
        { type: 'setSeniorMobility', value: 'FREQUENT_REST' },
      ),
    );
    const text = request.custom_requirements.raw_text;
    expect(text).toContain('想看运河。');
    expect(text).toContain('补充：');
    expect(text).toContain('跳岛');
    expect(text).toContain('频繁休息');
  });

  it('什么补充都没有时不留一个孤零零的「补充：」', () => {
    expect(parsed(ready()).custom_requirements.raw_text).toBe('');
  });

  it('行动能力落成的硬约束码进 conditions 且是 MUST', () => {
    const request = parsed(
      ready(
        { type: 'adjustTraveler', kind: 'seniors', delta: 1 },
        { type: 'setSeniorMobility', value: 'WHEELCHAIR' },
      ),
    );
    const wheelchair = request.conditions.find((c) => c.code === 'accessibility.wheelchair');
    expect(wheelchair).toEqual({ code: 'accessibility.wheelchair', mode: 'MUST', value: true });
  });

  it('三态里的「不要」发成 MUST + value:false', () => {
    const request = parsed(
      ready(
        { type: 'cycleCondition', code: 'accommodation.shared_dorm' },
        { type: 'cycleCondition', code: 'accommodation.shared_dorm' },
        { type: 'cycleCondition', code: 'accommodation.shared_dorm' },
      ),
    );
    expect(request.conditions).toContainEqual({
      code: 'accommodation.shared_dorm',
      mode: 'MUST',
      value: false,
    });
  });
});
