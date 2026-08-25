'use client';

import { PLANNER_STANCE_VALUES, type PlannerStance } from '@tps/schemas';
import { useEffect, useRef, useState } from 'react';

import { selectedValues } from '@/lib/planner/field-io';

import type { ControlProps } from './control-props';

/**
 * 选择类控件：单选卡片 / 多选 / 三态标签 / 可排序多选。
 *
 * ## 四个都不是 `<select>`
 *
 * 规范 2.2 的「推荐控件」列给的是卡片与标签，理由在规范 3.2：主栏一次只显示
 * 一步，而一步里的每个问题都要「一眼看完全部选项」。折叠进下拉框的选项
 * 在移动端要两次点击才能看到，而九步问卷的放弃点主要在移动端。
 *
 * 币种是唯一的例外（6 个 ISO 代码，没有比较价值），它走 `choice` 的紧凑变体。
 *
 * ## 状态一律同时用文字表达（规范 20）
 *
 * 「任何状态不能只依赖颜色，必须同时使用文字、图标和 aria-label」。因此：
 * 选中的卡片有 `aria-pressed`、三态标签把态写在标签文字里（「公共交通 · 必须」）、
 * 排序项显示序号数字。把这些做成纯色差会让色觉障碍用户读不出自己选了什么，
 * 而问卷的每一个答案都会进入硬约束。
 */

/** 单选卡片。再点一次已选项取消选择 —— 大多数字段可选，用户要有办法撤回 */
export function ChoiceRow({
  value,
  onChange,
  options,
  labelOf,
  id,
  describedBy,
  compact,
}: ControlProps & { readonly compact?: boolean }): React.ReactElement {
  const current = typeof value === 'string' ? value : undefined;
  return (
    <div
      className={`planner-choices${compact === true ? ' planner-choices--compact' : ''}`}
      role="group"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      {options.map((option) => {
        const selected = option === current;
        return (
          <button
            key={option}
            type="button"
            className={`planner-choice${selected ? ' planner-choice--on' : ''}`}
            aria-pressed={selected}
            onClick={() => onChange(selected ? undefined : option)}
          >
            {labelOf(option)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 多选。
 *
 * `wrapped` 区分两种值形状：`string[]`（`check`）与 `{values, other_text}`
 * （`check-other`）。上限到了之后**不禁用其余选项**，而是让点击不生效并给出
 * 一句提示 —— 禁用会让用户以为那些选项与自己无关（规范 6 反对静默限制）。
 */
export function CheckGroup({
  value,
  onChange,
  options,
  labelOf,
  part,
  id,
  describedBy,
  wrapped,
}: ControlProps & { readonly wrapped: boolean }): React.ReactElement {
  const selected = selectedValues(value, wrapped);
  const otherText =
    wrapped && typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['other_text']
      : undefined;
  const max = part.max;
  const full = max !== undefined && selected.length >= max;

  const write = (values: readonly string[], other?: unknown): void => {
    if (!wrapped) {
      onChange(values.length === 0 ? undefined : values);
      return;
    }
    const text = other === undefined ? otherText : other;
    const hasOther = values.includes('OTHER') && typeof text === 'string' && text.length > 0;
    if (values.length === 0 && !hasOther) {
      onChange(undefined);
      return;
    }
    onChange(hasOther ? { values, other_text: text } : { values });
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      <div className="planner-choices" role="group">
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`planner-choice planner-choice--check${on ? ' planner-choice--on' : ''}`}
              aria-pressed={on}
              onClick={() => {
                if (on) write(selected.filter((entry) => entry !== option));
                else if (!full) write([...selected, option]);
              }}
            >
              {labelOf(option)}
            </button>
          );
        })}
      </div>

      {full ? <p className="planner-hint">已选满 {max} 项，取消一项再选其他。</p> : null}

      {/*
       * 「其他」的补充文字只在勾了 OTHER 时出现。
       * 恒显示会让一个没勾「其他」的用户在框里填了字却不生效 —— 契约里
       * `other_text` 仅当 values 含 OTHER 时有意义。
       */}
      {wrapped && selected.includes('OTHER') ? (
        <input
          className="planner-input planner-input--inline"
          type="text"
          maxLength={100}
          aria-label="其他，请补充"
          placeholder="请补充说明"
          value={typeof otherText === 'string' ? otherText : ''}
          onChange={(event) => write(selected, event.target.value)}
        />
      ) : null}
    </div>
  );
}

/**
 * 三态标签（规范 4.2）。
 *
 * 一次点击在「未选 → 偏好 → 必须 → 不要 → 未选」之间循环，而当前态**写在
 * 标签文字里**而不是只用颜色。规范 19 要求移动端改用 bottom sheet
 * （「不依赖连续点击或颜色记忆」）—— 那一层在 P9-8 加，本控件的
 * `aria-label` 已经把「现在是什么、下一次点会变成什么」都说出来了，
 * 因此屏读用户现在就不依赖循环记忆。
 *
 * 饮食与宗教要求**不用**这个控件（规范 4.2 明令禁止）：「偏好清真」不是一个
 * 有意义的表达。那些字段在描述符表里是 `check`。
 */
const STANCE_CYCLE: readonly (PlannerStance | undefined)[] = [
  undefined,
  ...PLANNER_STANCE_VALUES,
];

const STANCE_TEXT: Record<PlannerStance, string> = {
  PREFER: '偏好',
  REQUIRE: '必须',
  EXCLUDE: '不要',
};

const STANCE_MARK: Record<PlannerStance, string> = {
  PREFER: '♥',
  REQUIRE: '★',
  EXCLUDE: '✕',
};

export function TriStateTag({
  value,
  onChange,
  options,
  labelOf,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const selections = asSelections(value);
  /** 正在选态的那个 code。移动端的 bottom sheet 靠它显示（规范 19）*/
  const [sheetCode, setSheetCode] = useState<string | null>(null);

  const nextStance = (current: PlannerStance | undefined): PlannerStance | undefined => {
    const index = STANCE_CYCLE.indexOf(current);
    return STANCE_CYCLE[(index + 1) % STANCE_CYCLE.length];
  };

  const write = (code: string, stance: PlannerStance | undefined): void => {
    const rest = selections.filter((entry) => entry.code !== code);
    const next = stance === undefined ? rest : [...rest, { code, stance }];
    onChange(next.length === 0 ? undefined : next);
  };

  const sheetStance =
    sheetCode === null ? undefined : selections.find((entry) => entry.code === sheetCode)?.stance;

  return (
    <div
      className="planner-tags"
      role="group"
      id={id}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      {options.map((code) => {
        const stance = selections.find((entry) => entry.code === code)?.stance;
        const label = labelOf(code);
        const upcoming = nextStance(stance);
        return (
          <span className="planner-tag-wrap" key={code}>
            <button
              type="button"
              className={`planner-tag${stance === undefined ? '' : ` planner-tag--${stance.toLowerCase()}`}`}
              aria-label={
                stance === undefined
                  ? `${label}，未选择。点击设为${STANCE_TEXT[upcoming ?? 'PREFER']}`
                  : `${label}，当前${STANCE_TEXT[stance]}。点击改为${upcoming === undefined ? '未选择' : STANCE_TEXT[upcoming]}`
              }
              onClick={() => write(code, upcoming)}
            >
              {stance === undefined ? null : (
                <span className="planner-tag__mark" aria-hidden="true">
                  {STANCE_MARK[stance]}
                </span>
              )}
              {label}
              {stance === undefined ? null : (
                <span className="planner-tag__state"> · {STANCE_TEXT[stance]}</span>
              )}
            </button>

            {/*
              「更多」按钮：直接选态，不必循环点击（规范 19）。
              CSS 只在 <768px 显示它 —— 桌面端循环点击很顺手，
              而移动端「点三次才到不要」既慢又要求用户记住顺序。
            */}
            <button
              type="button"
              className="planner-tag__more"
              aria-label={`${label}：直接选择偏好、必须或不要`}
              aria-haspopup="dialog"
              onClick={() => setSheetCode(code)}
            >
              ⋯
            </button>
          </span>
        );
      })}

      {sheetCode === null ? null : (
        <StanceSheet
          label={labelOf(sheetCode)}
          current={sheetStance}
          onPick={(stance) => {
            write(sheetCode, stance);
            setSheetCode(null);
          }}
          onClose={() => setSheetCode(null)}
        />
      )}
    </div>
  );
}

/**
 * 三态选择的 bottom sheet（规范 19：「不依赖连续点击或颜色记忆」）。
 *
 * 四个选项各占一行，当前态带勾。这是循环点击之外的**第二条**路径 ——
 * 循环点击在桌面端很顺手，但在移动端它要求用户记住「点第三次是不要」，
 * 而那正是规范 19 明令反对的。
 *
 * ## 为什么不用 `<dialog>`
 *
 * `showModal()` 需要 effect 或 ref 去调用，而 Esc 关闭、焦点陷阱、
 * 滚动锁定这些行为在这里都不需要（它是一个四项的选择器，不是表单）。
 * 一个带 `role="dialog"` 的 div 加 Esc 监听更小且行为可预测。
 */
function StanceSheet({
  label,
  current,
  onPick,
  onClose,
}: {
  readonly label: string;
  readonly current: PlannerStance | undefined;
  readonly onPick: (stance: PlannerStance | undefined) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const panel = useRef<HTMLDivElement>(null);

  /* 打开时把焦点移进来 —— 否则键盘用户按 Tab 会走到被遮住的页面里 */
  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choices: readonly { readonly stance: PlannerStance | undefined; readonly text: string }[] = [
    { stance: 'PREFER', text: STANCE_TEXT.PREFER },
    { stance: 'REQUIRE', text: STANCE_TEXT.REQUIRE },
    { stance: 'EXCLUDE', text: STANCE_TEXT.EXCLUDE },
    { stance: undefined, text: '不选' },
  ];

  return (
    <div className="planner-sheet" role="presentation">
      <div className="planner-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="planner-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${label}：选择态度`}
        tabIndex={-1}
        ref={panel}
      >
        <p className="planner-sheet__title">{label}</p>
        {choices.map((choice) => {
          const on = choice.stance === current;
          return (
            <button
              key={choice.text}
              type="button"
              className={`planner-sheet__option${on ? ' planner-sheet__option--on' : ''}`}
              aria-pressed={on}
              onClick={() => onPick(choice.stance)}
            >
              <span aria-hidden="true">{on ? '✓' : '　'}</span> {choice.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function asSelections(value: unknown): readonly { code: string; stance: PlannerStance }[] {
  if (!Array.isArray(value)) return [];
  const stances: readonly string[] = PLANNER_STANCE_VALUES;
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const code = record['code'];
    const stance = record['stance'];
    if (typeof code !== 'string' || typeof stance !== 'string') return [];
    if (!stances.includes(stance)) return [];
    return [{ code, stance: stance as PlannerStance }];
  });
}

/**
 * 可排序多选（`ranked_array`）。
 *
 * ## 为什么是上移 / 下移按钮而不是拖拽
 *
 * 字段表把 `interests.top3` 的控件写成「拖拽排序」，而规范 20 要求
 * 「键盘可完成选择、删除、排序」。纯拖拽实现做不到这件事 —— 它也在触屏上
 * 与页面滚动打架。因此排序用两个按钮，而**数组顺序就是排名**
 * （契约里没有 `rank` 字段，理由见 `planner-profile.ts`）。
 *
 * 选中的项显示在上方的有序列表里、未选的显示在下方 —— 一个混在一起的列表
 * 没法同时表达「选了哪些」与「第几位」。
 */
export function RankSelect({
  value,
  onChange,
  options,
  labelOf,
  part,
  id,
  describedBy,
  wrapped,
}: ControlProps & { readonly wrapped: boolean }): React.ReactElement {
  const ranked = selectedValues(value, wrapped);
  const otherText =
    wrapped && typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['other_text']
      : undefined;
  const max = part.max ?? options.length;
  const full = ranked.length >= max;

  const write = (values: readonly string[], other?: unknown): void => {
    if (!wrapped) {
      onChange(values.length === 0 ? undefined : values);
      return;
    }
    const text = other === undefined ? otherText : other;
    const hasOther = values.includes('OTHER') && typeof text === 'string' && text.length > 0;
    if (values.length === 0 && !hasOther) {
      onChange(undefined);
      return;
    }
    onChange(hasOther ? { values, other_text: text } : { values });
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= ranked.length) return;
    const next = [...ranked];
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    write(next);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      {ranked.length === 0 ? null : (
        <ol className="planner-rank">
          {ranked.map((option, index) => (
            <li className="planner-rank__item" key={option}>
              <span className="planner-rank__num" aria-hidden="true">
                {index + 1}
              </span>
              <span className="planner-rank__label">
                第 {index + 1} 位：{labelOf(option)}
              </span>
              <span className="planner-rank__actions">
                <button
                  type="button"
                  className="planner-icon-button"
                  aria-label={`把「${labelOf(option)}」上移`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="planner-icon-button"
                  aria-label={`把「${labelOf(option)}」下移`}
                  disabled={index === ranked.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="planner-icon-button"
                  aria-label={`移除「${labelOf(option)}」`}
                  onClick={() => write(ranked.filter((entry) => entry !== option))}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="planner-choices" role="group" aria-label="可选项">
        {options
          .filter((option) => !ranked.includes(option))
          .map((option) => (
            <button
              key={option}
              type="button"
              className="planner-choice planner-choice--check"
              aria-pressed={false}
              onClick={() => {
                if (!full) write([...ranked, option]);
              }}
            >
              {labelOf(option)}
            </button>
          ))}
      </div>

      {full ? <p className="planner-hint">已排满 {max} 项，移除一项再加。</p> : null}
      {options.length === 0 ? (
        <p className="planner-hint">先在上一个问题里选出兴趣，这里才能排序。</p>
      ) : null}

      {wrapped && ranked.includes('OTHER') ? (
        <input
          className="planner-input planner-input--inline"
          type="text"
          maxLength={100}
          aria-label="其他，请补充"
          placeholder="请补充说明"
          value={typeof otherText === 'string' ? otherText : ''}
          onChange={(event) => write(ranked, event.target.value)}
        />
      ) : null}
    </div>
  );
}
