'use client';

import {
  PLANNER_FIELDS,
  PLANNER_STEPS,
  type PlannerFieldId,
  type PlannerStepId,
} from '@tps/schemas';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { generatePlan, getJobStatus } from '@/lib/api-client';
import { CreditHint, useCreditQuote } from './CreditHint';
import type { GenerationPhase } from '@/lib/generation-dialog';
import { buildPlannerRequest } from '@/lib/planner/request';
import { buildSnapshot, generateButtonLabel } from '@/lib/planner/step-state';
import {
  INITIAL_PLANNER_STATE,
  plannerReducer,
  readAnswer,
  type PlannerState,
} from '@/lib/planner/state';
import { clearDraft, loadDraft, saveDraft, type SaveState } from '@/lib/planner/persistence';
import { browserTimezone, newClientRequestId } from '@/lib/travel-request-form';
import { AuthPanel } from '../AuthPanel';
import { useSession } from '../SessionProvider';
import { BudgetControl } from './BudgetControl';
import { GenerationDialog } from './GenerationDialog';
import { PrepCenter } from './PrepCenter';
import { BlockerList, ReviewPanel } from './ReviewBoard';
import { StepPage } from './StepPage';
import { TemplatePicker } from './TemplatePicker';
import { TravelersControl } from './TravelersControl';
import { StepNav } from './shell/StepNav';
import { SummaryRail } from './shell/SummaryRail';
import { TopBar } from './shell/TopBar';

/**
 * 需求采集工作台（Planner V2.1，规范 3.1 的桌面端三栏结构）。
 *
 * 左栏九步导航 + 三个指标，中栏一次一步，右栏五组旅行画像。
 * 状态全部在这里，向下传 props —— 快照要在左右两栏同时用，
 * 下沉到步骤组件里就得靠 context 或重复计算，而重复计算会让
 * 「左栏说这步完成了，生成按钮说还有缺项」。
 *
 * 生成与轮询沿用 P2 的逻辑（13.1 提交 → 13.2 轮询）。
 */

/** 主问卷的九步。第 10 步是生成之后的行前准备中心（规范 16）*/
const MAIN_STEPS: readonly PlannerStepId[] = PLANNER_STEPS.filter((step) => step.step !== '10').map(
  (step) => step.step,
);

/**
 * 自动保存的防抖间隔。
 *
 * 规范 6 要求「selection 完成 / blur / repeater 变更后持久化」。这里用防抖而不是
 * 逐次写入：滑块与计数器会在一次交互里产生几十次状态变化，而 localStorage 写入
 * 是同步阻塞的 —— 逐次写会让拖动滑块明显发涩。
 *
 * 600ms 是「松手之后几乎立刻保存」与「拖动过程中一次不写」的分界。
 */
const AUTOSAVE_DEBOUNCE_MS = 600;

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

export function Planner(): React.ReactElement {
  const { status, refresh } = useSession();
  /*
   * 只有拿到身份才允许提交（P7 之后必须是注册用户）。
   * `loading` 也算未就绪：首屏禁用比「先允许点、再发现不行」好 ——
   * 后者会让访客填完九步再被拒。
   *
   * 设计决策（2026-09 修订）：**匿名身份同样禁止生成**。
   *
   * 历史上这里只检查 `status.kind === 'ready'`，匿名用户（P7 关闭前
   * 由 `/auth/session` 自动建号）也会被算作「已就绪」。现在额外排除
   * `user_type === 'ANONYMOUS'`：匿名用户可以浏览问卷、看右栏的
   * 「不会被长期保存」提示，但点不动「生成」按钮 —— 必须把流程
   * 引导到注册。这一判断**只在生成入口做**，不影响其它页面的可读性。
   */
  const signedIn =
    status.kind === 'ready' && status.session.user_type !== 'ANONYMOUS';

  /**
   * 任何 401 都意味着服务端已经不认这个会话了 —— 重新解析一次身份。
   *
   * 不做这件事的表现是**界面卡死**：`SessionProvider` 只在挂载时与登出后取
   * 身份，于是会话过期之后右上角仍然显示「已登录」、提交按钮仍然可点，
   * 而后端回的「登录状态已失效，请重新登录。」在屏幕上找不到可以登录的地方。
   */
  const reauthOn401 = useCallback(
    (httpStatus: number): void => {
      if (httpStatus === 401) void refresh();
    },
    [refresh],
  );

  const [state, dispatch] = useReducer(plannerReducer, INITIAL_PLANNER_STATE);
  const [phase, setPhase] = useState<GenerationPhase>({ kind: 'idle' });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  /**
   * 已生成的计划。
   *
   * 它同时是「行前准备中心是否可用」的开关（规范 16：**初步方案生成后**）。
   * 单独一个 state 而不是从 `phase` 推：`phase` 会被关闭弹层重置成 `idle`，
   * 而那时计划已经生成了 —— 用 phase 推会让准备中心在关掉弹层后消失。
   */
  const [planId, setPlanId] = useState<string | null>(null);
  /** 准备中心里展开的卡片。放在这里而不是 PrepCenter 内部 —— 切走再回来要保留 */
  const [openPrepCards, setOpenPrepCards] = useState<readonly PlannerFieldId[]>([]);

  const fieldNodes = useRef(new Map<PlannerFieldId, HTMLElement>());
  /** 首次挂载时不写草稿 —— 那会把一份空状态盖掉刚读出来的草稿 */
  const hydrated = useRef(false);
  /** 防止组件卸载后仍在轮询并 setState */
  const cancelled = useRef(false);

  const timezone = useMemo(() => browserTimezone(), []);

  /*
   * 草稿恢复只在挂载时做一次。
   *
   * 放在 effect 里而不是 `useReducer` 的初始值里：`localStorage` 在服务端渲染
   * 时不存在，作为初始值会让首屏 HTML 与客户端首次渲染不一致（hydration
   * mismatch）。React 会静默丢弃服务端那份并重渲染，代价是首屏闪一下。
   */
  useEffect(() => {
    const draft = loadDraft();
    if (draft !== null) {
      dispatch({ type: 'restore', state: draft });
      setSaveState('saved');
    }
    hydrated.current = true;
  }, []);

  /* Dev Mode 由 URL 上的 `?dev=1` 打开。生产端默认隐藏（规范 21.1）*/
  const [devAvailable, setDevAvailable] = useState(false);
  useEffect(() => {
    const on = new URLSearchParams(window.location.search).get('dev') === '1';
    setDevAvailable(on);
    if (on) dispatch({ type: 'setDevMode', on: true });
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    setSaveState('saving');
    const timer = setTimeout(() => {
      setSaveState(saveDraft(state, new Date().toISOString()) ? 'saved' : 'failed');
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  /* 卸载后停止轮询。不做的话 `setPhase` 会作用在一个已经不存在的组件上 */
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const snapshot = useMemo(
    /*
     * `planGenerated` 让 `tripState` 落到 `plan-generated`（规范 5.3）。
     * 不传的话生成完成之后右栏仍然写着「可以生成初步方案」——
     * 而用户已经拿到方案了。
     */
    () => buildSnapshot(state, { planGenerated: planId !== null }),
    [state, planId],
  );
  const metrics = useMemo(() => buildMetrics(state), [state]);

  /*
   * ── CR 报价（C-6）──
   *
   * 只在**装配了计费**（会话里带 `wallet`）时请求。没装配的部署里 CR 这个
   * 概念对用户根本不存在，而一次必然失败的请求（那三个端点没注册，404）
   * 只会在控制台里留下一条让人以为出了故障的报错。
   */
  const totalDays = useMemo(
    () => tripDays(readAnswer(state.answers, 'trip.dates')),
    [state.answers],
  );
  const billingOn = status.kind === 'ready' && status.session.wallet !== undefined;
  const credits = useCreditQuote(totalDays, billingOn);

  const registerField = useCallback((fieldId: PlannerFieldId, node: HTMLElement | null) => {
    if (node === null) fieldNodes.current.delete(fieldId);
    else fieldNodes.current.set(fieldId, node);
  }, []);

  const goToStep = useCallback((step: PlannerStepId) => {
    dispatch({ type: 'goToStep', step });
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  /**
   * 摘要 chip 回跳（规范 17.2）：切到来源步骤、滚动到字段并聚焦。
   *
   * `setTimeout(0)`：切步骤后目标字段要等这一帧渲染完才在 DOM 里，
   * 同步 `focus()` 会作用在一个还不存在的节点上 —— 表现是「跳到了那一步
   * 但没有滚动、也没有高亮」。
   */
  const jumpToField = useCallback((step: PlannerStepId, fieldId: PlannerFieldId) => {
    dispatch({ type: 'goToStep', step });
    setSummaryOpen(false);
    setTimeout(() => {
      const node = fieldNodes.current.get(fieldId);
      if (node === undefined) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.focus({ preventScroll: true });
    }, 0);
  }, []);

  /** 右栏状态卡直接定位到具体问题清单，避免只跳到确认页顶部却看不到要确认什么。 */
  const jumpToReviewIssues = useCallback(() => {
    goToStep('09');
    setSummaryOpen(false);
    setTimeout(() => {
      const target = document.getElementById(
        snapshot.blockers.length > 0 ? 'planner-blockers' : 'planner-verifications',
      );
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
    }, 0);
  }, [goToStep, snapshot.blockers.length]);

  async function poll(jobId: string, generatedPlanId: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (!cancelled.current && Date.now() < deadline) {
      const result = await getJobStatus(jobId);
      if (!result.ok) {
        // 轮询途中会话失效也要重新解析 —— 生成要跑一分多钟，够 Cookie 过期
        reauthOn401(result.status);
        setPhase({
          kind: 'error',
          message: generationRequestError(result.message, result.field),
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
        setPhase({ kind: 'ready', planId: generatedPlanId });
        /* 计划可读之后开放行前准备中心（规范 16）*/
        setPlanId(generatedPlanId);
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

  /**
   * 生成入口（规范 18 的三态）。
   *
   * `blocked` 时**不发请求**而是把用户送到第 9 步的问题清单 —— 规范原文：
   * 「按钮可点击但进入问题定位，不建议纯 disabled；避免用户不知道为何不能生成」。
   * 一个灰掉的按钮不解释任何事，而用户唯一能做的是把每一步再翻一遍。
   *
   * `draft` 同样送到第 9 步：那一页会列出还缺哪几项必答，
   * 比在右栏弹一句「请先完善画像」有用。
   */
  async function submit(): Promise<void> {
    if (snapshot.tripState === 'blocked' || snapshot.tripState === 'draft') {
      jumpToReviewIssues();
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
      const stamp = new Date();
      // 13.8：每次提交换新 client_request_id，否则会拿回上一次的结果
      const body = buildPlannerRequest(state, {
        clientRequestId: newClientRequestId(),
        timezone,
        today: stamp.toISOString().slice(0, 10),
        now: stamp.toISOString(),
      });

      const result = await generatePlan(body);
      if (!result.ok) {
        reauthOn401(result.status);
        setPhase({
          kind: 'error',
          message: generationRequestError(result.message, result.field),
          retryable: result.retryable,
          needsAuth: result.status === 401,
          /*
           * 402 带着 `required_cr` / `balance_cr`（13.0 的 `details`）。
           * 用它算「还差多少」而不是再发一次报价请求 —— 这是用户最需要
           * 那个数的时刻，多一次往返多一次失败机会。
           */
          ...shortfallOf(result),
        });
        return;
      }

      cancelled.current = false;
      await poll(result.data.job_id, result.data.plan_id);
    } catch (error) {
      /*
       * 原始信息带上去而不是只说「出错了」：这条路径上的异常都是浏览器环境
       * 问题（缺 API、被扩展拦掉），而那类问题只有原文能给出排查方向。
       */
      setPhase({
        kind: 'error',
        message: `提交时出错：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    }
  }

  const busy = phase.kind === 'submitting' || phase.kind === 'generating';
  const activeIndex = MAIN_STEPS.indexOf(state.activeStep);
  const prevStep = activeIndex > 0 ? MAIN_STEPS[activeIndex - 1] : undefined;
  const nextStep = activeIndex >= 0 ? MAIN_STEPS[activeIndex + 1] : undefined;
  const nextMeta = PLANNER_STEPS.find((step) => step.step === nextStep);

  /**
   * 第 9 步的两个元字段由复核面板承载。
   *
   * 通过 `slots` 注入而不是让 `StepPage` 认识第 9 步：`StepPage` 的职责是
   * 「按区块表渲染这一步的字段」，让它 `if (step === '09')` 会让第 9 步的
   * 特殊性散进一个通用组件里，而下一个特殊步骤（第 10 步的行前准备中心）
   * 又要加一个 if。
   */
  const reviewSlots = {
    'PV2-09-001': (
      <ReviewPanel
        state={state}
        snapshot={snapshot}
        dispatch={dispatch}
        onJumpToField={jumpToField}
      />
    ),
    'PV2-09-002': (
      <BlockerList
        state={state}
        snapshot={snapshot}
        dispatch={dispatch}
        onJumpToField={jumpToField}
        registerField={registerField}
      />
    ),
  } as const;

  const travelerSlots = {
    'PV2-02-001': <TravelersControl state={state} dispatch={dispatch} />,
  } as const;

  const budgetSlots = {
    'PV2-03-001': <BudgetControl state={state} dispatch={dispatch} />,
  } as const;

  return (
    <div className="planner">
      <TopBar
        saveState={saveState}
        onRetrySave={() =>
          setSaveState(saveDraft(state, new Date().toISOString()) ? 'saved' : 'failed')
        }
        devMode={state.devMode}
        onToggleDevMode={() => dispatch({ type: 'setDevMode', on: !state.devMode })}
        showDevToggle={devAvailable}
        menuOpen={menuOpen}
        onReset={() => {
          if (!window.confirm('重新开始会清空当前旅行问卷，且无法撤销。确定继续吗？')) return;
          clearDraft();
          dispatch({ type: 'reset' });
          setSaveState('idle');
        }}
        onToggleMenu={() => {
          setSummaryOpen(false);
          setMenuOpen((open) => !open);
        }}
      >
        <AuthPanel />
      </TopBar>

      <div className="planner-workspace">
        <StepNav
          activeStep={state.activeStep}
          snapshot={snapshot}
          onJump={goToStep}
          open={menuOpen}
          planGenerated={planId !== null}
        />

        <main className="planner-main">
          {MAIN_STEPS.filter((step) => step === state.activeStep).map((step) => (
            <StepPage
              key={step}
              step={step}
              active={step === state.activeStep}
              state={state}
              snapshot={snapshot}
              dispatch={dispatch}
              onPrev={prevStep === undefined ? null : () => goToStep(prevStep)}
              onNext={nextStep === undefined ? null : () => goToStep(nextStep)}
              nextLabel={nextMeta === undefined ? null : `下一步 · ${nextMeta.nav} →`}
              registerField={registerField}
              {...(step === '02'
                ? { slots: travelerSlots, hiddenFields: ['PV2-02-002'] as const }
                : {})}
              {...(step === '03'
                ? {
                    slots: budgetSlots,
                    hiddenFields: ['PV2-03-002', 'PV2-03-003', 'PV2-03-004', 'PV2-03-005'] as const,
                  }
                : {})}
              {...(step === '09'
                ? {
                    slots: reviewSlots,
                    /* 输出样式选择器（R-85 P3）。选项为空时它自己不渲 */
                    beforeActions: (
                      <TemplatePicker selected={state.templateId} dispatch={dispatch} />
                    ),
                    actions: generateButton(),
                  }
                : {})}
            />
          ))}

          {/*
            行前准备中心只在方案生成之后出现（规范 16）。
            它不是 `StepPage` 的一个 step —— 组织方式是任务卡而不是表单区块，
            底部也没有「上一步 / 下一步」。硬塞进 StepPage 会让那个组件
            长出一个只服务于第 10 步的分支。
          */}
          {planId !== null && state.activeStep === '10' ? (
            <PrepCenter
              state={state}
              snapshot={snapshot}
              dispatch={dispatch}
              registerField={registerField}
              openCards={openPrepCards}
              onToggleCard={(fieldId) =>
                setOpenPrepCards((open) =>
                  open.includes(fieldId)
                    ? open.filter((entry) => entry !== fieldId)
                    : [...open, fieldId],
                )
              }
              planId={planId}
            />
          ) : null}
        </main>

        <SummaryRail
          activeStep={state.activeStep}
          snapshot={snapshot}
          metrics={metrics}
          /*
           * 右栏的生成入口与第 9 步底部那个是**同一个动作**。
           *
           * 曾经它只是「跳到第 9 步」，因为提交要先过授权勾选。现在
           * `submit()` 自己判断：`blocked` / `draft` 时跳第 9 步，
           * 其余情况直接提交 —— 而 CONSENT 未勾选正是让 tripState 变成
           * `blocked` 的原因之一（见 `computeTripState`），因此授权
           * 绕不过去，同时已经填完的用户也不必多点一次。
           */
          onGenerate={() => void submit()}
          onJumpToVerify={jumpToReviewIssues}
          generateDisabled={busy || !signedIn || credits.insufficient}
          generateNote={<CreditHint hint={credits.hint} />}
          open={summaryOpen}
        />
      </div>

      {menuOpen || summaryOpen ? null : (
        <button
          type="button"
          className="planner-button planner-button--primary planner-mobile-summary"
          onClick={() => setSummaryOpen(true)}
          aria-expanded="false"
          aria-controls="planner-summary"
        >
          查看规划进度
        </button>
      )}

      {/* 窄屏抽屉的遮罩。点它收起，不改任何答案 */}
      <div
        className={`planner-drawer-scrim${menuOpen || summaryOpen ? ' planner-drawer-scrim--open' : ''}`}
        onClick={() => {
          setMenuOpen(false);
          setSummaryOpen(false);
        }}
        aria-hidden="true"
      />

      <GenerationDialog phase={phase} onClose={() => setPhase({ kind: 'idle' })} />
    </div>
  );

  function generateButton(): React.ReactElement {
    return (
      <>
        <button
          type="button"
          className="planner-button planner-button--primary planner-button--large"
          onClick={() => void submit()}
          disabled={busy || !signedIn || credits.insufficient}
        >
          {generateButtonLabel(snapshot.tripState, snapshot.verifyCount)}
        </button>
        {signedIn ? null : (
          <span className="planner-actions__note">
            {status.kind === 'ready' && status.session.user_type === 'ANONYMOUS'
              ? /* 匿名用户：账号已存在，引导「注册以保存」而不是「登录」 */
                '匿名身份下生成内容不会被保存 —— 注册账号后即可生成并长期保存。'
              : /* 完全未登录：标准是「登录/注册」 */
                '登录后才能生成 —— 右上角可以登录或注册。'}
          </span>
        )}
        <CreditHint hint={credits.hint} />
      </>
    );
  }
}

/**
 * API 的错误信封已经带首个失败字段；生成弹层必须把它保留下来。
 * `planner_profile` 内的路径优先翻译为问卷问题，原始路径继续显示，便于日志和
 * 页面提示使用同一个定位依据。未知的投影字段也至少不会再被通用文案吞掉。
 */
function generationRequestError(message: string, field?: string): string {
  if (field === undefined || field === 'body') return message;

  const profilePath = field.startsWith('planner_profile.')
    ? field.slice('planner_profile.'.length)
    : null;
  const spec =
    profilePath === null
      ? undefined
      : [...PLANNER_FIELDS]
          .sort((left, right) => right.api_key.length - left.api_key.length)
          .find(
            (candidate) =>
              profilePath === candidate.api_key || profilePath.startsWith(`${candidate.api_key}.`),
          );

  return spec === undefined
    ? `${message}（字段：${field}）`
    : `${message}；请检查“${spec.question}”（字段：${field}）。`;
}

/**
 * 右栏底部的四个数字。
 *
 * 它们是**派生值**而不是字段：天数由日期算、人数由 count 取、预算由模式与区间
 * 拼。放在右栏是因为它们是用户最常回头确认的四项，而回到第 1 步翻日期
 * 会打断当前这一步的填写。
 */
function buildMetrics(
  state: PlannerState,
): readonly { readonly label: string; readonly value: string }[] {
  const dates = readAnswer(state.answers, 'trip.dates');
  const days = tripDays(dates);
  const people = readAnswer(state.answers, 'travelers.count');
  const range = readAnswer(state.answers, 'budget.target_range');
  const walking = readAnswer(state.answers, 'pace.walking_tolerance');

  return [
    { label: '目标总预算', value: formatRange(range) },
    { label: '行程天数', value: days === null ? '—' : `${days} 天` },
    { label: '旅行人数', value: typeof people === 'number' ? `${people} 人` : '—' },
    { label: '每日步行', value: WALKING_LABEL[String(walking)] ?? '—' },
  ];
}

function tripDays(dates: unknown): number | null {
  if (typeof dates !== 'object' || dates === null) return null;
  const record = dates as Record<string, unknown>;
  const start = record['start_date'];
  const end = record['end_date'];
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const diff = Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`);
  if (Number.isNaN(diff) || diff < 0) return null;
  return Math.floor(diff / 86_400_000) + 1;
}

function formatRange(range: unknown): string {
  if (typeof range !== 'object' || range === null) return '待估算';
  const record = range as Record<string, unknown>;
  const min = record['min'];
  const max = record['max'];
  if (typeof min !== 'number' || typeof max !== 'number') return '待估算';
  return `${min.toLocaleString('zh-CN')}～${max.toLocaleString('zh-CN')}`;
}

const WALKING_LABEL: Record<string, string> = {
  UP_TO_3KM: '≤ 3 km',
  KM_3_TO_5: '3–5 km',
  KM_5_TO_8: '5–8 km',
  KM_8_TO_12: '8–12 km',
  OVER_12KM: '12 km+',
};

/**
 * 从 402 的 `details` 里取「还差多少 CR」。
 *
 * 只在真的是 402 且两个数都在时返回 —— 缺一个就退回通用文案，
 * 而不是显示一个 `NaN CR`。
 */
function shortfallOf(result: {
  readonly status: number;
  readonly details?: Readonly<Record<string, number>>;
}): { readonly shortfallCr?: number } {
  if (result.status !== 402) return {};
  const required = result.details?.['required_cr'];
  const balance = result.details?.['balance_cr'];
  if (typeof required !== 'number' || typeof balance !== 'number') return {};
  return { shortfallCr: Math.max(0, required - balance) };
}
