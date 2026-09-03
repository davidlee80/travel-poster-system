'use client';

import { PLANNER_STEPS, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';

import type { PlannerAction, PlannerState } from '@/lib/planner/state';
import type { PlannerSnapshot } from '@/lib/planner/step-state';

import { FieldControl } from './controls/FieldControl';
import { STEP_SECTIONS } from './steps/sections';

/**
 * 一个步骤页（规范 3.2 的 Main Header + Main Sections + Sticky Action）。
 *
 * ## 未触发的字段一行都不渲染
 *
 * 规范 6：未触发字段隐藏，不占完成度。渲染成禁用状态是另一种常见做法，
 * 但它会让第 8 步永远显示十行灰掉的证件问题 —— 而那正是 V2 想消除的
 * 「大而全问卷」观感。整组字段都未触发时连小标题一起隐藏，
 * 否则会留下一个空标题（比如国内游的「证件」组）。
 *
 * ## 九步共用一个组件
 *
 * 每一步的差别只有两样：区块小标题（在 `steps/sections.ts` 里）与第 9 步的
 * 复核面板（通过 `slots` 注入）。九个各自罗列字段的组件等于把字段清单抄第二遍，
 * 而元数据表的数组顺序已经是页面区块顺序。
 */

export interface StepPageProps {
  readonly step: PlannerStepId;
  readonly active: boolean;
  readonly state: PlannerState;
  readonly snapshot: PlannerSnapshot;
  readonly dispatch: (action: PlannerAction) => void;
  readonly onPrev: (() => void) | null;
  readonly onNext: (() => void) | null;
  /** 第 9 步用它替换「下一步」 */
  readonly nextLabel: string | null;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
  /** 某些字段的内容由本步骤的专用面板承载（第 9 步的复核面板与阻塞项列表） */
  readonly slots?: Partial<Record<PlannerFieldId, React.ReactNode>>;
  /** 被组合控件承载、无需重复显示的底层字段。字段仍保留在数据契约和状态机中。 */
  readonly hiddenFields?: readonly PlannerFieldId[];
  /**
   * 字段区块之后、底部动作区之前的内容（第 9 步的输出样式选择器）。
   *
   * 与 `slots` 分开是因为 `slots` 的键是 `PlannerFieldId` ——
   * 而这里要放的东西没有对应字段（模板不在 76 字段里）。
   * 与 `actions` 分开是因为后者在 `planner-actions__right` 里，
   * 那是一排按钮的位置，放不下一组带图的卡片。
   */
  readonly beforeActions?: React.ReactNode;
  /** 底部动作区右侧的额外内容（第 9 步的生成按钮） */
  readonly actions?: React.ReactNode;
}

export function StepPage({
  step,
  active,
  state,
  snapshot,
  dispatch,
  onPrev,
  onNext,
  nextLabel,
  registerField,
  slots,
  hiddenFields = [],
  beforeActions,
  actions,
}: StepPageProps): React.ReactElement {
  const meta = PLANNER_STEPS.find((entry) => entry.step === step);
  const triggered = new Set(snapshot.triggered);
  const hidden = new Set(hiddenFields);
  const sections = STEP_SECTIONS[step];

  return (
    <section
      className={`planner-panel planner-step-page${active ? ' planner-step-page--active' : ''}`}
      aria-labelledby={`planner-step-title-${step}`}
      /*
       * `aria-hidden` 与 display:none 一起用是多余的（display:none 已经把子树
       * 从无障碍树里摘掉），因此不加 —— 加了反而会在将来有人把它改成
       * visibility 隐藏时掩盖问题。
       */
    >
      <header className="planner-page-head">
        <div>
          <div className="planner-page-head__eyebrow">
            {step} · {meta?.nav ?? ''}
          </div>
          <h1 className="planner-page-head__title" id={`planner-step-title-${step}`}>
            {meta?.title ?? ''}
          </h1>
          <p className="planner-page-head__desc">{meta?.intro ?? ''}</p>
        </div>
        <span className="planner-page-head__badge">第 {Number(step)} 步 / 9</span>
      </header>

      <div className="planner-required-legend" role="note">
        <span className="planner-badge planner-badge--required">必填项</span>
        <span>“当前必填”会随你的选择出现；其他问题可以跳过。</span>
      </div>

      {sections.map((section) => {
        const fields = section.fields.filter(
          (fieldId) => triggered.has(fieldId) && !hidden.has(fieldId),
        );
        if (fields.length === 0) return null;
        return (
          <div className="planner-block" key={section.title}>
            <h2 className="planner-block__title">{section.title}</h2>
            {section.intro === undefined ? null : (
              <p className="planner-block__intro">{section.intro}</p>
            )}
            {fields.map((fieldId) => (
              <FieldControl
                key={fieldId}
                fieldId={fieldId}
                state={state}
                snapshot={snapshot}
                dispatch={dispatch}
                registerField={registerField}
                {...(slots?.[fieldId] === undefined ? {} : { slot: slots[fieldId] })}
              />
            ))}
          </div>
        );
      })}

      {beforeActions}

      <div className="planner-actions">
        <div className="planner-actions__left">
          {onPrev === null ? null : (
            <button
              type="button"
              className="planner-button planner-button--secondary"
              onClick={onPrev}
            >
              ← 上一步
            </button>
          )}
        </div>
        <div className="planner-actions__right">
          <span className="planner-actions__note">修改会自动保存</span>
          {actions}
          {onNext === null ? null : (
            <button
              type="button"
              className="planner-button planner-button--primary"
              onClick={onNext}
            >
              {nextLabel ?? '下一步'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
