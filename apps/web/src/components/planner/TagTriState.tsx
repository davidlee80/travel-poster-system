'use client';

import { CONDITION_LABEL } from '@tps/presentation';
import type { ConditionCode } from '@tps/schemas';

import type { ConditionStance } from '@/lib/travel-request-form';

/**
 * 三态标签（原型的 `.tag`）。
 *
 * 一次点击往前走一态：未选 → 偏好 → 必须 → 不要 → 未选。流转表在
 * `lib/planner-state.ts` 的 `NEXT_STANCE`，这里只负责呈现与转发点击 ——
 * 把循环逻辑放进组件的话它就只能靠点四次界面来验证。
 */

/** 三态 → 类名后缀。与 `planner.css` 里的三个修饰类一一对应 */
const STANCE_CLASS: Record<ConditionStance, string> = {
  PREFER: 'planner-tag--prefer',
  REQUIRE: 'planner-tag--require',
  EXCLUDE: 'planner-tag--exclude',
};

/** 无障碍标签用的态名。视觉上靠颜色区分，读屏靠这个 */
const STANCE_TITLE: Record<ConditionStance, string> = {
  PREFER: '偏好',
  REQUIRE: '必须',
  EXCLUDE: '不要',
};

export interface TagTriStateProps {
  readonly code: ConditionCode;
  readonly stance: ConditionStance | undefined;
  readonly onCycle: (code: ConditionCode) => void;
  /** 覆盖显示文字。缺省用 `CONDITION_LABEL`（46 码文案的唯一来源） */
  readonly label?: string;
  readonly hidden?: boolean;
}

export function TagTriState({
  code,
  stance,
  onCycle,
  label,
  hidden = false,
}: TagTriStateProps): React.ReactElement {
  const text = label ?? CONDITION_LABEL[code];
  const className = ['planner-tag', stance === undefined ? '' : STANCE_CLASS[stance]]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      /*
       * `aria-pressed` 只能表达两态，因此附加 `title` 说明当前是哪一态。
       * 三色对读屏用户不可见，而「必须」与「不要」的区别是实质性的。
       */
      aria-pressed={stance !== undefined}
      title={
        stance === undefined ? `${text}（未选，点击设为偏好）` : `${text}：${STANCE_TITLE[stance]}`
      }
      hidden={hidden}
      onClick={() => onCycle(code)}
    >
      {text}
    </button>
  );
}

/** 三色图例（原型的 `.tag-legend`）。放在标签组上方，否则三种颜色无从理解 */
export function TagLegend(): React.ReactElement {
  return (
    <div className="planner-legend">
      <span className="planner-legend__item planner-legend__item--prefer">蓝色：偏好</span>
      <span className="planner-legend__item planner-legend__item--require">绿色：必须</span>
      <span className="planner-legend__item planner-legend__item--exclude">红色：不要</span>
    </div>
  );
}
