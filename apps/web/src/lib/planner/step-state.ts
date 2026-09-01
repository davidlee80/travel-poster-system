import { PLANNER_STEP_IDS, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';

import { fieldState, isSatisfied, type FieldState } from './field-state';
import { fieldsOfStep, readAnswer, type PlannerState } from './state';
import { triggeredFields, unresolvedBlockers } from './triggers';

/**
 * Step State 与 Trip State（规范 5.2、5.3）。
 *
 * ## 步骤状态由字段状态算出来，不由浏览历史推断
 *
 * 规范 5.2 与 24.1 都点名禁止「用户访问过步骤」或「步骤序号小于当前页」
 * 代表完成。原因是它让**上游回改无法回退状态**：用户在第 6 步填完房型后回到
 * 第 2 步删掉一位旅行者，第 6 步的房型配置就不再覆盖全部旅行者了 ——
 * 而按浏览历史算的话它仍然是绿的，用户直到生成失败才知道。
 *
 * 因此这里每次都从 Field State 重算。76 个字段的重算是纯计算，没有性能问题。
 */

export const STEP_STATE_VALUES = [
  'untouched',
  'in-progress',
  'complete',
  'needs-attention',
] as const;
export type StepState = (typeof STEP_STATE_VALUES)[number];

export const TRIP_STATE_VALUES = [
  'draft',
  'ready-for-plan',
  'research-needed',
  'blocked',
  'plan-generated',
] as const;
export type TripState = (typeof TRIP_STATE_VALUES)[number];

/** 一次算好、供左栏与右栏共用的全局快照 */
export interface PlannerSnapshot {
  readonly triggered: readonly PlannerFieldId[];
  readonly states: ReadonlyMap<PlannerFieldId, FieldState>;
  readonly stepStates: ReadonlyMap<PlannerStepId, StepState>;
  readonly tripState: TripState;
  /** 旅行画像完整度，0～100（规范 17.1 的第一个指标）*/
  readonly completeness: number;
  /** 待核验总数（规范 17.1 的第三个指标）*/
  readonly verifyCount: number;
  /** 已触发但未满足的阻塞字段 */
  readonly blockers: readonly PlannerFieldId[];
}

/**
 * 算一次全局快照。
 *
 * 左栏的九个状态点、右栏的三个指标、底部的生成按钮态全部读它 ——
 * 各自现算的话会出现「左栏说这步完成了，生成按钮说还有缺项」，
 * 而那种不一致用户无法自己解释。
 */
export function buildSnapshot(
  state: PlannerState,
  options: { readonly planGenerated?: boolean } = {},
): PlannerSnapshot {
  const triggered = triggeredFields(state);
  const triggeredSet = new Set(triggered);

  const states = new Map<PlannerFieldId, FieldState>();
  for (const fieldId of triggered) states.set(fieldId, fieldState(state, fieldId));

  const blockers = unresolvedBlockers(state);
  const blockerSet = new Set(blockers);

  const stepStates = new Map<PlannerStepId, StepState>();
  for (const step of PLANNER_STEP_IDS) {
    stepStates.set(step, computeStepState(state, step, states, triggeredSet, blockerSet));
  }

  let answered = 0;
  let verifyCount = 0;
  for (const fs of states.values()) {
    if (isSatisfied(fs)) answered += 1;
    if (fs === 'verify_pending') verifyCount += 1;
  }

  /*
   * 完整度 = 已回答的已触发字段 / 已触发字段。
   *
   * **不加权**：规范 17.1 只要求它「反映个性化信息覆盖程度」，没有给权重表。
   * 自己发明一套权重会让这个数字无法解释 —— 而 62% 这个数字对用户唯一的价值
   * 就是「还差不少」，多一层看不见的权重只会让它更难解释。
   *
   * 分母是**已触发**字段数，因此不填条件分支不会拉低分数（规范 6）。
   */
  const completeness = triggered.length === 0 ? 0 : Math.round((answered / triggered.length) * 100);

  return {
    triggered,
    states,
    stepStates,
    tripState: computeTripState(state, {
      blockers,
      verifyCount,
      invalidCount: [...states.values()].filter((fs) => fs === 'invalid').length,
      planGenerated: options.planGenerated ?? false,
    }),
    completeness,
    verifyCount,
    blockers,
  };
}

function computeStepState(
  state: PlannerState,
  step: PlannerStepId,
  states: ReadonlyMap<PlannerFieldId, FieldState>,
  triggeredSet: ReadonlySet<PlannerFieldId>,
  blockerSet: ReadonlySet<PlannerFieldId>,
): StepState {
  const fields = fieldsOfStep(step).filter((spec) => triggeredSet.has(spec.field_id));
  if (fields.length === 0) return 'untouched';

  const touchedHere = fields.some((spec) => state.touched.includes(spec.field_id));

  const hasInvalid = fields.some((spec) => states.get(spec.field_id) === 'invalid');
  /*
   * needs-attention 只表示用户仍需修正无效输入。系统待核验是后台工作，
   * 用户已经完成回答，因此不能让步骤变红或阻止用户继续。
   */
  if (hasInvalid) return 'needs-attention';

  const missingBlockers = fields.filter((spec) => blockerSet.has(spec.field_id));
  if (missingBlockers.length > 0) return touchedHere ? 'in-progress' : 'untouched';

  if (!touchedHere) return 'untouched';

  /*
   * complete = 本步所有已触发 blocker 都满足；非阻塞可选项可留空（规范 5.2）。
   *
   * 不要求「全部字段都填」：那会让第 4 步（8 个字段里 0 个 blocker）永远绿不了，
   * 而用户完全不知道还差什么 —— 这正是规范禁止「用完成度百分比代替步骤状态」的原因。
   */
  const optionalGaps = fields.filter((spec) => {
    const fs = states.get(spec.field_id);
    return fs === 'unanswered' && spec.priority === 'P0';
  });
  return optionalGaps.length === 0 ? 'complete' : 'in-progress';
}

function computeTripState(
  state: PlannerState,
  input: {
    readonly blockers: readonly PlannerFieldId[];
    readonly verifyCount: number;
    readonly invalidCount: number;
    readonly planGenerated: boolean;
  },
): TripState {
  if (input.planGenerated) return 'plan-generated';

  /*
   * draft 先于 blocked：一个刚打开页面、什么都没填的用户不该看到
   * 「已被阻塞，有 11 项缺失」——那是一份问题清单而不是一个起点。
   * 规范 5.3 把 draft 定义成「旅行骨架尚未达到初步方案最小要求」，
   * 而「一个字段都没碰过」显然属于它。
   */
  if (state.touched.length === 0) return 'draft';

  if (input.blockers.length > 0 || input.invalidCount > 0) {
    return 'blocked';
  }

  /* 授权是独立的阻塞项：不同意就不能处理需要敏感数据的功能（规范 15）*/
  if (readAnswer(state.answers, 'privacy.trip_processing_consent') !== true) return 'blocked';

  /* 所有系统待核验项都允许先生成，输出中保留待核验标识。 */
  return input.verifyCount > 0 ? 'research-needed' : 'ready-for-plan';
}

export const STEP_STATE_LABEL: Record<StepState, string> = {
  untouched: '未开始',
  'in-progress': '进行中',
  complete: '已完成',
  'needs-attention': '需要处理',
};

/**
 * Trip State 的按钮文案与语义（规范 18 的状态表）。
 *
 * `blocked` 的按钮**可点击**而不是 disabled —— 规范原文：
 * 「按钮可点击但进入问题定位，不建议纯 disabled；避免用户不知道为何不能生成」。
 * 一个灰掉的按钮不解释任何事，而用户唯一能做的就是把每一步再翻一遍。
 */
export const TRIP_STATE_LABEL: Record<TripState, string> = {
  draft: '继续完善旅行画像',
  'ready-for-plan': '可以生成初步方案',
  'research-needed': '可以生成，仍有系统待核验项',
  blocked: '还有问题需要处理',
  'plan-generated': '已生成初步方案',
};

/**
 * 生成按钮上的文案（规范 18 的状态表）。
 *
 * 与 `TRIP_STATE_LABEL` 分开：那是一句**描述状态**的说明（「还有问题需要处理」），
 * 这是一句**描述点下去会发生什么**的动作（「查看还有什么问题」）。把两者
 * 合成一份的话，按钮上会写着一句陈述句而用户不知道点它干什么。
 *
 * 右栏与第 9 步底部两处共用这一份 —— 两份文案迟早分叉，
 * 而分叉的表现是同一个状态下两个按钮说着不同的话。
 */
export function generateButtonLabel(tripState: TripState, verifyCount: number): string {
  switch (tripState) {
    case 'research-needed':
      return `生成初步方案 · 仍有 ${verifyCount} 项系统待核验`;
    /* 可点击而不是 disabled：点了进入问题定位（规范 18 明确反对纯 disabled）*/
    case 'blocked':
      return '查看还有什么问题';
    case 'draft':
      return '还差几项必答，去看看';
    case 'plan-generated':
      return '重新生成';
    case 'ready-for-plan':
      return '生成初步旅行方案';
    default: {
      const exhaustive: never = tripState;
      return exhaustive;
    }
  }
}
