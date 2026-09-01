'use client';

import { plannerField, type PlannerFieldId } from '@tps/schemas';

import { usePlannerOptionResolver } from '@/components/planner/PlannerConfigProvider';
import { resolutionTarget } from '@/lib/planner/config-binding';
import { FIELD_DESCRIPTORS, type FieldPart } from '@/lib/planner/descriptors';
import {
  asStringList,
  isToggleOn,
  partValue,
  partVisible,
  patchApiKey,
  patchPart,
  patchToggle,
  staleCodes,
  truncated,
  withoutCodes,
} from '@/lib/planner/field-io';
import { FIELD_STATE_LABEL } from '@/lib/planner/field-state';
import { readAnswer, type PlannerAction, type PlannerState } from '@/lib/planner/state';
import type { PlannerSnapshot } from '@/lib/planner/step-state';
import { TRIGGER_REASON } from '@/lib/planner/triggers';
import { validateField } from '@/lib/planner/validation';

import { DevBadge } from './DevBadge';
import { PrimitiveControl } from './PrimitiveControl';

/**
 * 一个字段的完整容器：标题、触发原因、控件、错误、Dev 徽标。
 *
 * ## `data-field` 挂在这一层，且每个字段各一个
 *
 * 规范 3.3 明令禁止 `PV2-02-001/002` 这种合并标识：复合视觉块内的多个字段
 * 必须各自独立绑定。因此「同行人数 + 旅行者卡」在视觉上是一个区块，
 * 但它们是两个 `.planner-section`，各带自己的 `data-field` ——
 * 合并之后埋点、Dev Mode 与摘要回跳就都指不到具体那一个了。
 *
 * ## 为什么不用 `<form>`
 *
 * 九步问卷没有「提交这一页」的动作：每个 selection 完成即写入答案树并自动
 * 保存（规范 6）。包一层 `<form>` 会引出回车键意外提交这条路径，
 * 而这里没有任何一个按钮该被当成 submit。
 */

export interface FieldControlProps {
  readonly fieldId: PlannerFieldId;
  readonly state: PlannerState;
  readonly snapshot: PlannerSnapshot;
  readonly dispatch: (action: PlannerAction) => void;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
  /** 第 9 步的两个元字段由 `ReviewBoard` 渲染，这里只留容器 */
  readonly slot?: React.ReactNode;
}

export function FieldControl({
  fieldId,
  state,
  snapshot,
  dispatch,
  registerField,
  slot,
}: FieldControlProps): React.ReactElement {
  const spec = plannerField(fieldId);
  const descriptor = FIELD_DESCRIPTORS[fieldId];
  const fieldState = snapshot.states.get(fieldId);
  const error = validateField(state, fieldId);
  const reason = TRIGGER_REASON[fieldId];
  const showMustBadge = spec.runtime_type === 'HARD';

  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [reason === undefined ? null : hintId, error === null ? null : errorId]
    .filter((entry): entry is string => entry !== null)
    .join(' ');

  return (
    <div
      className={`planner-section${error === null ? '' : ' planner-field--invalid'}`}
      data-field={fieldId}
      ref={(node) => registerField(fieldId, node)}
      /* tabIndex -1：摘要 chip 回跳时要能 focus() 到这里，但它不该进 Tab 序 */
      tabIndex={-1}
    >
      <div className="planner-section__head">
        <strong className="planner-section__title" id={`${fieldId}-title`}>
          {spec.question}
        </strong>
        <span className="planner-section__meta">
          {showMustBadge ? (
            <span className="planner-badge planner-badge--hard">必须满足</span>
          ) : null}
        </span>
      </div>

      {reason === undefined ? null : (
        <p className="planner-hint planner-hint--reason" id={hintId}>
          {reason}
        </p>
      )}

      {slot ?? (
        <FieldBody
          fieldId={fieldId}
          descriptor={descriptor}
          state={state}
          dispatch={dispatch}
          describedBy={describedBy === '' ? undefined : describedBy}
        />
      )}

      {error === null ? null : (
        <p className="planner-error" id={errorId} role="alert">
          {error}
        </p>
      )}

      {state.devMode ? (
        <DevBadge fieldId={fieldId} fieldState={fieldState ?? 'hidden'} label={FIELD_STATE_LABEL} />
      ) : null}
    </div>
  );
}

function FieldBody({
  fieldId,
  descriptor,
  state,
  dispatch,
  describedBy,
}: {
  readonly fieldId: PlannerFieldId;
  readonly descriptor: (typeof FIELD_DESCRIPTORS)[PlannerFieldId];
  readonly state: PlannerState;
  readonly dispatch: (action: PlannerAction) => void;
  readonly describedBy: string | undefined;
}): React.ReactElement {
  /*
   * 三个非 `parts` 的描述符在这里只留一句说明。
   *
   * 复核面板与阻塞项列表由第 9 步的 `ReviewBoard` 通过 `slot` 注入（P9-5），
   * 文件导入的后端不在 P9 范围内（见实施计划的「明确不在本轮范围」）。
   * 留一个带 `data-field` 的容器而不是不渲染：规范 21.1 的 76 个绑定
   * 是阻塞发布的门槛，「还没做」不等于「可以不出现」。
   */
  if (descriptor.kind === 'review-board' || descriptor.kind === 'blocker-list') {
    return <p className="planner-hint">这一项由本页的复核面板承载。</p>;
  }
  if (descriptor.kind === 'upload-entry') {
    return (
      <button type="button" className="planner-button planner-button--light" disabled>
        上传或导入文件 · 即将开放
      </button>
    );
  }

  const spec = plannerField(fieldId);
  const toggle = descriptor.toggle;
  const on = toggle === undefined || isToggleOn(state.answers, fieldId);

  return (
    <>
      {toggle === undefined ? null : (
        <label className="planner-switch" htmlFor={`${fieldId}-toggle`}>
          <input
            type="checkbox"
            id={`${fieldId}-toggle`}
            checked={on}
            onChange={(event) =>
              dispatch({
                type: 'answer',
                fieldId,
                patch: patchToggle(state.answers, fieldId, event.target.checked),
              })
            }
          />
          <span className="planner-switch__label">{toggle}</span>
        </label>
      )}

      {/* 开关关掉时不渲染部件，但值保留在答案树里（规范 6 的「值保留」）*/}
      {!on
        ? null
        : descriptor.parts
            .filter((part) => partVisible(state.answers, fieldId, part))
            .map((part) => (
              <PartField
                key={part.key ?? 'self'}
                fieldId={fieldId}
                apiKey={spec.api_key}
                part={part}
                state={state}
                dispatch={dispatch}
                describedBy={describedBy}
              />
            ))}
    </>
  );
}

function PartField({
  fieldId,
  apiKey,
  part,
  state,
  dispatch,
  describedBy,
}: {
  readonly fieldId: PlannerFieldId;
  readonly apiKey: string;
  readonly part: FieldPart;
  readonly state: PlannerState;
  readonly dispatch: (action: PlannerAction) => void;
  readonly describedBy: string | undefined;
}): React.ReactElement {
  const controlId = `${fieldId}-${part.key ?? 'self'}`;
  const rows = resolveRows(part, state);
  const value = partValue(state.answers, fieldId, part);

  /*
   * 选项来自配置中心的发布版本，回退内置（见 `PlannerConfigProvider`）。
   *
   * `options_from` 的部件（只有 `interests.top3`）要用动态值覆盖解析出的
   * `values` —— 那个列表是「用户勾了哪些兴趣」，而解析器返回的是
   * 「配置里有哪些兴趣」。不覆盖会让排序控件列出全部 14 个兴趣。
   * 文案与可配性仍沿用源列表，见 `resolutionTarget`。
   */
  const resolve = usePlannerOptionResolver();
  const dynamic = resolveOptions(part, state);
  const target = resolutionTarget(apiKey, apiKey, part, dynamic);
  const resolved = resolve(target);
  const options = part.options_from === undefined ? resolved.values : dynamic;

  /*
   * 配置里已下线、但草稿里还留着的条件码。
   *
   * 只查条件码列表：那里下线一个值会让提交被 N-08 拒（白名单收缩），
   * 而枚举列表下线一个值只是界面上看不到了 —— 契约照旧接受，提交不受影响。
   * 把提示扩到枚举会让用户为一件没有后果的事按一次按钮。
   */
  const stale = target.kind === 'CONDITION_CODE' ? staleCodes(value, options) : [];

  const write = (next: unknown): void => {
    dispatch({
      type: 'answer',
      fieldId,
      patch: patchPart(state.answers, fieldId, part, next),
    });

    /*
     * 计数器变小时截断跟随它的数组（规范 8、12）。
     *
     * 作为**第二个 action** 而不是合进同一个 patch：两者写的是不同字段，
     * 而 `patch` 的 `fieldId` 决定 touched 归属 —— 合成一条会把
     * 「用户改了人数」记成「用户填了旅行者卡」，于是第 2 步在用户还没看过
     * 卡片时就变成 in-progress。
     */
    const truncates = part.truncates;
    if (truncates !== undefined && typeof next === 'number') {
      const current = readAnswer(state.answers, truncates);
      if (Array.isArray(current) && current.length > next) {
        dispatch({
          type: 'answer',
          fieldId,
          patch: patchApiKey(truncates, truncated(current, next)),
        });
      }
    }
  };

  const body = (
    <>
      <PrimitiveControl
        part={part}
        apiKey={apiKey}
        value={value}
        onChange={write}
        id={controlId}
        options={options}
        labelOf={resolved.labelOf}
        {...(rows === undefined ? {} : { rows })}
        {...(describedBy === undefined ? {} : { describedBy })}
      />
      {stale.length === 0 ? null : (
        <p className="planner-hint planner-hint--stale">
          有 {stale.length} 项你选过的偏好已经下线，留着它会让提交被拒。
          <button
            type="button"
            className="planner-button planner-button--light"
            onClick={() => write(withoutCodes(value, stale))}
          >
            移除这 {stale.length} 项
          </button>
        </p>
      )}
    </>
  );

  /*
   * 单部件字段不再重复一个 label —— 区块标题已经是那个问句，
   * 而「问题：出发地/常住地」上面再写一行「出发地」是纯噪声。
   * 多部件字段的每个部件都需要自己的 label（规范 20 的「显式 label」）。
   */
  if (part.key === null && part.label === undefined) {
    return (
      <div className="planner-field">
        {body}
        {part.hint === undefined ? null : <p className="planner-hint">{part.hint}</p>}
      </div>
    );
  }

  return (
    <div className="planner-field">
      <label className="planner-label" htmlFor={controlId}>
        {part.label ?? ''}
      </label>
      {body}
      {part.hint === undefined ? null : <p className="planner-hint">{part.hint}</p>}
    </div>
  );
}

/**
 * 解析部件的选项。
 *
 * `options_from` 只有 `interests.top3` 用：字段表要求「必须从已选兴趣中选择」。
 * 从当前答案取而不是取全部兴趣码 —— 后者会让用户在 Top 3 里排出一个
 * 自己没选过的兴趣，而 `validation.ts` 随即报「排序只能从你已选的兴趣里挑」。
 */
function resolveOptions(part: FieldPart, state: PlannerState): readonly string[] {
  if (part.options_from !== undefined) {
    return asStringList(readAnswer(state.answers, part.options_from));
  }
  return part.options ?? [];
}

function resolveRows(part: FieldPart, state: PlannerState): number | undefined {
  if (part.follow_count === undefined) return undefined;
  const count = readAnswer(state.answers, part.follow_count);
  return typeof count === 'number' ? count : 0;
}
