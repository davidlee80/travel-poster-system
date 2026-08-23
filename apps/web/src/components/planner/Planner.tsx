'use client';

import type { ConditionCode } from '@tps/schemas';
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

import { generatePlan, getJobStatus } from '@/lib/api-client';
import type { GenerationPhase } from '@/lib/generation-dialog';
import { AuthPanel } from '../AuthPanel';
import {
  INITIAL_PLANNER_STATE,
  buildPlannerRequest,
  plannerReducer,
  submitBlocker,
  type StepId,
} from '@/lib/planner-state';
import {
  browserTimezone,
  missingRequiredFields,
  newClientRequestId,
} from '@/lib/travel-request-form';
import { useSession } from '../SessionProvider';
import { ConditionSummary } from './ConditionSummary';
import { GenerationDialog } from './GenerationDialog';
import { PlannerTopBar } from './PlannerTopBar';
import { StepNavigation } from './StepNavigation';
import {
  BasicSection,
  BudgetSection,
  CustomSection,
  DietSection,
  InterestsSection,
  PaceSection,
  TransportSection,
  TravelersSection,
} from './StepSections';

/**
 * 需求采集工作台（TP-8-07）。
 *
 * 三栏：左侧八步导航 + 完成度、中间八张卡片、右侧已选条件摘要与提交。
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

/**
 * 提交之后的阶段。
 *
 * 定义搬到了 `@/lib/generation-dialog` —— 弹层的文案与进度推导是纯逻辑，
 * 放在那里才能被单测覆盖（apps/web 的 vitest 环境是 node，组件测不了）。
 */
type Phase = GenerationPhase;

export function Planner(): React.ReactElement {
  const { status, refresh } = useSession();
  /*
   * 只有拿到身份才允许提交（P7 之后必须是注册用户）。
   *
   * `loading` 也算未就绪：首屏禁用比「先允许点、再发现不行」好 ——
   * 后者会让访客填完八步再被拒。
   */
  const signedIn = status.kind === 'ready';

  /**
   * 任何 401 都意味着服务端已经不认这个会话了 —— 重新解析一次身份。
   *
   * 不做这件事的表现是**界面卡死**：`SessionProvider` 只在挂载时与登出后取
   * 身份，于是会话过期（Cookie 到期、Redis 重启、在另一台设备登出）之后
   * 右上角仍然显示「已登录」、提交按钮仍然可点，而后端回的
   * 「登录状态已失效，请重新登录。」在屏幕上**找不到可以登录的地方**。
   * 用户照着提示做不到，唯一出路是自己想到刷新页面。
   *
   * 刷完之后 `status` 落到 `anonymous`，登录表单出现，提示与界面才一致。
   */
  const reauthOn401 = useCallback(
    (httpStatus: number): void => {
      if (httpStatus === 401) void refresh();
    },
    [refresh],
  );

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

  const clear = useCallback(
    (code: ConditionCode) => dispatch({ type: 'clearCondition', code }),
    [],
  );

  async function poll(jobId: string, planId: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (!cancelled.current && Date.now() < deadline) {
      const result = await getJobStatus(jobId);
      if (!result.ok) {
        // 轮询途中会话失效也要重新解析 —— 生成要跑一分多钟，够 Cookie 过期
        reauthOn401(result.status);
        setPhase({
          kind: 'error',
          message: result.message,
          retryable: result.retryable,
          needsAuth: result.status === 401,
        });
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
    /*
     * 不变量而不是 UX：按钮在缺必填项时是禁用的（见 `submitBlocker`），
     * 因此这一段正常走不到。留着是因为这个函数会构造并发出一个网络请求 ——
     * 「明知不合法还是发出去」不该只靠一个 `disabled` 属性拦住，
     * 而将来多一个提交入口（回车、快捷键）时它就是唯一的防线。
     */
    const blocked = missingRequiredFields(state);
    if (blocked.length > 0) {
      setPhase({ kind: 'error', message: `请填写：${blocked.join('、')}`, retryable: false });
      jump('basic');
      return;
    }

    setPhase({ kind: 'submitting' });
    setSummaryOpen(false);

    /*
     * 整段包在 try 里，是因为等待弹层在 `submitting` / `generating` 期间
     * **不允许关闭**（关掉了用户就再也看不到结果）。这意味着任何未捕获的
     * 异常都会把用户永久困在一个不动的弹层后面 —— 而在这之前同一个异常
     * 只表现为「点了按钮没反应」，用户至少还能重试。
     *
     * 实际撞到过一次：`crypto.randomUUID` 在明文 HTTP 下不存在，
     * `newClientRequestId()` 抛 TypeError，请求压根没发出（见那个函数的注释）。
     */
    try {
      // 13.8：每次提交换新 client_request_id，否则会拿回上一次的结果
      const body = buildPlannerRequest(state, {
        clientRequestId: newClientRequestId(),
        timezone,
      });

      const result = await generatePlan(body);
      if (!result.ok) {
        reauthOn401(result.status);
        setPhase({
          kind: 'error',
          message: result.message,
          retryable: result.retryable,
          needsAuth: result.status === 401,
        });
        return;
      }

      cancelled.current = false;
      await poll(result.data.job_id, result.data.plan_id);
    } catch (error) {
      /*
       * 原始信息带上去而不是只说「出错了」：这条路径上的异常都是浏览器环境
       * 问题（缺 API、被扩展拦掉），而那类问题只有原文能给出排查方向。
       * 标成可重试是对的 —— 换个浏览器或改成 HTTPS 之后它就好了。
       */
      setPhase({
        kind: 'error',
        message: `提交时出错：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    }
  }

  const busy = phase.kind === 'submitting' || phase.kind === 'generating';

  /*
   * 激活条件：必填 4 项 + 已登录 + 不在生成中。辅助选项一个都不参与 ——
   * 推导与理由在 `submitBlocker`。
   *
   * `missing` 单独算一份是给右栏就地列出缺什么用的：按钮禁用之后，
   * 那个「请填写：…」的错误弹层不会再出现了。
   */
  const blocker = submitBlocker(state, { signedIn, busy });
  const missing = missingRequiredFields(state);

  return (
    <div className="planner">
      <PlannerTopBar onToggleMenu={() => setMenuOpen((open) => !open)}>
        <AuthPanel />
      </PlannerTopBar>

      <div className="planner-workspace">
        <StepNavigation state={state} activeStep={activeStep} onJump={jump} open={menuOpen} />

        <main className="planner-main">
          <BasicSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <TravelersSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <BudgetSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <PaceSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <TransportSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <DietSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <InterestsSection state={state} dispatch={dispatch} registerRef={registerRef} />
          <CustomSection state={state} dispatch={dispatch} registerRef={registerRef} />

          {/*
            这里原本有三张内联状态卡（进度 / 已生成 / 失败）。它们都被
            `GenerationDialog` 取代了 —— 位置在主栏最后一张表单卡之后，
            而用户在第 1 步就能点提交按钮，四千像素之下的卡片他看不到。
          */}
        </main>

        <ConditionSummary
          state={state}
          onRemove={clear}
          onSubmit={() => void submit()}
          onReset={() => {
            dispatch({ type: 'reset' });
            setPhase({ kind: 'idle' });
          }}
          blocker={blocker}
          missing={missing}
          onJumpToMissing={() => jump('basic')}
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

      {/*
        提交之后的全过程都在弹层里。关闭时把阶段推回 idle 而不是只藏弹层 ——
        留着 `ready` 会让用户下次提交前那一瞬间又看到上一次的成功提示。
      */}
      <GenerationDialog phase={phase} onClose={() => setPhase({ kind: 'idle' })} />
    </div>
  );
}
