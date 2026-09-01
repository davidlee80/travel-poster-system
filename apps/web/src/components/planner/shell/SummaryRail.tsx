'use client';

import { PLANNER_STEPS, type PlannerStepId } from '@tps/schemas';

import {
  TRIP_STATE_LABEL,
  generateButtonLabel,
  type PlannerSnapshot,
} from '@/lib/planner/step-state';

const RESEARCH_TOPICS = [
  '天气穿衣',
  '签证过境',
  '当地安全',
  '交通票制',
  '景点预约',
  '餐厅预约',
  '支付现金',
  '通信 eSIM',
] as const;

export interface SummaryRailProps {
  readonly activeStep: PlannerStepId;
  readonly snapshot: PlannerSnapshot;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly onGenerate: () => void;
  readonly onJumpToVerify: () => void;
  readonly generateDisabled: boolean;
  readonly generateNote?: React.ReactNode;
  readonly open: boolean;
}

export function SummaryRail({
  activeStep,
  snapshot,
  metrics,
  onGenerate,
  onJumpToVerify,
  generateDisabled,
  generateNote,
  open,
}: SummaryRailProps): React.ReactElement {
  const current = PLANNER_STEPS.find((step) => step.step === activeStep);
  const completed = [...snapshot.stepStates.entries()].filter(
    ([step, state]) => step !== '10' && state === 'complete',
  ).length;

  return (
    <aside
      id="planner-summary"
      className={`planner-panel planner-right${open ? ' planner-right--open' : ''}`}
      aria-label="规划进度"
    >
      <div className="planner-right__head">
        <h2 className="planner-right__title">规划进度</h2>
        <span className="planner-right__count">{snapshot.completeness}%</span>
      </div>

      <div className="planner-right-progress">
        <div className="planner-right-progress__head">
          <span>信息完整度</span>
          <strong>{snapshot.completeness}%</strong>
        </div>
        <div
          className="planner-right-progress__track"
          role="progressbar"
          aria-label="旅行规划信息完整度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={snapshot.completeness}
        >
          <span style={{ width: `${snapshot.completeness}%` }} />
        </div>
        <p>已完成 {completed}/9 个步骤。可随时返回修改，选择会自动保存。</p>
      </div>

      <section className="planner-current-step">
        <span>正在填写 · 第 {Number(activeStep)} 步</span>
        <strong>{current?.nav ?? '旅行规划'}</strong>
        <p>{current?.intro ?? ''}</p>
      </section>

      {snapshot.blockers.length > 0 || snapshot.verifyCount > 0 ? (
        <button type="button" className="planner-attention" onClick={onJumpToVerify}>
          <span>{snapshot.blockers.length > 0 ? '还有信息需要你补充' : '系统正在核验'}</span>
          <strong>
            {snapshot.blockers.length > 0
              ? `${snapshot.blockers.length} 个由你补充 · ${snapshot.verifyCount} 个系统待核验`
              : `${snapshot.verifyCount} 项已填写信息待系统核验`}
          </strong>
          <small>
            {snapshot.blockers.length > 0
              ? '点击查看具体项目，并在“确认旅程”中处理'
              : '无需重复填写 · 不影响生成初步方案 · 点击查看明细'}
          </small>
        </button>
      ) : (
        <div className="planner-attention planner-attention--ready">
          <span>生成准备</span>
          <strong>关键信息已经齐全</strong>
          <small>可继续补充偏好，也可以直接生成。</small>
        </div>
      )}

      <div className="planner-metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="planner-metric">
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>

      <div className="planner-right__actions">
        <button
          type="button"
          className="planner-button planner-button--primary planner-button--large"
          onClick={onGenerate}
          disabled={generateDisabled}
        >
          {generateButtonLabel(snapshot.tripState, snapshot.verifyCount)}
        </button>
        {generateNote}
      </div>

      <p className="planner-right__note">{TRIP_STATE_LABEL[snapshot.tripState]}</p>

      <div className="planner-research">
        <strong>这些信息由系统自动研究</strong>
        <p>不用在问卷里逐项填写。</p>
        <ul>
          {RESEARCH_TOPICS.map((topic) => (
            <li key={topic}>{topic}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
