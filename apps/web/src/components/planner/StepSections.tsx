'use client';

import { CONDITION_LABEL } from '@tps/presentation';
import {
  EXISTING_BOOKING_VALUES,
  type BudgetIncludedItem,
  type BudgetTier,
  type ConditionCode,
  type ExistingBooking,
} from '@tps/schemas';

import {
  BUDGET_DAILY_CEILING,
  BUDGET_DAILY_FLOOR,
  BUDGET_FOCUS_CODES,
  BUDGET_ITEM_LABEL,
  BUDGET_TIER_PRESETS,
  DIET_TAG_CODES,
  EXISTING_BOOKING_LABEL,
  INTEREST_CODES,
  LODGING_REQUIREMENT_CODES,
  LODGING_TYPE_CODES,
  PACE_INTENSITY_LABEL,
  PACE_NEED_CODES,
  ROUTE_SHAPES,
  SENIOR_MOBILITY_LABEL,
  SENIOR_MOBILITY_VALUES,
  TRANSPORT_CODES,
  TRAVELER_TAG_CODES,
  budgetTotal,
  tripDays,
  travelerCount,
  type PaceIntensity,
  type PlannerAction,
  type PlannerState,
  type StepId,
} from '@/lib/planner-state';
import { TagLegend, TagTriState } from './TagTriState';
import { usePlannerOptions } from './PlannerConfigProvider';

/**
 * 八个 section（`.main-panel` 里的八张卡片）。
 *
 * 全部只读 props + 转发 dispatch，不持有状态 —— 完成度要在左栏与右栏同时用，
 * 状态下沉到 section 里就得靠 context 或重复计算。
 *
 * ## 三个 V1 不支持的控件保留但禁用
 *
 * 「目的地尚未确定」「接受多个目的地」「日期弹性」在 V1 会被 N-09/N-10 拒或
 * 契约里无落点。**保留控件 + 置灰 + V2 角标**，而不是删掉：原型的视觉完整性
 * 还在，且用户不会填了才被拒。删掉的方案会让「这个功能去哪了」变成一个
 * 没有答案的问题。
 */

type Dispatch = (action: PlannerAction) => void;

function metadataString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

interface SectionProps {
  readonly state: PlannerState;
  readonly dispatch: Dispatch;
  readonly registerRef: (step: StepId) => (node: HTMLElement | null) => void;
}

function SectionShell({
  id,
  step,
  title,
  description,
  registerRef,
  children,
}: {
  readonly id: StepId;
  readonly step: number;
  readonly title: string;
  readonly description: string;
  readonly registerRef: SectionProps['registerRef'];
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="planner-panel planner-card" id={`step-${id}`} ref={registerRef(id)}>
      <header className="planner-card__head">
        <div>
          <h2 className="planner-card__title">{title}</h2>
          <p className="planner-card__desc">{description}</p>
        </div>
        <span className="planner-card__badge">第 {step} 步</span>
      </header>
      {children}
    </section>
  );
}

/** V2 角标。三个不支持的控件共用 */
function V2Badge(): React.ReactElement {
  return (
    <span className="planner-v2" title="V1 暂不支持，V2 开放">
      V2
    </span>
  );
}

/** 一组三态标签 */
function TagRow({
  fieldKey,
  codes,
  state,
  dispatch,
  filter,
}: {
  readonly fieldKey: string;
  readonly codes: readonly ConditionCode[];
  readonly state: PlannerState;
  readonly dispatch: Dispatch;
  /** 兴趣搜索用：不匹配的隐藏而不是移除，避免布局跳动 */
  readonly filter?: (code: ConditionCode, label: string) => boolean;
}): React.ReactElement {
  const options = usePlannerOptions(
    fieldKey,
    codes.map((code) => ({ key: code, label: CONDITION_LABEL[code], metadata: {} })),
  );
  return (
    <div className="planner-tags">
      {options.map((option) => {
        const code = option.key as ConditionCode;
        return (
          <TagTriState
            key={code}
            code={code}
            label={option.label}
            stance={state.conditions[code]}
            hidden={filter === undefined ? false : !filter(code, option.label)}
            onCycle={(target) => dispatch({ type: 'cycleCondition', code: target })}
          />
        );
      })}
    </div>
  );
}

// ── 第 1 步 ─────────────────────────────────────────────────

export function BasicSection({ state, dispatch, registerRef }: SectionProps): React.ReactElement {
  const existingBookingOptions = usePlannerOptions(
    'booking.existing',
    EXISTING_BOOKING_VALUES.map((key) => ({
      key,
      label: EXISTING_BOOKING_LABEL[key],
      metadata: {},
    })),
  );
  return (
    <SectionShell
      id="basic"
      step={1}
      title="确定旅行的基本轮廓"
      description="出发地、目的地与日期。填完这三项就能生成方案。"
      registerRef={registerRef}
    >
      <div className="planner-grid">
        <div className="planner-field planner-field--full">
          <label className="planner-label" htmlFor="planner-origin">
            出发地与目的地
          </label>
          <div className="planner-route">
            <input
              id="planner-origin"
              className="planner-input"
              value={state.origin}
              maxLength={200}
              placeholder="出发地"
              onChange={(event) =>
                dispatch({ type: 'setText', field: 'origin', value: event.target.value })
              }
            />
            <span className="planner-route__arrow">→</span>
            <input
              className="planner-input"
              value={state.destination}
              maxLength={200}
              placeholder="目的地"
              disabled={state.destinationUndecided}
              onChange={(event) =>
                dispatch({ type: 'setText', field: 'destination', value: event.target.value })
              }
            />
          </div>

          <div className="planner-checks">
            <label className="planner-check">
              <input
                type="checkbox"
                checked={state.destinationUndecided}
                onChange={() => dispatch({ type: 'toggleDestinationUndecided' })}
              />
              目的地尚未确定
              <V2Badge />
            </label>
            <label className="planner-check planner-check--disabled">
              <input type="checkbox" disabled />
              接受多个目的地组合
              <V2Badge />
            </label>
          </div>
        </div>

        <div className="planner-field">
          <label className="planner-label" htmlFor="planner-start">
            出发日期
          </label>
          <input
            id="planner-start"
            type="date"
            className="planner-input"
            value={state.startDate}
            onChange={(event) =>
              dispatch({ type: 'setText', field: 'startDate', value: event.target.value })
            }
          />
        </div>

        <div className="planner-field">
          <label className="planner-label" htmlFor="planner-end">
            返回日期
          </label>
          <input
            id="planner-end"
            type="date"
            className="planner-input"
            value={state.endDate}
            onChange={(event) =>
              dispatch({ type: 'setText', field: 'endDate', value: event.target.value })
            }
          />
        </div>

        <div className="planner-field">
          <label className="planner-label" htmlFor="planner-flex">
            日期弹性 <V2Badge />
          </label>
          {/*
            V1 只接受 flexibility_days = 0（N-09）。锁成单一选项而不是删掉整个
            控件，否则「弹性日期」这个能力在界面上完全无迹可寻。
          */}
          <select id="planner-flex" className="planner-select" value="0" disabled>
            <option value="0">日期固定</option>
          </select>
        </div>

        <div className="planner-field planner-field--full">
          <span className="planner-label">已有订单</span>
          <div className="planner-checks">
            {existingBookingOptions.map((option) => {
              const value = option.key as ExistingBooking;
              return (
                <label key={value} className="planner-check">
                  <input
                    type="checkbox"
                    checked={state.existingBookings.includes(value)}
                    onChange={() => dispatch({ type: 'toggleExistingBooking', value })}
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
          <p className="planner-hint">
            已订酒店会让住宿位置固定、每日路线围绕它安排；已订往返交通会钉住首末日的时间窗。
          </p>
        </div>
      </div>
    </SectionShell>
  );
}

// ── 第 2 步 ─────────────────────────────────────────────────

const TRAVELER_ROWS = [
  { kind: 'adults', icon: '🧑', name: '成人', note: '18～64 岁' },
  { kind: 'children', icon: '🧒', name: '儿童', note: '0～17 岁' },
  { kind: 'seniors', icon: '🧓', name: '老年人', note: '可说明行动能力' },
] as const;

export function TravelersSection({
  state,
  dispatch,
  registerRef,
}: SectionProps): React.ReactElement {
  const seniorMobilityOptions = usePlannerOptions(
    'traveler.senior_mobility',
    SENIOR_MOBILITY_VALUES.map((key) => ({ key, label: SENIOR_MOBILITY_LABEL[key], metadata: {} })),
  );
  const counts = {
    adults: state.adults,
    children: state.childAges.length,
    seniors: state.seniorCount,
  } as const;
  const showDetails = state.childAges.length > 0 || state.seniorCount > 0;

  return (
    <SectionShell
      id="travelers"
      step={2}
      title="谁和你一起旅行？"
      description="人数与行动能力会影响预算和行程强度。"
      registerRef={registerRef}
    >
      <div className="planner-travelers">
        {TRAVELER_ROWS.map((row) => (
          <div key={row.kind} className="planner-traveler">
            <div className="planner-traveler__info">
              <div className="planner-traveler__icon">{row.icon}</div>
              <div>
                <strong>{row.name}</strong>
                <small>{row.note}</small>
              </div>
            </div>
            <div className="planner-counter">
              <button
                type="button"
                title={`减少${row.name}`}
                onClick={() => dispatch({ type: 'adjustTraveler', kind: row.kind, delta: -1 })}
              >
                −
              </button>
              <span>{counts[row.kind]}</span>
              <button
                type="button"
                title={`增加${row.name}`}
                onClick={() => dispatch({ type: 'adjustTraveler', kind: row.kind, delta: 1 })}
              >
                ＋
              </button>
            </div>
          </div>
        ))}
      </div>

      {showDetails ? (
        <div className="planner-subpanel">
          <div className="planner-grid">
            {state.childAges.length > 0 ? (
              <div className="planner-field">
                <label className="planner-label" htmlFor="planner-child-age">
                  儿童年龄
                </label>
                <input
                  id="planner-child-age"
                  type="number"
                  min={0}
                  max={17}
                  className="planner-input"
                  value={state.childAge}
                  onChange={(event) =>
                    dispatch({ type: 'setChildAge', value: Number(event.target.value) })
                  }
                />
              </div>
            ) : null}

            {state.seniorCount > 0 ? (
              <div className="planner-field">
                <label className="planner-label" htmlFor="planner-mobility">
                  长者行动能力
                </label>
                <select
                  id="planner-mobility"
                  className="planner-select"
                  value={state.seniorMobility}
                  onChange={(event) =>
                    dispatch({
                      type: 'setSeniorMobility',
                      value: event.target.value as (typeof SENIOR_MOBILITY_VALUES)[number],
                    })
                  }
                >
                  {seniorMobilityOptions.map((option) => {
                    const value = option.key as (typeof SENIOR_MOBILITY_VALUES)[number];
                    return (
                      <option key={value} value={value}>
                        {option.label}
                      </option>
                    );
                  })}
                </select>
                {/*
                  「需轮椅」「减少步行台阶」两档会落成 accessibility 硬约束码，
                  因此这里说明它的后果 —— 用户应当知道自己刚设下了一条硬约束。
                */}
                <p className="planner-hint">后两档会作为无障碍硬约束提交，生成时不可违反。</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="planner-subsection">
        <h3 className="planner-subsection__title">同行相关的偏好</h3>
        <TagLegend />
        <TagRow
          fieldKey="traveler.tags"
          codes={TRAVELER_TAG_CODES}
          state={state}
          dispatch={dispatch}
        />
      </div>
    </SectionShell>
  );
}

// ── 第 3 步 ─────────────────────────────────────────────────

export function BudgetSection({ state, dispatch, registerRef }: SectionProps): React.ReactElement {
  const tierOptions = usePlannerOptions('budget.tiers', [
    ...BUDGET_TIER_PRESETS.map((preset) => ({
      key: preset.tier,
      label: preset.name,
      metadata: {
        icon: preset.icon,
        description: preset.description,
        min: preset.min,
        max: preset.max,
      },
    })),
    {
      key: 'CUSTOM',
      label: '自定义预算',
      metadata: { icon: '⚙️', description: '适合有明确金额限制' },
    },
  ]);
  const includedItemOptions = usePlannerOptions(
    'budget.included_items',
    (Object.keys(BUDGET_ITEM_LABEL) as BudgetIncludedItem[]).map((key) => ({
      key,
      label: BUDGET_ITEM_LABEL[key],
      metadata: {},
    })),
  );
  const total = budgetTotal(state);
  const money = (value: number): string => `¥${value.toLocaleString('zh-CN')}`;
  const tierName =
    state.budgetTier === 'CUSTOM'
      ? '自定义预算'
      : (tierOptions.find((item) => item.key === state.budgetTier)?.label ?? '未选择档位');

  return (
    <SectionShell
      id="budget"
      step={3}
      title="旅行预算"
      description="选择档位后，可通过滑块或输入框自定义人均每日预算。"
      registerRef={registerRef}
    >
      <div className="planner-tiers">
        {tierOptions.map((option) => {
          const tier = option.key as BudgetTier;
          const min = Number(option.metadata['min'] ?? 0);
          const max = Number(option.metadata['max'] ?? 0);
          const custom = tier === 'CUSTOM';
          return (
            <button
              key={tier}
              type="button"
              className={`planner-tier${custom ? ' planner-tier--custom' : ''}${state.budgetTier === tier ? ' is-active' : ''}`}
              onClick={() => dispatch({ type: 'selectBudgetTier', tier })}
            >
              <span className="planner-tier__icon">
                {metadataString(option.metadata['icon'], '✦')}
              </span>
              <span className="planner-tier__name">{option.label}</span>
              <span className="planner-tier__price">
                {custom
                  ? '自由设置'
                  : `¥${min.toLocaleString('zh-CN')}～${max.toLocaleString('zh-CN')}`}
              </span>
              <span className="planner-tier__unit">{custom ? '最低与最高' : '人均／天'}</span>
              <span className="planner-tier__desc">
                {metadataString(option.metadata['description'], '')}
              </span>
            </button>
          );
        })}
      </div>

      <div className="planner-budget-summary">
        <div>
          <span className="planner-budget-summary__label">当前预算范围</span>
          <strong className="planner-budget-summary__value">
            {money(state.budgetMin)}～{money(state.budgetMax)}
          </strong>
          <span className="planner-budget-summary__badge">{tierName}</span>
        </div>
        <div className="planner-budget-total">
          <div>
            <span>出行人数</span>
            <strong>{travelerCount(state)} 人</strong>
          </div>
          <div>
            <span>旅行天数</span>
            <strong>{tripDays(state)} 天</strong>
          </div>
          <div>
            <span>预计总预算</span>
            <strong>
              {money(total.min)}～{money(total.max)}
            </strong>
          </div>
        </div>
      </div>

      <div className="planner-budget-custom">
        <div className="planner-grid">
          <div className="planner-field">
            <label className="planner-label" htmlFor="planner-budget-min">
              最低预算 <span className="planner-label__opt">人均／天</span>
            </label>
            <input
              id="planner-budget-min"
              type="number"
              className="planner-input"
              min={BUDGET_DAILY_FLOOR}
              step={100}
              value={state.budgetMin}
              onChange={(event) =>
                dispatch({ type: 'setBudgetDaily', side: 'min', value: Number(event.target.value) })
              }
            />
            <input
              type="range"
              className="planner-range"
              min={BUDGET_DAILY_FLOOR}
              max={BUDGET_DAILY_CEILING}
              step={100}
              value={Math.min(state.budgetMin, BUDGET_DAILY_CEILING)}
              aria-label="最低预算"
              onChange={(event) =>
                dispatch({ type: 'setBudgetDaily', side: 'min', value: Number(event.target.value) })
              }
            />
          </div>

          <div className="planner-field">
            <label className="planner-label" htmlFor="planner-budget-max">
              最高预算 <span className="planner-label__opt">人均／天</span>
            </label>
            <input
              id="planner-budget-max"
              type="number"
              className="planner-input"
              min={BUDGET_DAILY_FLOOR}
              step={100}
              value={state.budgetMax}
              onChange={(event) =>
                dispatch({ type: 'setBudgetDaily', side: 'max', value: Number(event.target.value) })
              }
            />
            <input
              type="range"
              className="planner-range"
              min={BUDGET_DAILY_FLOOR}
              max={BUDGET_DAILY_CEILING}
              step={100}
              value={Math.min(state.budgetMax, BUDGET_DAILY_CEILING)}
              aria-label="最高预算"
              onChange={(event) =>
                dispatch({ type: 'setBudgetDaily', side: 'max', value: Number(event.target.value) })
              }
            />
          </div>
        </div>
        <p className="planner-hint">总预算 = 人均每日预算 × 出行人数 × 旅行天数。</p>
      </div>

      <div className="planner-subsection">
        <h3 className="planner-subsection__title">预算包含哪些项目？</h3>
        <div className="planner-checks">
          {includedItemOptions.map((option) => {
            const item = option.key as BudgetIncludedItem;
            return (
              <label key={item} className="planner-check">
                <input
                  type="checkbox"
                  checked={state.includedItems.includes(item)}
                  onChange={() => dispatch({ type: 'toggleIncludedItem', item })}
                />
                {option.label}
              </label>
            );
          })}
        </div>
        <p className="planner-hint">至少保留一项 —— 全不选会让预算区间失去含义。</p>
      </div>

      <div className="planner-subsection">
        <h3 className="planner-subsection__title">愿意重点花钱的项目</h3>
        <TagLegend />
        {/*
          原来这里额外塞了 `interest.shopping`。它按域属于 interest，于是在**这一步**
          点「购物」会给第 6 步记分。购物预算在上面的「预算包含哪些项目」里已经
          有复选框，兴趣标签留在第 6 步。
        */}
        <TagRow
          fieldKey="budget.focus_tags"
          codes={BUDGET_FOCUS_CODES}
          state={state}
          dispatch={dispatch}
        />
      </div>
    </SectionShell>
  );
}

// ── 第 4 步 ─────────────────────────────────────────────────

const WALKING_OPTIONS = [2, 3, 5, 8] as const;
const ATTRACTION_OPTIONS = ['1', '2~3', '4~5', '尽可能多'] as const;

export function PaceSection({ state, dispatch, registerRef }: SectionProps): React.ReactElement {
  const intensityOptions = usePlannerOptions(
    'pace.intensity',
    ([1, 2, 3, 4, 5] as const).map((key) => ({
      key: String(key),
      label: PACE_INTENSITY_LABEL[key],
      metadata: {},
    })),
  );
  const attractionOptions = usePlannerOptions(
    'pace.attractions_per_day',
    ATTRACTION_OPTIONS.map((key) => ({
      key,
      label: key === '尽可能多' ? key : `${key} 个`,
      metadata: {},
    })),
  );
  const walkingOptions = usePlannerOptions(
    'pace.walking_limit_km',
    WALKING_OPTIONS.map((key) => ({ key: String(key), label: `${key} 公里以内`, metadata: {} })),
  );
  const routeOptions = usePlannerOptions(
    'pace.route_shape',
    ROUTE_SHAPES.map((shape) => ({
      key: shape.id,
      label: shape.name,
      metadata: { glyph: shape.glyph },
    })),
  );
  const currentIntensity =
    intensityOptions.find((option) => option.key === String(state.paceIntensity))?.label ??
    PACE_INTENSITY_LABEL[state.paceIntensity];
  return (
    <SectionShell
      id="pace"
      step={4}
      title="旅行节奏与路线结构"
      description="设置每日活动强度、步行距离和路线方式。"
      registerRef={registerRef}
    >
      <div className="planner-pace">
        <div className="planner-pace__head">
          <span>轻松躺平</span>
          <strong>{currentIntensity}</strong>
          <span>紧凑打卡</span>
        </div>
        <input
          type="range"
          className="planner-range"
          min={1}
          max={5}
          step={1}
          value={state.paceIntensity}
          aria-label="旅行节奏"
          onChange={(event) =>
            dispatch({
              type: 'setPaceIntensity',
              value: Number(event.target.value) as PaceIntensity,
            })
          }
        />
        <div className="planner-pace__scale">
          {intensityOptions.map((option) => (
            <span key={option.key}>{option.label}</span>
          ))}
        </div>
      </div>

      <div className="planner-grid planner-grid--three planner-subsection">
        <div className="planner-field">
          <label className="planner-label" htmlFor="planner-attractions">
            每天核心景点
          </label>
          <select
            id="planner-attractions"
            className="planner-select"
            value={state.attractionsPerDay}
            onChange={(event) =>
              dispatch({ type: 'setText', field: 'attractionsPerDay', value: event.target.value })
            }
          >
            {attractionOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="planner-field">
          <label className="planner-label" htmlFor="planner-walking">
            每天可接受步行
          </label>
          <select
            id="planner-walking"
            className="planner-select"
            value={String(state.walkingLimitKm)}
            onChange={(event) =>
              dispatch({ type: 'setWalkingLimit', value: Number(event.target.value) })
            }
          >
            {walkingOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="planner-field">
          <label className="planner-label" htmlFor="planner-departure">
            最早出门时间
          </label>
          <input
            id="planner-departure"
            type="time"
            className="planner-input"
            value={state.earliestDeparture}
            onChange={(event) =>
              dispatch({ type: 'setText', field: 'earliestDeparture', value: event.target.value })
            }
          />
        </div>
      </div>

      <div className="planner-subsection">
        <h3 className="planner-subsection__title">路线结构</h3>
        <div className="planner-routes">
          {routeOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`planner-route-card${state.routeShape === option.key ? ' is-active' : ''}`}
              onClick={() => dispatch({ type: 'setRouteShape', value: option.key })}
            >
              <span className="planner-route-card__glyph">
                {metadataString(option.metadata['glyph'], '•')}
              </span>
              {option.label}
            </button>
          ))}
        </div>
        {/*
          路线结构在契约里没有字段（八种互斥，schema 层表达不了），
          因此它作为自由文本补充提交。把这件事告诉用户 —— 否则「我选了跳岛
          但行程还是中心辐射」会被当成 bug。
        */}
        <p className="planner-hint">路线结构作为文字说明提交，模型会参考但不作为硬约束。</p>
      </div>

      <div className="planner-subsection">
        <div className="planner-subsection__head">
          <strong>无障碍与作息</strong>
          <span>可多选，连续点击切换要求等级</span>
        </div>
        <TagLegend />
        <TagRow
          fieldKey="pace.need_tags"
          codes={PACE_NEED_CODES}
          state={state}
          dispatch={dispatch}
        />
      </div>
    </SectionShell>
  );
}

// ── 第 5 步 ─────────────────────────────────────────────────

export function TransportSection({
  state,
  dispatch,
  registerRef,
}: SectionProps): React.ReactElement {
  return (
    <SectionShell
      id="transport"
      step={5}
      title="交通与住宿偏好"
      description="同一个标签可以设置为偏好、必须或不要 —— 连点即可切换。"
      registerRef={registerRef}
    >
      <TagLegend />

      <div className="planner-subsection">
        <div className="planner-subsection__head">
          <strong>交通方式</strong>
          <span>可多选</span>
        </div>
        <TagRow
          fieldKey="transport.mode_tags"
          codes={TRANSPORT_CODES}
          state={state}
          dispatch={dispatch}
        />
      </div>

      <div className="planner-subsection">
        <div className="planner-subsection__head">
          <strong>住宿类型</strong>
          <span>可多选</span>
        </div>
        <TagRow
          fieldKey="transport.lodging_type_tags"
          codes={LODGING_TYPE_CODES}
          state={state}
          dispatch={dispatch}
        />
      </div>

      <div className="planner-subsection">
        <div className="planner-subsection__head">
          <strong>住宿具体要求</strong>
          <span>可多选</span>
        </div>
        <TagRow
          fieldKey="transport.lodging_requirement_tags"
          codes={LODGING_REQUIREMENT_CODES}
          state={state}
          dispatch={dispatch}
        />
        <p className="planner-hint">
          「合住多人间」设为「不要」即表示需要独立房间 —— 三态里的红色就是明确排除。
        </p>
      </div>
    </SectionShell>
  );
}

// ── 第 6 步 ─────────────────────────────────────────────────

export function DietSection({ state, dispatch, registerRef }: SectionProps): React.ReactElement {
  return (
    <SectionShell
      id="diet"
      step={6}
      title="饮食偏好与禁忌"
      description="告诉我们偏好的饮食方式，以及必须满足或明确避开的餐饮条件。"
      registerRef={registerRef}
    >
      <TagLegend />
      <div className="planner-subsection">
        <div className="planner-subsection__head">
          <strong>饮食要求</strong>
          <span>可多选</span>
        </div>
        <TagRow fieldKey="diet.tags" codes={DIET_TAG_CODES} state={state} dispatch={dispatch} />
        <p className="planner-hint">
          过敏、清真等刚性要求请点到绿色“必须”；明确不接受的选项请点到红色“不要”。
        </p>
      </div>
    </SectionShell>
  );
}

// ── 第 7 步 ─────────────────────────────────────────────────

export function InterestsSection({
  state,
  dispatch,
  registerRef,
}: SectionProps): React.ReactElement {
  const query = state.interestQuery.trim().toLowerCase();

  return (
    <SectionShell
      id="interests"
      step={7}
      title="兴趣主题与活动"
      description="建议选择 2～4 项核心兴趣。"
      registerRef={registerRef}
    >
      <input
        className="planner-input"
        value={state.interestQuery}
        placeholder="搜索兴趣，例如：博物馆、咖啡、温泉"
        onChange={(event) =>
          dispatch({ type: 'setText', field: 'interestQuery', value: event.target.value })
        }
      />

      <div className="planner-subsection">
        <TagLegend />
        <TagRow
          fieldKey="interest.tags"
          codes={INTEREST_CODES}
          state={state}
          dispatch={dispatch}
          filter={(_code, label) => query.length === 0 || label.toLowerCase().includes(query)}
        />
      </div>
    </SectionShell>
  );
}

// ── 第 8 步 ─────────────────────────────────────────────────

/** 5.1：500 字后截断并记入 assumptions。界面上先提示，别等到结果里才说 */
const CUSTOM_TEXT_SOFT_LIMIT = 500;

export function CustomSection({ state, dispatch, registerRef }: SectionProps): React.ReactElement {
  const length = state.customText.trim().length;
  const over = length > CUSTOM_TEXT_SOFT_LIMIT;

  return (
    <SectionShell
      id="custom"
      step={8}
      title="补充特殊需求"
      description="健康状况、必去或必须避开的地点，以及其他未覆盖的要求都可以写在这里。"
      registerRef={registerRef}
    >
      <textarea
        className="planner-textarea"
        value={state.customText}
        rows={5}
        maxLength={5_000}
        placeholder="例如：希望安排纪念日惊喜，必须去某个展览，避开红眼航班。"
        onChange={(event) =>
          dispatch({ type: 'setText', field: 'customText', value: event.target.value })
        }
      />

      <div className="planner-custom__foot">
        <span className={over ? 'planner-count planner-count--over' : 'planner-count'}>
          {length} / {CUSTOM_TEXT_SOFT_LIMIT} 字{over ? '（超出部分会被截断，并在结果里告知）' : ''}
        </span>
        <label className="planner-check">
          <input
            type="checkbox"
            checked={state.noSpecialRequirements}
            onChange={() => dispatch({ type: 'toggleNoSpecialRequirements' })}
          />
          我没有其他特殊需求
        </label>
      </div>

      {/*
        原型这里有一个「✨ 解析为旅行条件」按钮，实现是 7 条关键词 if。
        真实系统里这段文字由模型读，前端伪造出的条件标签不在 46 码字典内，
        发出去会被 REQ_CONDITION_CODE_UNKNOWN 拒。因此换成一句说明。
      */}
      <p className="planner-hint">
        这段文字会原样交给模型阅读。若其中的诉求在上面的标签里有对应项， 建议一并勾选 ——
        标签是结构化条件，会被逐条校验；文字只作为参考。
      </p>
    </SectionShell>
  );
}
