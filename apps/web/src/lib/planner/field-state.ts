import { plannerField, type PlannerFieldId } from '@tps/schemas';

import { hasValue, isExplicitEmptyAnswer, readAnswer, type PlannerState } from './state';
import { isTriggered } from './triggers';
import { validateField } from './validation';

/**
 * Field State（规范 5.1 的七态）。
 *
 * 七个态里有两对最容易被合并，而合并的后果都不报错：
 *
 *   `hidden` / `inactive` —— 都不显示，但 inactive **有草稿值**。分开是为了
 *   实现规范 6 的「值保留」：上游改动导致隐藏时保留草稿并标 inactive，
 *   重新触发时恢复。合并成 hidden 会让实现者顺手把值清掉，
 *   而用户改回上游答案后发现自己填的东西没了。
 *
 *   `answered` / `verified` —— 规范 4.3 的核心：用户自报**永远不等于**官方核验结论。
 *   合并会让「用户说签证有效」变成「签证已核验」，而系统据此告诉用户没问题。
 */
export const FIELD_STATE_VALUES = [
  'hidden',
  'inactive',
  'unanswered',
  'answered',
  'invalid',
  'verify_pending',
  'verified',
] as const;
export type FieldState = (typeof FIELD_STATE_VALUES)[number];

/**
 * 计算一个字段的状态。
 *
 * ## `verified` 在本轮永不出现
 *
 * 它要求「需要核验的结论已被可信来源确认」，而后台核验（签证规则、护照有效期、
 * 保险条款、驾驶资格）不在 P9 范围内（见实施计划的「明确不在本轮范围」）。
 * 保留这个态而不是删掉：删了之后接核验的人要同时改状态机与所有分支，
 * 而留着它意味着那时只需给这个函数多传一个核验结果参数。
 */
export function fieldState(state: PlannerState, fieldId: PlannerFieldId): FieldState {
  const spec = plannerField(fieldId);
  const value = readAnswer(state.answers, spec.api_key);
  const explicitEmpty = isExplicitEmptyAnswer(state, fieldId);
  const answered = hasValue(value) || explicitEmpty;

  if (!isTriggered(state, fieldId)) {
    return answered ? 'inactive' : 'hidden';
  }

  /*
   * 校验先于「有没有值」：部分规则（订单卡缺名称、过敏原缺严重程度）在
   * 字段整体「有值」的情况下仍然不合格，而先判 answered 会让它们报不出来。
   */
  if (validateField(state, fieldId) !== null) return 'invalid';

  if (!answered) return 'unanswered';

  /* 明确选择“无”没有外部事实需要核验，即使字段类型是 VERIFY_BLOCKING。 */
  if (explicitEmpty) return 'answered';

  /*
   * VERIFY 两级都落 `verify_pending`：用户答完了，但外部核验没做。
   * 历史字段类型仍保留两级风险分类，但两者都不阻止初步方案生成；
   * 核验优先级属于后台任务，不应该变成用户流程状态。
   */
  if (spec.runtime_type === 'VERIFY_BLOCKING' || spec.runtime_type === 'VERIFY_NONBLOCKING') {
    return 'verify_pending';
  }

  return 'answered';
}

/** 参与完成度与缺失校验的态。`hidden` / `inactive` 都不参与（规范 6）*/
export function countsTowardCompleteness(fieldState_: FieldState): boolean {
  return fieldState_ !== 'hidden' && fieldState_ !== 'inactive';
}

/** 这个态算「已回答」。`verify_pending` 算 —— 用户那一侧确实做完了 */
export function isSatisfied(fieldState_: FieldState): boolean {
  return (
    fieldState_ === 'answered' || fieldState_ === 'verify_pending' || fieldState_ === 'verified'
  );
}

export const FIELD_STATE_LABEL: Record<FieldState, string> = {
  hidden: '未触发',
  inactive: '暂不适用',
  unanswered: '未回答',
  answered: '已回答',
  invalid: '需要修正',
  verify_pending: '待核验',
  verified: '已核验',
};
