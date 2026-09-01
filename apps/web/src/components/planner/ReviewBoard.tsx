'use client';

import { PLANNER_STEPS, plannerField, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';

import { patchApiKey } from '@/lib/planner/field-io';
import type { PlannerAction, PlannerState } from '@/lib/planner/state';
import { readAnswer } from '@/lib/planner/state';
import type { PlannerSnapshot } from '@/lib/planner/step-state';
import { buildSummary } from '@/lib/planner/summary';
import { TRIGGER_REASON } from '@/lib/planner/triggers';
import { invalidFields } from '@/lib/planner/validation';

import { useSummaryLabel } from './PlannerConfigProvider';
import { FieldControl } from './controls/FieldControl';

/**
 * 第 9 步的复核面板与阻塞项就地补答（规范 15、18）。
 *
 * ## 这一页不重复问卷
 *
 * 规范 15 的原话是「不重复问卷，而是确认理解」。因此复核面板显示的是**派生的
 * 五组画像**而不是 70 个字段的回放，每组一句「这是我们的理解」+ 一个逐组确认。
 * 把前八步的控件再渲染一遍是最容易想到的做法，代价是用户在第 9 步要再读一遍
 * 全部问题 —— 那正是 V2 想消除的「大而全问卷」观感。
 *
 * ## 阻塞项**就地**补答
 *
 * 规范 18 要求「完成一项即时移除，不要求回原步骤」。因此这里渲染的是**真正的
 * 控件**（同一个 `FieldControl`）而不是一句「请回到第 8 步填写护照状态」。
 * 复用同一个组件而不是抄一份：抄的那份迟早与主问卷里的分叉，
 * 而分叉的表现是「在第 9 步填的与在第 8 步填的不是同一个字段」。
 *
 * 「即时移除」是免费得到的：`snapshot.blockers` 每次状态变化都重算，
 * 填完一项它自然就不在列表里了。
 */

/** 复核面板的分组确认写进 `review.constraints_snapshot.acknowledged_groups` */
const ACK_KEY = 'review.constraints_snapshot';

export interface ReviewBoardProps {
  readonly state: PlannerState;
  readonly snapshot: PlannerSnapshot;
  readonly dispatch: (action: PlannerAction) => void;
  readonly onJumpToField: (step: PlannerStepId, fieldId: PlannerFieldId) => void;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
}

/**
 * 五组画像 + 冲突置顶 + 逐组确认（PV2-09-001）。
 *
 * 冲突置顶而不是留在各组里：规范 18.1 要求冲突「显示来源」并可直接跳回，
 * 而混在 40 个 chip 中间的一条红色 chip 在一屏之内几乎看不见。
 */
export function ReviewPanel({
  state,
  snapshot,
  dispatch,
  onJumpToField,
}: Omit<ReviewBoardProps, 'registerField'>): React.ReactElement {
  /* 右栏文案与主栏用同一份配置，见 summary.ts 的 `LabelResolver` */
  const summaryLabel = useSummaryLabel();
  /* VERIFY 已由上方的系统核验清单集中展示，避免同一答案在确认页重复出现。 */
  const sections = buildSummary(state, snapshot, summaryLabel).filter(
    (section) => section.group !== 'VERIFY',
  );
  const conflicts = invalidFields(state, snapshot.triggered);
  const pendingVerify = snapshot.triggered.filter(
    (fieldId) => snapshot.states.get(fieldId) === 'verify_pending',
  );

  const acknowledged = acknowledgedGroups(state);
  const toggleGroup = (group: string): void => {
    const next = acknowledged.includes(group)
      ? acknowledged.filter((entry) => entry !== group)
      : [...acknowledged, group];
    dispatch({
      type: 'answer',
      fieldId: 'PV2-09-001',
      /*
       * `acknowledged_at` 不在这里写：它需要一个时间戳，而 reducer 必须是纯的
       * （见 `field-io.ts` 关于 `reported_on` 的同类说明）。提交时由
       * `request.ts` 一并补上 —— 那才是「用户确认了这份理解」的时刻。
       */
      patch: patchApiKey(ACK_KEY, { acknowledged_groups: next }),
    });
  };

  return (
    <div className="planner-review">
      {conflicts.length === 0 ? null : (
        <div className="planner-review__conflicts" role="alert">
          <strong className="planner-review__conflicts-title">
            有 {conflicts.length} 处需要先解决
          </strong>
          <ul className="planner-review__list">
            {conflicts.map((conflict) => {
              const spec = plannerField(conflict.fieldId);
              const meta = PLANNER_STEPS.find((entry) => entry.step === spec.step);
              return (
                <li key={conflict.fieldId}>
                  <span className="planner-review__where">
                    第 {Number(spec.step)} 步 · {meta?.nav ?? ''}
                  </span>
                  <span className="planner-review__what">{conflict.message}</span>
                  <button
                    type="button"
                    className="planner-button planner-button--light"
                    onClick={() => onJumpToField(spec.step, conflict.fieldId)}
                  >
                    去修改
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pendingVerify.length === 0 ? null : (
        <VerificationList pending={pendingVerify} onJumpToField={onJumpToField} />
      )}

      {sections.map((section) => {
        const done = acknowledged.includes(section.group);
        return (
          <section className="planner-review__group" key={section.group}>
            <header className="planner-review__group-head">
              <h3 className="planner-review__group-title">{section.title}</h3>
              <label className="planner-switch" htmlFor={`review-ack-${section.group}`}>
                <input
                  type="checkbox"
                  id={`review-ack-${section.group}`}
                  checked={done}
                  onChange={() => toggleGroup(section.group)}
                />
                <span className="planner-switch__label">这一组没问题</span>
              </label>
            </header>

            {section.chips.length === 0 ? (
              <p className="planner-chip__empty">这一组还没有内容。</p>
            ) : (
              <div className="planner-chips">
                {section.chips.map((chip) => (
                  <button
                    key={chip.fieldId}
                    type="button"
                    className={`planner-chip planner-chip--${chip.kind}`}
                    aria-label={`${chip.text}，前往第 ${Number(chip.step)} 步修改`}
                    onClick={() => onJumpToField(chip.step, chip.fieldId)}
                  >
                    {chip.text}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {/*
        三个指标分开显示（规范 17.1）。
        它们**不是**同一件事的三种说法：完整度高不代表可以生成（可能缺一个
        阻塞项），待核验只代表系统还有后台工作。合成一个数字会让用户
        误以为自己还需要操作。
      */}
      <dl className="planner-review__metrics">
        <div>
          <dt>画像完整度</dt>
          <dd>{snapshot.completeness}%</dd>
        </div>
        <div>
          <dt>系统待核验</dt>
          <dd>{snapshot.verifyCount} 项（不影响生成）</dd>
        </div>
        <div>
          <dt>还缺</dt>
          <dd>{snapshot.blockers.length} 项必答</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * 阻塞项就地补答（PV2-09-002）。
 *
 * 列表里同时有两类项目，且它们的处理方式不同：
 *
 *   - **未回答的阻塞字段**（`snapshot.blockers`）—— 渲染真正的控件，就地填。
 * 已回答但待外部核验的字段由上面的 `ReviewPanel` 单独列出；不能把它们合成
 * 一个「请补充」列表，否则用户会反复填写同一项，而状态始终不消失。
 */
export function BlockerList({
  state,
  snapshot,
  dispatch,
  onJumpToField,
  registerField,
}: ReviewBoardProps): React.ReactElement {
  if (snapshot.blockers.length === 0) {
    return <p className="planner-hint">没有会阻塞生成的问题了。</p>;
  }

  /**
   * 就地补答时同时记一笔到 `review.blocking_answers.resolved_field_ids`。
   *
   * 这是 PV2-09-002 唯一的载荷，而它必须有值：那个字段是 P0 且已触发，
   * 留空会让第 9 步的 Step State 永远算不到 `complete`
   * （`computeStepState` 把「已触发的 P0 未回答项」算作未完成）——
   * 表现是左栏第 9 步的圆点永远不变绿，而用户找不到还缺什么。
   *
   * 在这里记而不是在 reducer 里：「在第 9 步就地补答」是**这个组件**的语义，
   * reducer 只知道「某个字段被改了」。放进 reducer 就得让它去读 activeStep
   * 并对一个与本次 action 无关的字段做副作用。
   */
  const answerHere = (action: PlannerAction): void => {
    dispatch(action);
    if (action.type !== 'answer') return;
    const already = resolvedFieldIds(state);
    if (already.includes(action.fieldId)) return;
    dispatch({
      type: 'answer',
      fieldId: 'PV2-09-002',
      patch: patchApiKey('review.blocking_answers', {
        resolved_field_ids: [...already, action.fieldId],
      }),
    });
  };

  return (
    <div
      className="planner-blockers"
      id="planner-blockers"
      tabIndex={-1}
      aria-label="需要用户补充的问题"
    >
      {snapshot.blockers.map((fieldId) => {
        const spec = plannerField(fieldId);
        const belongsToReviewStep = spec.step === '09';
        return (
          <div className="planner-blockers__item" key={fieldId}>
            <p className="planner-blockers__from">{whereFrom(fieldId)}</p>
            {belongsToReviewStep ? (
              <div className="planner-blockers__same-step">
                <strong>{spec.question}</strong>
                <button
                  type="button"
                  className="planner-button planner-button--light"
                  onClick={() => onJumpToField('09', fieldId)}
                >
                  前往填写
                </button>
              </div>
            ) : (
              /*
               * 其他步骤当前没有挂载，因此这里可以安全复用真正的控件。
               * 第 9 步自己的字段只提供聚焦入口，避免同一页出现重复 id。
               */
              <FieldControl
                fieldId={fieldId}
                state={state}
                snapshot={snapshot}
                dispatch={answerHere}
                registerField={registerField}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function VerificationList({
  pending,
  onJumpToField,
}: {
  readonly pending: readonly PlannerFieldId[];
  readonly onJumpToField: (step: PlannerStepId, fieldId: PlannerFieldId) => void;
}): React.ReactElement {
  return (
    <div
      className="planner-blockers__verify"
      id="planner-verifications"
      tabIndex={-1}
      aria-label="系统待核验明细"
    >
      <div className="planner-blockers__verify-head">
        <div>
          <strong>系统待核验（{pending.length}）</strong>
          <p>你的回答已经保存，无需重复填写。系统会在后台继续核验，不阻碍生成。</p>
        </div>
        <span className="planner-blockers__verify-status">不影响生成</span>
      </div>
      <ul className="planner-review__list planner-blockers__verify-list">
        {pending.map((fieldId) => {
          const spec = plannerField(fieldId);
          return (
            <li key={fieldId}>
              <span className="planner-blockers__verify-copy">
                <span className="planner-blockers__from">{whereFrom(fieldId)}</span>
                <strong className="planner-review__what">{spec.question}</strong>
                <small>不影响生成；初步方案会标记为待核验。</small>
              </span>
              <button
                type="button"
                className="planner-button planner-button--light"
                onClick={() => onJumpToField(spec.step, fieldId)}
              >
                查看原回答
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 「因为你在第 N 步说了 X，所以这一项是必答的」 */
function whereFrom(fieldId: PlannerFieldId): string {
  const spec = plannerField(fieldId);
  const meta = PLANNER_STEPS.find((entry) => entry.step === spec.step);
  const reason = TRIGGER_REASON[fieldId];
  const where = `来自第 ${Number(spec.step)} 步 · ${meta?.nav ?? ''}`;
  return reason === undefined ? where : `${where} —— ${reason}`;
}

function stringList(value: unknown, key: string): readonly string[] {
  if (typeof value !== 'object' || value === null) return [];
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function acknowledgedGroups(state: PlannerState): readonly string[] {
  return stringList(readAnswer(state.answers, ACK_KEY), 'acknowledged_groups');
}

function resolvedFieldIds(state: PlannerState): readonly PlannerFieldId[] {
  /*
   * `as`：契约里这一列是 `string[]`（它记的是 field_id，而 schema 不该依赖
   * 前端的字面量联合），而这里要用它做 `includes` 与写回。元素只可能来自
   * `snapshot.blockers`，因此运行期一定是合法 field_id。
   */
  return stringList(
    readAnswer(state.answers, 'review.blocking_answers'),
    'resolved_field_ids',
  ) as readonly PlannerFieldId[];
}
