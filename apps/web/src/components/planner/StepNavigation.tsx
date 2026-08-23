'use client';

import {
  STEP_IDS,
  STEP_LABEL,
  STEP_WEIGHTS,
  overallProgress,
  stepIsComplete,
  stepIsEdited,
  stepScore,
  type PlannerState,
  type StepId,
} from '@/lib/planner-state';

/**
 * 左栏：八步导航 + 完成度（原型的 `.left-panel`）。
 *
 * 圆点有三态：无（未编辑）、蓝点（编辑过但未完成）、绿勾（完成）。
 * 三态而不是两态是因为「动过但没填完」与「压根没动」对用户是不同的信息 ——
 * 前者需要回去补，后者可能本来就不需要填。
 */

/** 进度百分比 → 一句话说明。数字本身不告诉用户「够了吗」 */
function progressHint(percent: number): string {
  if (percent === 0) return '尚未编辑任何步骤';
  if (percent < 40) return '旅行轮廓正在建立';
  if (percent < 70) return '已完成主要基础条件';
  if (percent < 100) return '规划已较完整，可以继续补充';
  return '规划条件已完整，可以生成方案';
}

export interface StepNavigationProps {
  readonly state: PlannerState;
  readonly activeStep: StepId;
  readonly onJump: (step: StepId) => void;
  readonly open: boolean;
}

export function StepNavigation({
  state,
  activeStep,
  onJump,
  open,
}: StepNavigationProps): React.ReactElement {
  const percent = overallProgress(state);
  const editedCount = STEP_IDS.filter((step) => stepIsEdited(state, step)).length;

  return (
    <aside className={`planner-panel planner-left${open ? ' is-open' : ''}`}>
      <div className="planner-left__heading">
        <strong>规划步骤</strong>
        <p>蓝点表示编辑过，绿色勾选表示该步骤已经完成。</p>
      </div>

      <nav className="planner-steps">
        {STEP_IDS.map((step, index) => {
          const complete = stepIsComplete(state, step);
          const edited = stepIsEdited(state, step);
          const classes = [
            step === activeStep ? 'is-active' : '',
            edited && !complete ? 'is-edited' : '',
            complete ? 'is-complete' : '',
          ].filter((part) => part.length > 0);

          return (
            <button
              key={step}
              type="button"
              className={classes.join(' ')}
              aria-current={step === activeStep ? 'step' : undefined}
              title={
                complete
                  ? `${STEP_LABEL[step]}：已完成`
                  : edited
                    ? `${STEP_LABEL[step]}：${stepScore(state, step)}/${STEP_WEIGHTS[step]}`
                    : `${STEP_LABEL[step]}：尚未编辑`
              }
              onClick={() => onJump(step)}
            >
              <span className="planner-steps__index">{index + 1}</span>
              {STEP_LABEL[step]}
              <span className="planner-steps__dot" />
            </button>
          );
        })}
      </nav>

      <div className="planner-progress">
        <div className="planner-progress__head">
          <span>规划完成度</span>
          <strong>{percent}%</strong>
        </div>

        <div
          className="planner-progress__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="规划完成度"
        >
          <div
            className={`planner-progress__value${percent === 100 ? ' is-complete' : ''}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        <p className="planner-progress__hint">{progressHint(percent)}</p>
        <p className="planner-progress__detail">
          已编辑 {editedCount}/{STEP_IDS.length} 步
        </p>
      </div>
    </aside>
  );
}
