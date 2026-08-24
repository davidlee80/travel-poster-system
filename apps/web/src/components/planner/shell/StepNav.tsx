'use client';

import { PLANNER_STEPS, type PlannerStepId } from '@tps/schemas';

import { STEP_STATE_LABEL, TRIP_STATE_LABEL, type PlannerSnapshot } from '@/lib/planner/step-state';

/**
 * 左栏：九步导航 + 三个指标 + 条件类型图例（规范 3.1、17.1）。
 *
 * ## 三个指标必须分开显示
 *
 * 规范 17.1 把它们列成三行，并明确「可生成状态是状态而不是百分比」、
 * 「待核验单独显示总数与 blocking 数」。合成一个数字（比如「完成度 78%」）
 * 会让 `blocked` 与 `research-needed` 长得一样 —— 而前者不能生成、
 * 后者可以生成但结果带待核验标识。
 *
 * ## 状态点不只靠颜色
 *
 * 规范 20：「任何状态不能只依赖颜色；必须同时使用文字、图标和 aria-label」。
 * 因此每个点都有 `title` 与 `aria-label`，且 needs-attention 在 CSS 里是**方形**。
 */

/** 第 10 步不在主问卷导航里 —— 它是生成之后的行前准备中心（规范 16）*/
const NAV_STEPS = PLANNER_STEPS.filter((step) => step.step !== '10');

export interface StepNavProps {
  readonly activeStep: PlannerStepId;
  readonly snapshot: PlannerSnapshot;
  readonly onJump: (step: PlannerStepId) => void;
  /** 窄屏抽屉是否展开 */
  readonly open: boolean;
}

export function StepNav({ activeStep, snapshot, onJump, open }: StepNavProps): React.ReactElement {
  return (
    <aside
      className={`planner-panel planner-left${open ? ' planner-left--open' : ''}`}
      aria-label="步骤导航与旅行画像进度"
    >
      <p className="planner-left__heading">这趟旅行的九个问题</p>
      <p className="planner-left__copy">按顺序回答，条件问题只在相关时出现。</p>

      <nav className="planner-steps">
        {NAV_STEPS.map((step) => {
          const state = snapshot.stepStates.get(step.step) ?? 'untouched';
          const label = STEP_STATE_LABEL[state];
          return (
            <button
              key={step.step}
              type="button"
              className={`planner-step${step.step === activeStep ? ' planner-step--active' : ''}`}
              onClick={() => onJump(step.step)}
              aria-current={step.step === activeStep ? 'step' : undefined}
            >
              <span className="planner-step__num" aria-hidden="true">
                {step.step}
              </span>
              <span className="planner-step__name">{step.nav}</span>
              <span
                className={`planner-step__status planner-step__status--${stateSuffix(state)}`}
                title={label}
                aria-label={`${step.nav}：${label}`}
                role="img"
              />
            </button>
          );
        })}
      </nav>

      <div className="planner-progress">
        <div className="planner-progress__row">
          <span>旅行画像完整度</span>
          <strong>{snapshot.completeness}%</strong>
        </div>
        <div className="planner-progress__track">
          <i className="planner-progress__fill" style={{ width: `${snapshot.completeness}%` }} />
        </div>

        <p className={`planner-progress__state planner-progress__state--${tripSuffix(snapshot)}`}>
          {TRIP_STATE_LABEL[snapshot.tripState]}
        </p>

        {/*
          待核验的两个数字分开写。规范 17.1 给的范例就是这句：
          「3 项待确认，其中 1 项影响最终锁定」。只写总数会让用户无法判断
          现在能不能生成。
        */}
        <p className="planner-progress__verify">
          {snapshot.verifyCount === 0
            ? '暂无待确认项'
            : `${snapshot.verifyCount} 项待确认${
                snapshot.blockingVerifyCount > 0
                  ? `，其中 ${snapshot.blockingVerifyCount} 项影响生成`
                  : ''
              }`}
        </p>
      </div>

      <div className="planner-legend">
        {LEGEND.map((entry) => (
          <span
            key={entry.kind}
            className={`planner-legend__item planner-legend__item--${entry.kind}`}
          >
            <i className="planner-legend__swatch" aria-hidden="true" />
            {entry.label}
          </span>
        ))}
      </div>
    </aside>
  );
}

function stateSuffix(state: string): string {
  if (state === 'in-progress') return 'progress';
  if (state === 'complete') return 'complete';
  if (state === 'needs-attention') return 'attention';
  return 'untouched';
}

function tripSuffix(snapshot: PlannerSnapshot): string {
  if (snapshot.tripState === 'ready-for-plan') return 'ready';
  if (snapshot.tripState === 'research-needed') return 'research';
  if (snapshot.tripState === 'blocked') return 'blocked';
  return 'draft';
}

/** 规范 4 章的类型语义。顺序与 4.1 的运行时优先级一致，让图例本身表达优先级 */
const LEGEND = [
  { kind: 'locked', label: '已锁定，不可移动' },
  { kind: 'consent', label: '授权' },
  { kind: 'hard', label: '必须满足' },
  { kind: 'exclude', label: '明确不要' },
  { kind: 'verify', label: '还需要确认' },
  { kind: 'prefer', label: '优先满足' },
] as const;
