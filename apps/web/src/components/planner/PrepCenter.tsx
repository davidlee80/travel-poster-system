'use client';

import { PLANNER_STEPS, plannerField, type PlannerFieldId } from '@tps/schemas';

import { isAnswered, type PlannerAction, type PlannerState } from '@/lib/planner/state';
import type { PlannerSnapshot } from '@/lib/planner/step-state';

import { FieldControl } from './controls/FieldControl';
import { STEP_SECTIONS } from './steps/sections';

/**
 * 行前准备中心（规范 16，PV2-10-001～006）。
 *
 * ## 为什么它不是「第 10 步问卷」
 *
 * 规范 16 的原话是「以任务卡方式逐步补齐，不把你重新拖回 9 步主问卷」。
 * 因此这一页的组织方式是**任务进度**而不是表单进度：每张卡片是一件
 * 「出发前要办的事」，有「待办 / 已填」两态，用户可以只办其中一件就离开。
 *
 * 具体差别有三处：
 *
 *   - 卡片可折叠，默认收起 —— 六件事一次全部展开是一张长表单；
 *   - 状态是「待办 / 已填」而不是 Field State 的七态 —— 这里没有阻塞、
 *     没有触发链，六个字段互不依赖；
 *   - 完成度**不进** `snapshot.completeness`。那个数字衡量的是「初步方案的
 *     个性化程度」，而这六项在方案生成之后才出现（`level: POST_PLAN`，
 *     触发引擎恒不返回它们）。混进去会让一份刚生成的方案显示 92% 而不是 100%。
 *
 * ## Dev Mode 里这些字段显示 `hidden`
 *
 * 那是**正确的**：`fieldState` 读的是九步问卷的触发图，而第 10 步的字段
 * 不在那张图里（`isTriggered` 对 `POST_PLAN` 直接返回 false，见规范 16）。
 * 为它们编造一个「已触发」会让触发引擎多一条只为 Dev Mode 存在的特例。
 */

export interface PrepCenterProps {
  readonly state: PlannerState;
  readonly snapshot: PlannerSnapshot;
  readonly dispatch: (action: PlannerAction) => void;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
  /** 已展开的卡片。由 `Planner` 持有 —— 切走再回来时展开状态要保留 */
  readonly openCards: readonly PlannerFieldId[];
  readonly onToggleCard: (fieldId: PlannerFieldId) => void;
  /** 生成好的计划。有它才显示「查看完整计划」入口 */
  readonly planId: string | null;
}

export function PrepCenter({
  state,
  snapshot,
  dispatch,
  registerField,
  openCards,
  onToggleCard,
  planId,
}: PrepCenterProps): React.ReactElement {
  const meta = PLANNER_STEPS.find((entry) => entry.step === '10');
  const cards = STEP_SECTIONS['10'].flatMap((section) => section.fields);
  const done = cards.filter((fieldId) => isAnswered(state, fieldId)).length;

  return (
    <section
      className="planner-panel planner-step-page planner-step-page--active"
      aria-labelledby="planner-step-title-10"
    >
      <header className="planner-page-head">
        <div>
          <div className="planner-page-head__eyebrow">10 · {meta?.nav ?? ''}</div>
          <h1 className="planner-page-head__title" id="planner-step-title-10">
            {meta?.title ?? ''}
          </h1>
          <p className="planner-page-head__desc">{meta?.intro ?? ''}</p>
        </div>
        {/*
          进度是「几件事办完了」而不是百分比。
          `aria-live` 让屏读用户在填完一张卡之后听到变化。
        */}
        <span className="planner-page-head__badge" aria-live="polite">
          已完成 {done} / {cards.length} 项
        </span>
      </header>

      {planId === null ? null : (
        <p className="planner-hint">
          初步方案已生成，
          <a className="planner-link" href={`/plans/${planId}`}>
            查看完整计划
          </a>
          。下面这些可以随时补，不影响已生成的行程。
        </p>
      )}

      <div className="planner-prep">
        {cards.map((fieldId) => {
          const spec = plannerField(fieldId);
          const open = openCards.includes(fieldId);
          const filled = isAnswered(state, fieldId);
          return (
            <article
              className={`planner-prep__card${filled ? ' planner-prep__card--done' : ''}`}
              key={fieldId}
            >
              {/*
                整张卡的标题是一个按钮（不是 div 加 onClick）：键盘用户要能
                Tab 到它并用回车展开，而 `aria-expanded` 让屏读用户知道
                下面还有内容（规范 20 的「键盘可完成弹层」）。
              */}
              <button
                type="button"
                className="planner-prep__head"
                aria-expanded={open}
                aria-controls={`prep-body-${fieldId}`}
                onClick={() => onToggleCard(fieldId)}
              >
                <span className="planner-prep__title">{spec.question}</span>
                <span
                  className={`planner-prep__state${filled ? ' planner-prep__state--done' : ''}`}
                >
                  {/* 状态同时用文字与图标，不只靠颜色（规范 20） */}
                  <span aria-hidden="true">{filled ? '✓' : '○'}</span> {filled ? '已填' : '待办'}
                </span>
                <span className="planner-prep__chevron" aria-hidden="true">
                  {open ? '▴' : '▾'}
                </span>
              </button>

              {/*
                收起时用 `hidden` 而不是不渲染。
                两个理由：`hidden` 等价于 display:none，因此里面的输入框既不在
                Tab 序里也不在无障碍树里（收起就是收起）；而 DOM 里仍然有那个
                带 `data-field` 的容器 —— 规范 21.1 要求 76 个 Field ID
                **可被识别**，而一个折叠起来就消失的绑定过不了那道门槛。
              */}
              <div id={`prep-body-${fieldId}`} hidden={!open}>
                <FieldControl
                  fieldId={fieldId}
                  state={state}
                  snapshot={snapshot}
                  dispatch={dispatch}
                  registerField={registerField}
                />
              </div>
            </article>
          );
        })}
      </div>

      <p className="planner-hint">
        这些信息只用于出发前的准备，不会改动已生成的行程。我们不收卡号、密码或会员账号。
      </p>
    </section>
  );
}
