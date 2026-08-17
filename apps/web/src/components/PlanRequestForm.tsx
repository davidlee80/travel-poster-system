'use client';

import { CONDITION_DOMAIN_LABEL, CONDITION_LABEL } from '@tps/presentation';
import {
  CONDITION_CODES_BY_DOMAIN,
  CONDITION_DOMAIN_VALUES,
  PACE_LEVEL_VALUES,
  type ConditionCode,
  type PaceLevel,
} from '@tps/schemas';
import { useCallback, useMemo, useRef, useState } from 'react';

import { generatePlan, getJobStatus } from '@/lib/api-client';
import {
  INITIAL_FORM_STATE,
  browserTimezone,
  buildTravelRequest,
  missingRequiredFields,
  newClientRequestId,
  type TravelRequestFormState,
} from '@/lib/travel-request-form';

/**
 * 旅行需求表单（TP-2-17，设计稿五章）。
 *
 * 提交后轮询 13.2 的任务状态，直到计划可读。P2 的任务推进到 `SAVING_PLAN`
 * 就停下（见 generation-worker 的说明），因此**判断「可以看了」的依据是
 * 状态到达 `SAVING_PLAN`**，而不是 `COMPLETED` —— 后者要等 P3 的渲染链路。
 */

const PACE_LABEL: Record<PaceLevel, string> = {
  RELAXED: '轻松（每天 2～3 个景点）',
  BALANCED: '适中（每天 3～4 个景点）',
  PACKED: '紧凑（每天 4～6 个景点）',
};

/** 轮询间隔。21.2 的 T1 目标是 75 秒内出文字版计划，2 秒足够跟上进度条 */
const POLL_INTERVAL_MS = 2_000;
/** 16.3：整个生成任务上限 300 秒。轮询上限略高于它，避免比服务端先放弃 */
const POLL_TIMEOUT_MS = 320_000;

/** 计划已可读的状态。P2 停在 SAVING_PLAN */
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

export function PlanRequestForm(): React.ReactElement {
  const [state, setState] = useState<TravelRequestFormState>(INITIAL_FORM_STATE);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  /** 防止组件卸载后仍在轮询并 setState */
  const cancelled = useRef(false);

  const update = useCallback(
    <K extends keyof TravelRequestFormState>(key: K, value: TravelRequestFormState[K]) => {
      setState((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const toggleCondition = useCallback((code: ConditionCode) => {
    setState((current) => ({
      ...current,
      conditions: current.conditions.includes(code)
        ? current.conditions.filter((entry) => entry !== code)
        : [...current.conditions, code],
    }));
  }, []);

  const timezone = useMemo(() => browserTimezone(), []);

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
         * 13.2 的 message 在 FAILED 时就是 13.7 错误码对应的用户文案，
         * 直接展示即可 —— 前端自己拼一句「生成失败」会盖掉
         * 「请放宽部分条件后重试」这种唯一有用的指引。
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

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();

    const missing = missingRequiredFields(state);
    if (missing.length > 0) {
      setPhase({ kind: 'error', message: `请填写：${missing.join('、')}`, retryable: false });
      return;
    }

    setPhase({ kind: 'submitting' });

    // 13.8：每次提交换新 client_request_id，否则会拿回上一次的结果
    const body = buildTravelRequest(state, {
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
    <form className="request-form" onSubmit={(event) => void submit(event)}>
      <h2 className="request-form__title">旅行需求</h2>

      <div className="request-form__row">
        <label className="request-form__field">
          <span>出发地</span>
          <input
            value={state.origin}
            onChange={(event) => update('origin', event.target.value)}
            placeholder="上海"
            maxLength={200}
          />
        </label>
        <label className="request-form__field">
          <span>目的地</span>
          <input
            value={state.destination}
            onChange={(event) => update('destination', event.target.value)}
            placeholder="杭州"
            maxLength={200}
          />
        </label>
      </div>

      <div className="request-form__row">
        <label className="request-form__field">
          <span>出发日期</span>
          <input
            type="date"
            value={state.startDate}
            onChange={(event) => update('startDate', event.target.value)}
          />
        </label>
        <label className="request-form__field">
          <span>返回日期</span>
          <input
            type="date"
            value={state.endDate}
            onChange={(event) => update('endDate', event.target.value)}
          />
        </label>
      </div>

      <div className="request-form__row">
        <label className="request-form__field">
          <span>成人</span>
          <input
            type="number"
            min={0}
            max={20}
            value={state.adults}
            onChange={(event) => update('adults', Number(event.target.value))}
          />
        </label>
        <label className="request-form__field">
          <span>儿童人数</span>
          <input
            type="number"
            min={0}
            max={10}
            value={state.childAges.length}
            onChange={(event) => {
              const count = Math.max(0, Math.min(10, Number(event.target.value)));
              // 默认按 8 岁计；具体年龄影响的是「适合儿童」的判断粒度，
              // 而 V-33 只看有没有儿童
              update(
                'childAges',
                Array.from({ length: count }, (_, i) => state.childAges[i] ?? 8),
              );
            }}
          />
        </label>
        <label className="request-form__field">
          <span>长者人数</span>
          <input
            type="number"
            min={0}
            max={10}
            value={state.seniorCount}
            onChange={(event) => update('seniorCount', Number(event.target.value))}
          />
        </label>
      </div>

      <div className="request-form__row">
        <label className="request-form__field">
          <span>预算口径</span>
          <select
            value={state.budgetBasis}
            onChange={(event) =>
              update('budgetBasis', event.target.value as TravelRequestFormState['budgetBasis'])
            }
          >
            <option value="PER_PERSON_PER_DAY">每人每天</option>
            <option value="TOTAL">全程总额</option>
          </select>
        </label>
        <label className="request-form__field">
          <span>预算下限（元）</span>
          <input
            type="number"
            min={0}
            value={state.budgetMin}
            onChange={(event) => update('budgetMin', Number(event.target.value))}
          />
        </label>
        <label className="request-form__field">
          <span>预算上限（元）</span>
          <input
            type="number"
            min={0}
            value={state.budgetMax}
            onChange={(event) => update('budgetMax', Number(event.target.value))}
          />
        </label>
      </div>

      <label className="request-form__field">
        <span>行程节奏</span>
        <select
          value={state.paceLevel}
          onChange={(event) => update('paceLevel', event.target.value as PaceLevel)}
        >
          {PACE_LEVEL_VALUES.map((level) => (
            <option key={level} value={level}>
              {PACE_LABEL[level]}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="request-form__conditions">
        <legend>偏好与限制</legend>
        {CONDITION_DOMAIN_VALUES.map((domain) => (
          <div key={domain} className="request-form__condition-group">
            <h3>{CONDITION_DOMAIN_LABEL[domain]}</h3>
            <div className="request-form__checks">
              {CONDITION_CODES_BY_DOMAIN[domain].map((code) => (
                <label key={code} className="request-form__check">
                  <input
                    type="checkbox"
                    checked={state.conditions.includes(code)}
                    onChange={() => toggleCondition(code)}
                  />
                  <span>{CONDITION_LABEL[code]}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      <label className="request-form__field">
        <span>补充说明（最多 500 字，超出会被截断并告知）</span>
        <textarea
          value={state.customText}
          onChange={(event) => update('customText', event.target.value)}
          rows={3}
          maxLength={5_000}
          placeholder="例如：想看运河和博物馆，晚上不要太晚。"
        />
      </label>

      <button className="request-form__submit" type="submit" disabled={busy}>
        {busy ? '生成中…' : '生成旅行计划'}
      </button>

      {phase.kind === 'generating' ? (
        <div className="request-form__status" role="status">
          <div className="request-form__bar">
            <div className="request-form__bar-fill" style={{ width: `${phase.progress}%` }} />
          </div>
          <p>
            {phase.message}（{phase.progress}%）
          </p>
        </div>
      ) : null}

      {phase.kind === 'ready' ? (
        <p className="request-form__done" role="status">
          计划已生成。<a href={`/plans/${phase.planId}`}>查看完整计划</a>
        </p>
      ) : null}

      {phase.kind === 'error' ? (
        <p className="request-form__error" role="alert">
          {phase.message}
          {phase.retryable ? '（可以重试）' : ''}
        </p>
      ) : null}
    </form>
  );
}
