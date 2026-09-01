'use client';

import type { BudgetMode, Currency, TravelTier } from '@tps/schemas';

import { readAnswer, type PlannerAction, type PlannerState } from '@/lib/planner/state';

const TIERS = [
  {
    value: 'ECONOMY',
    name: '经济穷游',
    price: [300, 800],
    icon: '🎒',
    desc: '青旅、经济住宿、公共交通',
  },
  {
    value: 'COMFORT',
    name: '舒适标准',
    price: [800, 1_500],
    icon: '✈️',
    desc: '住宿、交通与体验均衡',
  },
  {
    value: 'QUALITY',
    name: '品质度假',
    price: [1_500, 3_000],
    icon: '🏨',
    desc: '高品质酒店和特色体验',
  },
  {
    value: 'LUXURY',
    name: '豪华旅行',
    price: [3_000, 6_000],
    icon: '💎',
    desc: '豪华酒店、专车和私人体验',
  },
] as const satisfies readonly {
  readonly value: TravelTier;
  readonly name: string;
  readonly price: readonly [number, number];
  readonly icon: string;
  readonly desc: string;
}[];

const CURRENCIES = [
  'CNY',
  'JPY',
  'USD',
  'EUR',
  'GBP',
  'HKD',
] as const satisfies readonly Currency[];
const CURRENCY_LABEL: Record<Currency, string> = {
  CNY: 'CNY ¥',
  JPY: 'JPY ¥',
  USD: 'USD $',
  EUR: 'EUR €',
  GBP: 'GBP £',
  HKD: 'HKD $',
};

export function BudgetControl({
  state,
  dispatch,
}: {
  readonly state: PlannerState;
  readonly dispatch: (action: PlannerAction) => void;
}): React.ReactElement {
  const mode = readAnswer(state.answers, 'budget.mode');
  const tier = readAnswer(state.answers, 'budget.travel_tier');
  const currencyValue = readAnswer(state.answers, 'budget.currency');
  const currency = CURRENCIES.includes(currencyValue as Currency)
    ? (currencyValue as Currency)
    : 'CNY';
  const rangeValue = readAnswer(state.answers, 'budget.target_range');
  const rangeRecord =
    typeof rangeValue === 'object' && rangeValue !== null
      ? (rangeValue as Record<string, unknown>)
      : {};
  const customMin = typeof rangeRecord['min'] === 'number' ? rangeRecord['min'] : 8_000;
  const customMax = typeof rangeRecord['max'] === 'number' ? rangeRecord['max'] : 15_000;
  const custom = mode === 'TOTAL' || mode === 'PER_PERSON';
  const selectedTier = TIERS.find((item) => item.value === tier);
  const displayRange =
    mode === 'TIER' && selectedTier !== undefined
      ? selectedTier.price
      : ([customMin, customMax] as const);
  const peopleValue = readAnswer(state.answers, 'travelers.count');
  const people = typeof peopleValue === 'number' ? peopleValue : 0;
  const days = tripDays(readAnswer(state.answers, 'trip.dates'));
  const totalRange = estimateTotal(mode as BudgetMode | undefined, displayRange, people, days);
  const hardCapValue = readAnswer(state.answers, 'budget.hard_cap');
  const hardCap =
    typeof hardCapValue === 'object' && hardCapValue !== null
      ? (hardCapValue as Record<string, unknown>)
      : {};
  const hardCapOn = hardCap['enabled'] === true;
  const hardCapAmount = typeof hardCap['amount'] === 'number' ? hardCap['amount'] : customMax;

  const answer = (
    fieldId: 'PV2-03-001' | 'PV2-03-002' | 'PV2-03-003' | 'PV2-03-004' | 'PV2-03-005',
    budget: Record<string, unknown>,
  ): void => {
    dispatch({ type: 'answer', fieldId, patch: { budget } });
  };

  const selectTier = (next: TravelTier): void => {
    answer('PV2-03-001', { mode: 'TIER' });
    answer('PV2-03-002', { currency });
    answer('PV2-03-004', { travel_tier: next });
  };

  const selectCustom = (nextMode: 'TOTAL' | 'PER_PERSON' = 'TOTAL'): void => {
    answer('PV2-03-001', { mode: nextMode });
    answer('PV2-03-002', { currency });
    answer('PV2-03-003', { target_range: { min: customMin, max: customMax } });
  };

  const setRange = (min: number, max: number): void => {
    answer('PV2-03-003', { target_range: { min: Math.min(min, max), max: Math.max(min, max) } });
  };

  return (
    <div className="planner-budget-experience">
      <div className="planner-tiers" role="group" aria-label="选择旅行预算档位">
        {TIERS.map((item) => {
          const active = mode === 'TIER' && tier === item.value;
          return (
            <button
              type="button"
              className={`planner-tier${active ? ' planner-tier--active' : ''}`}
              aria-pressed={active}
              onClick={() => selectTier(item.value)}
              key={item.value}
            >
              <span className="planner-tier__icon" aria-hidden="true">
                {item.icon}
              </span>
              <strong className="planner-tier__name">{item.name}</strong>
              <span className="planner-tier__price">
                ¥{formatNumber(item.price[0])}～{formatNumber(item.price[1])}
              </span>
              <span className="planner-tier__unit">人均 / 天</span>
              <span className="planner-tier__desc">{item.desc}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`planner-tier planner-tier--custom${custom ? ' planner-tier--active' : ''}`}
          aria-pressed={custom}
          onClick={() => selectCustom()}
        >
          <span className="planner-tier__icon" aria-hidden="true">
            ⚙️
          </span>
          <strong className="planner-tier__name">自定义预算</strong>
          <span className="planner-tier__price">自由设置</span>
          <span className="planner-tier__unit">总额或人均</span>
          <span className="planner-tier__desc">适合已有明确金额范围</span>
        </button>
      </div>

      <div className="planner-budget-summary" aria-live="polite">
        <div className="planner-budget-summary__range">
          <span>当前预算范围</span>
          <strong>
            {formatMoney(displayRange[0], currency)}～{formatMoney(displayRange[1], currency)}
          </strong>
          <small>
            {custom
              ? mode === 'PER_PERSON'
                ? '人均总预算'
                : '整个旅行总预算'
              : (selectedTier?.name ?? '尚未选择档位')}
          </small>
        </div>
        <div className="planner-budget-total">
          <div>
            <span>出行人数</span>
            <strong>{people === 0 ? '待填写' : `${people} 人`}</strong>
          </div>
          <div>
            <span>旅行天数</span>
            <strong>{days === null ? '待填写' : `${days} 天`}</strong>
          </div>
          <div>
            <span>预计总预算</span>
            <strong>
              {totalRange === null
                ? '补全人数和日期后估算'
                : `${formatMoney(totalRange[0], currency)}～${formatMoney(totalRange[1], currency)}`}
            </strong>
          </div>
        </div>
      </div>

      {custom ? (
        <div className="planner-budget-custom">
          <div className="planner-budget-toolbar">
            <div className="planner-segmented" role="group" aria-label="预算口径">
              <button
                type="button"
                aria-pressed={mode === 'TOTAL'}
                className={mode === 'TOTAL' ? 'is-active' : ''}
                onClick={() => selectCustom('TOTAL')}
              >
                旅行总额
              </button>
              <button
                type="button"
                aria-pressed={mode === 'PER_PERSON'}
                className={mode === 'PER_PERSON' ? 'is-active' : ''}
                onClick={() => selectCustom('PER_PERSON')}
              >
                人均总额
              </button>
            </div>
            <div className="planner-currency" role="group" aria-label="预算币种">
              {CURRENCIES.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={currency === item}
                  className={currency === item ? 'is-active' : ''}
                  onClick={() => answer('PV2-03-002', { currency: item })}
                >
                  {CURRENCY_LABEL[item]}
                </button>
              ))}
            </div>
          </div>

          <div className="planner-budget-sliders">
            <label>
              <span>
                最低预算 <output>{formatMoney(customMin, currency)}</output>
              </span>
              <input
                type="range"
                min="500"
                max="100000"
                step="500"
                value={customMin}
                onChange={(event) => setRange(Number(event.target.value), customMax)}
              />
            </label>
            <label>
              <span>
                最高预算 <output>{formatMoney(customMax, currency)}</output>
              </span>
              <input
                type="range"
                min="500"
                max="100000"
                step="500"
                value={customMax}
                onChange={(event) => setRange(customMin, Number(event.target.value))}
              />
            </label>
          </div>

          <div className="planner-budget-cap">
            <button
              type="button"
              className={`planner-choice planner-choice--check${hardCapOn ? ' planner-choice--on' : ''}`}
              aria-pressed={hardCapOn}
              onClick={() =>
                answer('PV2-03-005', {
                  hard_cap: { ...hardCap, enabled: !hardCapOn, amount: hardCapAmount },
                })
              }
            >
              设为绝对不能超过的金额
            </button>
            {hardCapOn ? (
              <label>
                <span>
                  硬上限 <output>{formatMoney(hardCapAmount, currency)}</output>
                </span>
                <input
                  type="range"
                  min="500"
                  max="150000"
                  step="500"
                  value={hardCapAmount}
                  onChange={(event) =>
                    answer('PV2-03-005', {
                      hard_cap: { enabled: true, amount: Number(event.target.value) },
                    })
                  }
                />
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="planner-budget-unknown"
        aria-pressed={mode === 'UNKNOWN'}
        onClick={() => answer('PV2-03-001', { mode: 'UNKNOWN' })}
      >
        现在还没概念，让系统按目的地和行程估算
      </button>
    </div>
  );
}

function tripDays(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const dates = value as Record<string, unknown>;
  if (typeof dates['start_date'] !== 'string' || typeof dates['end_date'] !== 'string') return null;
  const diff =
    Date.parse(`${dates['end_date']}T00:00:00`) - Date.parse(`${dates['start_date']}T00:00:00`);
  return Number.isNaN(diff) || diff < 0 ? null : Math.floor(diff / 86_400_000) + 1;
}

function estimateTotal(
  mode: BudgetMode | undefined,
  range: readonly number[],
  people: number,
  days: number | null,
): readonly [number, number] | null {
  if (mode === 'TOTAL') return [range[0] ?? 0, range[1] ?? 0];
  if (people === 0) return null;
  if (mode === 'PER_PERSON') return [(range[0] ?? 0) * people, (range[1] ?? 0) * people];
  if (mode === 'TIER' && days !== null)
    return [(range[0] ?? 0) * people * days, (range[1] ?? 0) * people * days];
  return null;
}

function formatMoney(value: number, currency: Currency): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}
