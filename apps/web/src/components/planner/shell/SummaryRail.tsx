'use client';

import { PLANNER_STEPS, type PlannerStepId } from '@tps/schemas';

import { useSession } from '@/components/SessionProvider';
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
  /**
   * 是否禁用生成按钮。
   *
   * 与 `generateNote` 的分工：本字段表达「技术上不能点」
   * （生成中 / 未登录 / 余额不足），`generateNote` 表达「为什么」。
   * 匿名用户的拦截**不在这里** —— 由 `Planner.tsx` 的 `signedIn`
   * 在调用方就拦掉（`!signedIn` 时 `generateDisabled = true`），
   * 因此本组件**永远看不到匿名可点的状态**。
   */
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

  /*
   * 匿名状态提示（产品决策：匿名用户的行程不长期保存）。
   *
   * P7 之后默认配置下匿名入口关闭，`/auth/session` 对未注册请求返回 401，
   * `status.kind === 'ready' && user_type === 'ANONYMOUS'` 通常不可达。
   * 仍然渲染这段提示有两个理由：
   *
   *   1. 重新打开匿名入口时（运维手册「重新打开匿名入口」一节），
   *      这条提示必须存在 —— 它是设计稿二十章「匿名用户的额外声明义务」
   *      的落地点，缺失属于合规问题；
   *   2. 匿名状态下用户随时可能注册，而注册前他必须知道
   *      「当前这份计划不会长期保存」—— 这条提示放在右栏
   *      「规划进度」卡片的顶部，与「生成」按钮在同一视野内。
   *
   * 注意：本组件**不在这里拦截匿名生成** —— 那一层在 `Planner.tsx`
   * 的 `signedIn` 判定上。本提示只做告知，不做阻断。
   */
  const { status } = useSession();
  const isAnonymous = status.kind === 'ready' && status.session.user_type === 'ANONYMOUS';

  return (
    <aside
      id="planner-summary"
      className={`planner-panel planner-right${open ? ' planner-right--open' : ''}`}
      aria-label="规划进度"
    >
      {isAnonymous ? (
        <div className="planner-anon-warning" role="status">
          <span className="planner-anon-warning__badge">访客模式</span>
          <p className="planner-anon-warning__text">
            当前是<strong>匿名状态</strong>，生成的旅行计划
            <strong>不会被长期保存</strong>。注册账号可长期保存并跨设备访问。
          </p>
        </div>
      ) : null}

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
