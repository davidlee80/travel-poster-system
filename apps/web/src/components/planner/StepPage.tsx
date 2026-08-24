'use client';

import { PLANNER_STEPS, plannerField, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';

import { FIELD_STATE_LABEL } from '@/lib/planner/field-state';
import type { PlannerSnapshot } from '@/lib/planner/step-state';
import { TRIGGER_REASON } from '@/lib/planner/triggers';

/**
 * 一个步骤页的外框（规范 3.2 的 Main Header + Main Sections + Sticky Action）。
 *
 * ## 字段清单目前渲染成大纲
 *
 * P9-3 交付的是骨架：每个已触发字段渲染成一行「问题 + 控件类型 + 字段状态」，
 * P9-4 把每一行换成真正的控件。这不是占位符 —— 它已经在跑真实的触发引擎与
 * 状态机，因此「跨境时第 8 步多出三行、把飞机标成不要之后航班约束那行消失」
 * 现在就能验证。
 *
 * ## 未触发的字段一行都不渲染
 *
 * 规范 6：未触发字段隐藏，不占完成度。渲染成禁用状态是另一种常见做法，
 * 但它会让第 8 步永远显示十行灰掉的证件问题 —— 而那正是 V2 想消除的
 * 「大而全问卷」观感。
 */

export interface StepPageProps {
  readonly step: PlannerStepId;
  readonly active: boolean;
  readonly snapshot: PlannerSnapshot;
  readonly devMode: boolean;
  readonly onPrev: (() => void) | null;
  readonly onNext: (() => void) | null;
  /** 第 9 步用它替换「下一步」 */
  readonly nextLabel: string | null;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
}

export function StepPage({
  step,
  active,
  snapshot,
  devMode,
  onPrev,
  onNext,
  nextLabel,
  registerField,
}: StepPageProps): React.ReactElement {
  const meta = PLANNER_STEPS.find((entry) => entry.step === step);
  const fields = snapshot.triggered.filter((fieldId) => fieldId.slice(4, 6) === step);

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

      {fields.map((fieldId) => (
        <FieldOutline
          key={fieldId}
          fieldId={fieldId}
          snapshot={snapshot}
          devMode={devMode}
          registerField={registerField}
        />
      ))}

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

function FieldOutline({
  fieldId,
  snapshot,
  devMode,
  registerField,
}: {
  readonly fieldId: PlannerFieldId;
  readonly snapshot: PlannerSnapshot;
  readonly devMode: boolean;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
}): React.ReactElement {
  const spec = plannerField(fieldId);
  const state = snapshot.states.get(fieldId);
  const reason = TRIGGER_REASON[fieldId];

  return (
    <div
      className="planner-section"
      data-field={fieldId}
      ref={(node) => registerField(fieldId, node)}
      /* tabIndex -1：摘要 chip 回跳时要能 focus() 到这里，但它不该进 Tab 序 */
      tabIndex={-1}
    >
      <div className="planner-section__head">
        <strong className="planner-section__title">{spec.question}</strong>
        <span className="planner-section__meta">
          {spec.required === 'OPTIONAL' ? '可选补充' : spec.control}
        </span>
      </div>

      {reason === undefined ? null : <p className="planner-hint">{reason}</p>}

      <p className="planner-hint">
        {spec.control}
        {state === undefined ? '' : ` · ${FIELD_STATE_LABEL[state]}`}
      </p>

      {devMode ? <DevBadge fieldId={fieldId} snapshot={snapshot} /> : null}
    </div>
  );
}

/**
 * Dev Mode 徽标（规范 21.1 的显示项表）。
 *
 * 七项逐条对应规范给的表格：Field ID / API Key / Runtime Type / Priority /
 * Blocking / Trigger Source / Field State。少一项就少一条排查线索 ——
 * 这个开关存在的意义就是让 QA 能在界面上核对字段绑定，而不必开 DevTools。
 */
function DevBadge({
  fieldId,
  snapshot,
}: {
  readonly fieldId: PlannerFieldId;
  readonly snapshot: PlannerSnapshot;
}): React.ReactElement {
  const spec = plannerField(fieldId);
  const state = snapshot.states.get(fieldId);
  return (
    <dl className="planner-dev">
      <div>
        <dt>Field ID</dt>
        <dd>{spec.field_id}</dd>
      </div>
      <div>
        <dt>API Key</dt>
        <dd>{spec.api_key}</dd>
      </div>
      <div>
        <dt>Runtime Type</dt>
        <dd>{spec.runtime_type}</dd>
      </div>
      <div>
        <dt>Priority</dt>
        <dd>{spec.priority}</dd>
      </div>
      <div>
        <dt>Blocking</dt>
        <dd>{spec.blocking}</dd>
      </div>
      <div>
        <dt>Trigger</dt>
        <dd>{spec.trigger}</dd>
      </div>
      <div>
        <dt>Field State</dt>
        <dd>{state ?? 'hidden'}</dd>
      </div>
    </dl>
  );
}
