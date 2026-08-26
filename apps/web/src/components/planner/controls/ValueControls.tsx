'use client';

import { asStringList } from '@/lib/planner/field-io';

import type { ControlProps } from './control-props';

/**
 * 数值、金额、时间、日期与文本控件。
 *
 * ## 空值一律是 `undefined` 而不是 0 或空串
 *
 * 「没填预算」与「预算是 0」在生成时是两件完全不同的事，而 `<input type=number>`
 * 的空值是空串。每个控件都在这里把空串折成 `undefined` —— 少折一处的表现是
 * 契约收到 `min: 0`，而 N-12 会算出「每人每天 0 元」并拒掉整个请求。
 *
 * ## 区间型控件写的是整个对象
 *
 * `{min,max}` / `{start,end}` / `{start_date,end_date}` 里只填了一边时**不发**
 * 半个对象：契约里这三个 schema 的两个键都必填，半个对象会在提交时被
 * `REQ_SCHEMA_INVALID` 拒 —— 而那个错误码定位不到任何表单项。因此填一边时
 * 另一边用空串占位存在本地 state 里，两边都齐了才写进答案树。
 */

// ── 数值 ────────────────────────────────────────────────────

/** 计数器。上下限来自描述符，越界时按钮不可用而不是让值越界 */
export function Counter({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const min = part.min ?? 0;
  const max = part.max ?? 99;
  const current = typeof value === 'number' ? value : min;
  const set = (next: number): void => onChange(Math.min(max, Math.max(min, next)));

  return (
    <div
      className="planner-counter"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      <button
        type="button"
        className="planner-icon-button"
        aria-label="减少"
        disabled={current <= min}
        onClick={() => set(current - 1)}
      >
        −
      </button>
      {/*
       * 数字用 `output` 而不是可编辑 input：计数器的上下限很窄（人数 1–20），
       * 而可编辑输入框会引出「用户打了 200」这条要额外校验的路径。
       * `aria-live` 让屏读用户听到变化 —— 否则按了加号没有任何反馈。
       */}
      <output className="planner-counter__value" aria-live="polite">
        {current}
      </output>
      <button
        type="button"
        className="planner-icon-button"
        aria-label="增加"
        disabled={current >= max}
        onClick={() => set(current + 1)}
      >
        ＋
      </button>
    </div>
  );
}

/** 自由数值（主驾年龄、具体年龄）。留空是合法的 —— 这两处都是可选补充 */
export function NumberInput({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  return (
    <input
      className="planner-input planner-input--number"
      type="number"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      {...(part.min === undefined ? {} : { min: part.min })}
      {...(part.max === undefined ? {} : { max: part.max })}
      value={typeof value === 'number' ? String(value) : ''}
      onChange={(event) => {
        const text = event.target.value;
        onChange(text === '' ? undefined : Number(text));
      }}
    />
  );
}

/**
 * 5 级节奏滑块（PV2-04-001）。
 *
 * 两端各有一句文案而不只有数字：「3」对用户没有含义，而规范 10 要求
 * 「不要求普通用户理解规划术语」。当前档位同时以文字显示（规范 20）。
 */
const PACE_LABEL: readonly string[] = ['', '躺平度假', '轻松', '适中', '紧凑', '尽量多看'];

export function RangeSlider({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const min = part.min ?? 1;
  const max = part.max ?? 5;
  /* 默认 3（字段表：「1~5；默认3」）。显示默认值但不写入答案 —— 未写入才算未回答 */
  const current = typeof value === 'number' ? value : Math.round((min + max) / 2);

  return (
    <div className="planner-slider">
      <input
        className="planner-slider__input"
        type="range"
        id={id}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        min={min}
        max={max}
        step={1}
        value={current}
        aria-valuetext={`${current} 级，${PACE_LABEL[current] ?? ''}`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="planner-slider__scale" aria-hidden="true">
        <span>{PACE_LABEL[min] ?? min}</span>
        <span>{PACE_LABEL[max] ?? max}</span>
      </div>
      <output className="planner-slider__value" aria-live="polite">
        {current} 级 · {PACE_LABEL[current] ?? ''}
      </output>
    </div>
  );
}

// ── 金额 ────────────────────────────────────────────────────

export function MoneyInput({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  return (
    <input
      className="planner-input planner-input--number"
      type="number"
      inputMode="numeric"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      min={part.min ?? 0}
      placeholder={part.placeholder ?? '金额'}
      value={typeof value === 'number' ? String(value) : ''}
      onChange={(event) => {
        const text = event.target.value;
        onChange(text === '' ? undefined : Number(text));
      }}
    />
  );
}

/**
 * 金额区间。
 *
 * 只填一边时不写答案（见文件头）。`min > max` **不在这里拦** —— 那条校验在
 * `validation.ts` 里，因为它要在字段下方给出一句话，而控件层拦住会让用户
 * 打字打到一半就被回退。
 */
export function MoneyRange({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const min = record['min'];
  const max = record['max'];

  const write = (nextMin: unknown, nextMax: unknown): void => {
    if (typeof nextMin === 'number' && typeof nextMax === 'number') {
      onChange({ min: nextMin, max: nextMax });
      return;
    }
    /*
     * 一边空着时把另一边也一起清掉，而不是留一个半成品对象。
     * 半成品对象会通过 `hasValue`（对象里有叶子有值）而被算成「已回答」，
     * 于是完整度虚高，且提交时被 schema 拒。
     */
    onChange(undefined);
  };

  return (
    <div
      className="planner-range"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      <input
        className="planner-input planner-input--number"
        type="number"
        inputMode="numeric"
        min={part.min ?? 0}
        aria-label="最低"
        placeholder="最低"
        value={typeof min === 'number' ? String(min) : ''}
        onChange={(event) =>
          write(event.target.value === '' ? undefined : Number(event.target.value), max)
        }
      />
      <span className="planner-range__sep" aria-hidden="true">
        ～
      </span>
      <input
        className="planner-input planner-input--number"
        type="number"
        inputMode="numeric"
        min={part.min ?? 0}
        aria-label="最高"
        placeholder="最高"
        value={typeof max === 'number' ? String(max) : ''}
        onChange={(event) =>
          write(min, event.target.value === '' ? undefined : Number(event.target.value))
        }
      />
    </div>
  );
}

// ── 时间与日期 ──────────────────────────────────────────────

export function TimeInput({ value, onChange, id, describedBy }: ControlProps): React.ReactElement {
  return (
    <input
      className="planner-input planner-input--time"
      type="time"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    />
  );
}

/** 双时间选择器。跨午夜是**合法**的（规范 10 允许夜生活跨午夜），只提示不拦 */
export function DualTime({ value, onChange, id, describedBy }: ControlProps): React.ReactElement {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const start = typeof record['start'] === 'string' ? record['start'] : '';
  const end = typeof record['end'] === 'string' ? record['end'] : '';

  const write = (nextStart: string, nextEnd: string): void => {
    if (nextStart === '' || nextEnd === '') {
      onChange(undefined);
      return;
    }
    onChange({ start: nextStart, end: nextEnd });
  };

  const crossesMidnight = start !== '' && end !== '' && end <= start;

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      <div className="planner-range">
        <input
          className="planner-input planner-input--time"
          type="time"
          aria-label="开始时间"
          value={start}
          onChange={(event) => write(event.target.value, end)}
        />
        <span className="planner-range__sep" aria-hidden="true">
          –
        </span>
        <input
          className="planner-input planner-input--time"
          type="time"
          aria-label="结束时间"
          value={end}
          onChange={(event) => write(start, event.target.value)}
        />
      </div>
      {crossesMidnight ? (
        <p className="planner-hint">这段时间跨过午夜，我们会按夜间活动安排。</p>
      ) : null}
    </div>
  );
}

export function DateInput({ value, onChange, id, describedBy }: ControlProps): React.ReactElement {
  return (
    <input
      className="planner-input planner-input--date"
      type="date"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    />
  );
}

/** 日期区间。键名是 `start_date` / `end_date`（契约的 `trip.dates`） */
export function DateRange({ value, onChange, id, describedBy }: ControlProps): React.ReactElement {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const start = typeof record['start_date'] === 'string' ? record['start_date'] : '';
  const end = typeof record['end_date'] === 'string' ? record['end_date'] : '';

  const write = (nextStart: string, nextEnd: string): void => {
    if (nextStart === '' || nextEnd === '') {
      onChange(undefined);
      return;
    }
    onChange({ start_date: nextStart, end_date: nextEnd });
  };

  return (
    <div
      className="planner-range"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      <input
        className="planner-input planner-input--date"
        type="date"
        aria-label="出发日期"
        value={start}
        onChange={(event) => write(event.target.value, end)}
      />
      <span className="planner-range__sep" aria-hidden="true">
        至
      </span>
      <input
        className="planner-input planner-input--date"
        type="date"
        aria-label="返回日期"
        value={end}
        onChange={(event) => write(start, event.target.value)}
      />
    </div>
  );
}

// ── 文本 ────────────────────────────────────────────────────

export function TextInput({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  return (
    <input
      className="planner-input"
      type="text"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      {...(part.placeholder === undefined ? {} : { placeholder: part.placeholder })}
      maxLength={part.max ?? 200}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    />
  );
}

/** 自由文本。字数**超了不拦**（字段表写的是「建议 500 字」），只在下方计数 */
export function TextArea({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const text = typeof value === 'string' ? value : '';
  const limit = part.max ?? 500;
  return (
    <>
      <textarea
        className="planner-textarea"
        id={id}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        {...(part.placeholder === undefined ? {} : { placeholder: part.placeholder })}
        rows={4}
        value={text}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
      <div
        className={`planner-char-count${text.length > limit ? ' planner-char-count--over' : ''}`}
      >
        {text.length} / {limit}
      </div>
    </>
  );
}

/**
 * 字符串列表（品牌、想去、不要、购物品类）。
 *
 * 每一行一个输入框加一个删除按钮，末尾一个「添加」。不用「逗号分隔的一个
 * 输入框」：那种写法会把「京都 · 岚山」这种本身含分隔符的条目切成两半，
 * 而用户看不出发生了什么。
 */
export function TextList({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const items = asStringList(value);
  const max = part.max ?? 20;

  const write = (next: readonly string[]): void => {
    const cleaned = next.filter((entry) => entry.trim().length > 0);
    onChange(cleaned.length === 0 ? undefined : cleaned);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      {items.map((item, index) => (
        /* key 用下标：列表项本身是可编辑文本，用值做 key 会让重复输入的两行互相抢占输入焦点 */
        <div className="planner-list-row" key={index}>
          <input
            className="planner-input"
            type="text"
            aria-label={`第 ${index + 1} 项`}
            {...(part.placeholder === undefined ? {} : { placeholder: part.placeholder })}
            maxLength={200}
            value={item}
            onChange={(event) => {
              const next = [...items];
              next[index] = event.target.value;
              /* 不过滤空串：正在清空一行的过程中过滤会让输入框当场消失 */
              onChange(next.length === 0 ? undefined : next);
            }}
          />
          <button
            type="button"
            className="planner-icon-button"
            aria-label={`删除第 ${index + 1} 项`}
            onClick={() => write(items.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}
      {items.length >= max ? null : (
        <button
          type="button"
          className="planner-button planner-button--light"
          onClick={() => onChange([...items, ''])}
        >
          ＋ 添加一项
        </button>
      )}
    </div>
  );
}

/**
 * 开关 / 勾选框。
 *
 * 授权类字段（PV2-09-005/006）也走这个控件，但**不预勾选**（规范 15、
 * 字段表「默认建议不预勾选」）：未写入答案就是未同意，而 `undefined`
 * 与 `false` 在这里都表示未同意 —— 不同的是前者「还没看到这句话」。
 */
export function BoolSwitch({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  return (
    <label className="planner-switch" htmlFor={id}>
      <input
        type="checkbox"
        id={id}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="planner-switch__label">{part.label ?? '开启'}</span>
    </label>
  );
}
