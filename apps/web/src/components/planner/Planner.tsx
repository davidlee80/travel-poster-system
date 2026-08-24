'use client';

import { PLANNER_STEPS, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { buildSummary } from '@/lib/planner/summary';
import { buildSnapshot } from '@/lib/planner/step-state';
import {
  INITIAL_PLANNER_STATE,
  plannerReducer,
  readAnswer,
  type PlannerState,
} from '@/lib/planner/state';
import { clearDraft, loadDraft, saveDraft, type SaveState } from '@/lib/planner/persistence';
import { AuthPanel } from '../AuthPanel';
import { StepPage } from './StepPage';
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
 */

/** 主问卷的九步。第 10 步是生成之后的行前准备中心（规范 16），不在导航里 */
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

export function Planner(): React.ReactElement {
  const [state, dispatch] = useReducer(plannerReducer, INITIAL_PLANNER_STATE);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const fieldNodes = useRef(new Map<PlannerFieldId, HTMLElement>());
  /** 首次挂载时不写草稿 —— 那会把一份空状态盖掉刚读出来的草稿 */
  const hydrated = useRef(false);

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

  const snapshot = useMemo(() => buildSnapshot(state), [state]);
  const sections = useMemo(() => buildSummary(state, snapshot), [state, snapshot]);
  const metrics = useMemo(() => buildMetrics(state), [state]);

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

  const activeIndex = MAIN_STEPS.indexOf(state.activeStep);
  const prevStep = activeIndex > 0 ? MAIN_STEPS[activeIndex - 1] : undefined;
  const nextStep = activeIndex >= 0 ? MAIN_STEPS[activeIndex + 1] : undefined;
  const nextMeta = PLANNER_STEPS.find((step) => step.step === nextStep);

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
        onReset={() => {
          clearDraft();
          dispatch({ type: 'reset' });
          setSaveState('idle');
        }}
        onToggleMenu={() => setMenuOpen((open) => !open)}
      >
        <AuthPanel />
      </TopBar>

      <div className="planner-workspace">
        <StepNav
          activeStep={state.activeStep}
          snapshot={snapshot}
          onJump={goToStep}
          open={menuOpen}
        />

        <main className="planner-main">
          {MAIN_STEPS.map((step) => (
            <StepPage
              key={step}
              step={step}
              active={step === state.activeStep}
              snapshot={snapshot}
              devMode={state.devMode}
              onPrev={prevStep === undefined ? null : () => goToStep(prevStep)}
              onNext={nextStep === undefined ? null : () => goToStep(nextStep)}
              nextLabel={nextMeta === undefined ? null : `下一步 · ${nextMeta.nav} →`}
              registerField={registerField}
            />
          ))}
        </main>

        <SummaryRail
          sections={sections}
          snapshot={snapshot}
          metrics={metrics}
          onJumpToField={jumpToField}
          /*
           * 生成入口现在把用户送到第 9 步。
           *
           * 那一页承载「确认 + 精准补问 + 授权 + 生成」（规范 15），提交与
           * blocker 定位都在那里 —— 在右栏直接发请求会绕过授权勾选，
           * 而 CONSENT 是运行时优先级第二高的约束（4.1）。
           */
          onGenerate={() => goToStep('09')}
          onJumpToVerify={() => goToStep('09')}
          generateDisabled={false}
          open={summaryOpen}
        />
      </div>

      <button
        type="button"
        className="planner-button planner-button--primary planner-mobile-summary"
        onClick={() => setSummaryOpen((open) => !open)}
      >
        查看旅行画像
      </button>

      {/* 窄屏抽屉的遮罩。点它收起，不改任何答案 */}
      <div
        className={`planner-drawer-scrim${menuOpen || summaryOpen ? ' planner-drawer-scrim--open' : ''}`}
        onClick={() => {
          setMenuOpen(false);
          setSummaryOpen(false);
        }}
        aria-hidden="true"
      />
    </div>
  );
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
