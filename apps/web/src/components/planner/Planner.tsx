'use client';

import type { ConditionCode } from '@tps/schemas';
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

import { generatePlan, getJobStatus } from '@/lib/api-client';
import {
  INITIAL_PLANNER_STATE,
  buildPlannerRequest,
  plannerReducer,
  type StepId,
} from '@/lib/planner-state';
import {
  browserTimezone,
  missingRequiredFields,
  newClientRequestId,
} from '@/lib/travel-request-form';
import { useSession } from '../SessionProvider';
import { ConditionSummary } from './ConditionSummary';
import { PlannerTopBar } from './PlannerTopBar';
import { StepNavigation } from './StepNavigation';
import {
  BasicSection,
  BudgetSection,
  CustomSection,
  InterestsSection,
  PaceSection,
  TransportSection,
  TravelersSection,
} from './StepSections';

/**
 * 需求采集工作台（TP-8-07）。
 *
 * 三栏：左侧七步导航 + 完成度、中间七张卡片、右侧已选条件摘要与提交。
 * 状态全部在这里，向下传 props —— 完成度要在左右两栏同时用，
 * 下沉到 section 里就得靠 context 或重复计算。
 *
 * 生成与轮询沿用 P2 的逻辑（13.1 提交 → 13.2 轮询）。
 */

/** 轮询间隔。21.2 的 T1 目标是 75 秒内出文字版计划，2 秒足够跟上进度条 */
const POLL_INTERVAL_MS = 2_000;
/** 16.3：整个生成任务上限 300 秒。轮询上限略高于它，避免比服务端先放弃 */
const POLL_TIMEOUT_MS = 320_000;

/**
 * 计划已可读的状态。
 *
 * 判断依据是「到达 SAVING_PLAN」而不是 COMPLETED：后者要等渲染与导出走完，
 * 而文字版计划在存库那一刻就能看了 —— 让用户多等 40 秒没有收益。
 */
const READABLE_STATUSES = new Set([
  'SAVING_PLAN',
  'BUILDING_PRESENTATION',
  'RESOLVING_ASSETS',
  'GENERATING_ASSETS',
  'RENDERING_HTML',
  'EXPORTING_PNG',
  'EXPORTING_PDF',
  'COMPLETED',
]);

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'generating'; readonly progress: number; readonly message: string }
  | { readonly kind: 'ready'; readonly planId: string }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

export function Planner(): React.ReactElement {
  const { status } = useSession();
  /*
   * 只有拿到身份才允许提交（P7 之后必须是注册用户）。
   *
   * `loading` 也算未就绪：首屏禁用比「先允许点、再发现不行」好 ——
   * 后者会让访客填完七步再被拒。
   */
  const signedIn = status.kind === 'ready';

  const [state, dispatch] = useReducer(plannerReducer, INITIAL_PLANNER_STATE);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [activeStep, setActiveStep] = useState<StepId>('basic');
  const [menuOpen, setMenuOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const sections = useRef(new Map<StepId, HTMLElement>());
  /** 防止组件卸载后仍在轮询并 setState */
  const cancelled = useRef(false);

  const timezone = useMemo(() => browserTimezone(), []);

  const registerRef = useCallback(
    (step: StepId) => (node: HTMLElement | null) => {
      if (node === null) sections.current.delete(step);
      else sections.current.set(step, node);
    },
    [],
  );

  const jump = useCallback((step: StepId) => {
    setActiveStep(step);
    setMenuOpen(false);
    sections.current.get(step)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const cycle = useCallback(
    (code: ConditionCode) => dispatch({ type: 'cycleCondition', code }),
    [],
  );

  async function poll(jobId: string, planId: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (!cancelled.current && Date.now() < deadline) {
      const result = await getJobStatus(jobId);
      if (!result.ok) {
        setPhase({ kind: 'error', message: result.message, retryable: result.retryable });
        return;
      }
      if (result.data.status === 'FAILED') {
        /*
         * 13.2 的 message 在 FAILED 时就是错误码对应的用户文案，直接展示 ——
         * 前端自己拼一句「生成失败」会盖掉「请放宽部分条件后重试」这种
         * 唯一有用的指引。
         */
        setPhase({ kind: 'error', message: result.data.message, retryable: false });
        return;
      }
      if (READABLE_STATUSES.has(result.data.status)) {
        setPhase({ kind: 'ready', planId });
        return;
      }

      setPhase({
        kind: 'generating',
        progress: result.data.progress,
        message: result.data.message,
      });
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!cancelled.current) {
      setPhase({
        kind: 'error',
        message: '生成用时过长，请稍后在历史记录里查看。',
        retryable: true,
      });
    }
  }

  async function submit(): Promise<void> {
    const missing = missingRequiredFields(state);
    if (missing.length > 0) {
      setPhase({ kind: 'error', message: `请填写：${missing.join('、')}`, retryable: false });
      // 缺的一定在第 1 步，直接把用户送回去 —— 否则他要自己找哪里红了
      jump('basic');
      return;
    }

    setPhase({ kind: 'submitting' });
    setSummaryOpen(false);

    // 13.8：每次提交换新 client_request_id，否则会拿回上一次的结果
    const body = buildPlannerRequest(state, {
      clientRequestId: newClientRequestId(),
      timezone,
    });

    const result = await generatePlan(body);
    if (!result.ok) {
      setPhase({ kind: 'error', message: result.message, retryable: result.retryable });
      return;
    }

    cancelled.current = false;
    await poll(result.data.job_id, result.data.plan_id);
  }

  const busy = phase.kind === 'submitting' || phase.kind === 'generating';

  return (
    <div className="planner">
      <PlannerTopBar
        onReset={() => {
          dispatch({ type: 'reset' });
          setPhase({ kind: 'idle' });
        }}
        onToggleMenu={() => setMenuOpen((open) => !open)}
      />

      <div className="planner-workspace">
        <StepNavigation state={state} activeStep={activeStep} onJump={jump} open={menuOpen} />

        <main className="planner-main">
          <BasicSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <TravelersSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <BudgetSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <PaceSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <TransportSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <InterestsSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <CustomSection state={state} dispatch={dispatch} registerRef={registerRef} />

          {phase.kind === 'generating' ? (
            <div className="planner-panel planner-card planner-status" role="status">
              <div className="planner-status__bar">
                <div className="planner-status__fill" style={{ width: `${phase.progress}%` }} />
              </div>
              <p>
                {phase.message}（{phase.progress}%）
              </p>
            </div>
          ) : null}

          {phase.kind === 'ready' ? (
            <div
              className="planner-panel planner-card planner-status planner-status--done"
              role="status"
            >
              <p>
                计划已生成。<a href={`/plans/${phase.planId}`}>查看完整计划</a>
              </p>
            </div>
          ) : null}

          {phase.kind === 'error' ? (
            <div
              className="planner-panel planner-card planner-status planner-status--error"
              role="alert"
            >
              <p>
                {phase.message}
                {phase.retryable ? '（可以重试）' : ''}
              </p>
            </div>
          ) : null}
        </main>

        <ConditionSummary
          state={state}
          onCycle={cycle}
          onSubmit={() => void submit()}
          busy={busy}
          signedIn={signedIn}
          open={summaryOpen}
        />
      </div>

      {/* 窄屏时右栏收成抽屉，用这个按钮唤出 */}
      <button
        type="button"
        className="planner-button planner-button--primary planner-mobile-summary"
        onClick={() => setSummaryOpen((open) => !open)}
      >
        查看已选条件
      </button>
    </div>
  );
}
