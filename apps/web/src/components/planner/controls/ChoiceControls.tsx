'use client';

import { PLANNER_STANCE_VALUES, type PlannerStance } from '@tps/schemas';

import { Icon } from '@/components/Icon';
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
 * 选中的卡片有 `aria-pressed`、三态标签在选项文字前显示状态图标（「★ 直飞」）、
 * 排序项显示序号数字。把这些做成纯色差会让色觉障碍用户读不出自己选了什么，
 * 而问卷的每一个答案都会进入硬约束。
 */

/** 单选卡片。再点一次已选项取消选择 —— 大多数字段可选，用户要有办法撤回 */

/**
 * 选项与图标（含语义色）的映射。
 *
 * ## 为什么按「值 → 图标」而不是按字段
 *
 * 同一个枚举值只在一个字段里出现（`ECONOMY` 只在舱等、`WINDOW` 只在座位），
 * 按值查表就不用让控件知道自己在渲染哪个字段。条件码自带域前缀
 * （`transport.flight`），值与枚举值不会撞名。
 *
 * ## 彩色方案（`tone`）
 *
 * 图标库契约是 `stroke="currentColor"`（自包含、随文字变色），彩色通过
 * CSS 类 `--tone-*` 给 `currentColor` 赋一个语义色实现 —— 图标文件本身
 * 不动。`--tone-*` 只在**未选中**的按钮上生效：选中后按钮整体变主题色，
 * 图标必须跟着变，否则蓝底上留个琥珀色图标。
 *
 * 查不到映射的选项渲染纯文字 —— 图标是增强，不是信息的唯一载体（规范 20）。
 */
type OptionIconSpec = { readonly icon: string; readonly tone?: string };

const OPTION_ICON_MAP: Record<string, OptionIconSpec> = {
  // 风险排除项（PV2-04-008）—— 第 4 步参考稿保留描边风格
  RED_EYE_FLIGHT: { icon: 'plane' },
  OVERNIGHT_GROUND: { icon: 'moon' },
  MULTI_TRANSFER: { icon: 'transfer' },
  REMOTE_AREA: { icon: 'mountain' },
  LAST_MINUTE_CHANGE: { icon: 'alert' },
  HIGH_RISK_ACTIVITY: { icon: 'shield' },
  LONG_QUEUE: { icon: 'users' },
  // ── 第 5 步：参考稿为实心填充（-fill 变体）+ 语义色 ──
  // 跨城交通方式（PV2-05-001）
  'transport.flight': { icon: 'plane-fill', tone: 'blue' },
  'transport.rail': { icon: 'transport-train-fill', tone: 'blue' },
  'transport.coach': { icon: 'bus', tone: 'slate' },
  'transport.ferry': { icon: 'transport-boat-fill', tone: 'blue' },
  'transport.self_drive': { icon: 'transport-drive', tone: 'slate' },
  // 当地移动方式（PV2-05-005）
  'transport.public_transit': { icon: 'transport-transit', tone: 'blue' },
  'transport.walking_first': { icon: 'transport-walk-fill', tone: 'green' },
  'transport.ride_hailing': { icon: 'transport-taxi-fill', tone: 'amber' },
  'transport.private_car': { icon: 'van', tone: 'slate' },
  'transport.cycling': { icon: 'transport-bike', tone: 'blue' },
  // 直飞与转机（PV2-05-002）
  DIRECT_ONLY: { icon: 'plane-fill', tone: 'blue' },
  DIRECT_PREFERRED: { icon: 'thumb-up-fill', tone: 'green' },
  MAX_ONE_TRANSFER: { icon: 'transfer', tone: 'amber' },
  MULTI_TRANSFER_OK: { icon: 'repeat-fill', tone: 'purple' },
  // 舱等（PV2-05-003）
  ECONOMY: { icon: 'seat-fill', tone: 'blue' },
  PREMIUM_ECONOMY: { icon: 'star-fill', tone: 'green' },
  BUSINESS: { icon: 'crown-fill', tone: 'amber' },
  FIRST: { icon: 'gem-fill', tone: 'amber' },
  // 座位（PV2-05-003）
  WINDOW: { icon: 'window-fill', tone: 'slate' },
  AISLE: { icon: 'aisle-fill', tone: 'slate' },
  TOGETHER: { icon: 'users-fill', tone: 'purple' },
  // 出发 / 抵达时段（PV2-05-004）
  EARLY_MORNING: { icon: 'period-morning-fill', tone: 'blue' },
  MORNING: { icon: 'sun-bright-fill', tone: 'amber' },
  AFTERNOON: { icon: 'sunset-fill', tone: 'orange' },
  EVENING: { icon: 'moon-fill', tone: 'purple' },
};

/** 选项图标。查不到时返回 null —— 调用方退化为纯文字按钮 */
function optionIcon(option: string): React.ReactElement | null {
  const spec = OPTION_ICON_MAP[option];
  if (spec === undefined) return null;
  const tone = spec.tone === undefined ? '' : ` planner-choice__icon--tone-${spec.tone}`;
  return <Icon name={spec.icon} size={18} className={`planner-choice__icon${tone}`} />;
}

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
            {optionIcon(option)}
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
  const explicitEmpty =
    part.empty_label !== undefined &&
    (wrapped
      ? typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as Record<string, unknown>)['values']) &&
        ((value as Record<string, unknown>)['values'] as readonly unknown[]).length === 0
      : Array.isArray(value) && value.length === 0);

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
        {part.empty_label === undefined ? null : (
          <button
            type="button"
            className={`planner-choice planner-choice--check${explicitEmpty ? ' planner-choice--on' : ''}`}
            aria-pressed={explicitEmpty}
            onClick={() => onChange(explicitEmpty ? undefined : wrapped ? { values: [] } : [])}
          >
            {part.empty_label}
          </button>
        )}
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
              {optionIcon(option)}
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
 * 默认一次点击在「未选 → 偏好 → 必须 → 不要 → 未选」之间循环，而当前态**写在
 * 标签文字里**而不是只用颜色。规范 19 要求移动端改用 bottom sheet
 * （「不依赖连续点击或颜色记忆」）—— 那一层在 P9-8 加，本控件的
 * `aria-label` 已经把「现在是什么、下一次点会变成什么」都说出来了，
 * 因此屏读用户现在就不依赖循环记忆。
 *
 * ## 两段变体（`part.two_state`，第 5 步的两个交通字段）
 *
 * 参考稿只保留「未选 ⇄ 偏好」：不渲染 ★♥× 图例与状态图标，点击写入恒为
 * `PREFER`（值形状不变，下游触发器与约束投影不受影响）。旧草稿里残留的
 * `REQUIRE`/`EXCLUDE` 值按「已选」显示，点一次清空 —— 不写新的非 PREFER 值。
 *
 * 饮食与宗教要求**不用**这个控件（规范 4.2 明令禁止）：「偏好清真」不是一个
 * 有意义的表达。那些字段在描述符表里是 `check`。
 */
const STANCE_CYCLE: readonly (PlannerStance | undefined)[] = [undefined, ...PLANNER_STANCE_VALUES];

const STANCE_TEXT: Record<PlannerStance, string> = {
  PREFER: '偏好',
  REQUIRE: '必须',
  EXCLUDE: '不要',
};

const STANCE_VISUAL: Record<PlannerStance, { readonly icon: string; readonly aria: string }> = {
  PREFER: { icon: '♥', aria: '优先考虑' },
  REQUIRE: { icon: '★', aria: '必须满足' },
  EXCLUDE: { icon: '×', aria: '明确排除' },
};

export function TriStateTag({
  value,
  onChange,
  options,
  labelOf,
  id,
  describedBy,
  part,
}: ControlProps): React.ReactElement {
  const selections = asSelections(value);
  const twoState = part.two_state === true;

  const nextStance = (current: PlannerStance | undefined): PlannerStance | undefined => {
    const index = STANCE_CYCLE.indexOf(current);
    return STANCE_CYCLE[(index + 1) % STANCE_CYCLE.length];
  };

  const write = (code: string, stance: PlannerStance | undefined): void => {
    const rest = selections.filter((entry) => entry.code !== code);
    const next = stance === undefined ? rest : [...rest, { code, stance }];
    onChange(next.length === 0 ? undefined : next);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      {twoState ? null : (
        <div className="planner-stance-guide" aria-label="多状态按钮说明">
          <span className="planner-stance-guide__require" aria-label="必须满足" title="必须满足">
            ★
          </span>
          <span className="planner-stance-guide__prefer" aria-label="优先考虑" title="优先考虑">
            ♥
          </span>
          <span className="planner-stance-guide__exclude" aria-label="明确排除" title="明确排除">
            ×
          </span>
          <small>连续点击可切换状态，再点一次可取消。</small>
        </div>
      )}
      <div className="planner-tags" role="group">
        {options.map((code) => {
          const stance = selections.find((entry) => entry.code === code)?.stance;
          const label = labelOf(code);
          if (twoState) {
            /* 两段：未选 ⇄ 偏好。读取端把旧草稿的 REQUIRE/EXCLUDE 也当作已选 */
            const selected = stance !== undefined;
            return (
              <button
                type="button"
                key={code}
                className={`planner-tag${selected ? ' planner-tag--prefer' : ''}`}
                aria-label={selected ? `${label}，已选。点击取消` : `${label}，未选择。点击选中`}
                aria-pressed={selected}
                data-stance={stance ?? 'NONE'}
                onClick={() => write(code, selected ? undefined : 'PREFER')}
              >
                {optionIcon(code)}
                <span className="planner-tag__label">{label}</span>
              </button>
            );
          }
          const upcoming = nextStance(stance);
          const visual = stance === undefined ? undefined : STANCE_VISUAL[stance];
          return (
            <button
              type="button"
              key={code}
              className={`planner-tag${stance === undefined ? '' : ` planner-tag--${stance.toLowerCase()}`}`}
              aria-label={
                stance === undefined
                  ? `${label}，未选择。点击设为${STANCE_VISUAL[upcoming ?? 'PREFER'].aria}`
                  : `${label}，当前${visual?.aria ?? STANCE_TEXT[stance]}。点击改为${
                      upcoming === undefined ? '未选择' : STANCE_VISUAL[upcoming].aria
                    }`
              }
              aria-pressed={stance !== undefined}
              data-stance={stance ?? 'NONE'}
              onClick={() => write(code, upcoming)}
            >
              {visual === undefined ? null : (
                <span className="planner-tag__mark" aria-hidden="true">
                  {visual.icon}
                </span>
              )}
              <span className="planner-tag__label">{label}</span>
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
                  className="planner-icon-button planner-icon-button--danger"
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
