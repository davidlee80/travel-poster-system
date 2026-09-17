'use client';

import { Icon } from '@/components/Icon';
import { selectedValues } from '@/lib/planner/field-io';

import type { ControlProps } from './control-props';

/**
 * 选择类控件：单选卡片 / 多选 / 可排序多选。
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
 * 选中的卡片有 `aria-pressed`，排序项显示序号数字。把这些做成纯色差会让
 * 色觉障碍用户读不出自己选了什么，而问卷的每一个答案都会进入硬约束。
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
  // 风险排除项（PV2-04-008）—— 第 4 步参考稿保留描边风格，图标带语义色
  RED_EYE_FLIGHT: { icon: 'plane', tone: 'red' },
  OVERNIGHT_GROUND: { icon: 'moon', tone: 'purple' },
  MULTI_TRANSFER: { icon: 'transfer', tone: 'amber' },
  REMOTE_AREA: { icon: 'mountain', tone: 'slate' },
  LAST_MINUTE_CHANGE: { icon: 'alert', tone: 'orange' },
  HIGH_RISK_ACTIVITY: { icon: 'shield', tone: 'red' },
  LONG_QUEUE: { icon: 'users', tone: 'blue' },
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
  MAX_ONE_TRANSFER: { icon: 'repeat-fill', tone: 'amber' },
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
  // ── 第 6 步：住宿（step6-design.png，实心填充 + 语义色）──
  // 住宿类型（PV2-06-001）
  'accommodation.hotel': { icon: 'hotel-fill', tone: 'blue' },
  'accommodation.homestay': { icon: 'home-fill', tone: 'amber' },
  'accommodation.apartment': { icon: 'building-fill', tone: 'blue' },
  'accommodation.resort': { icon: 'palm-fill', tone: 'blue' },
  'accommodation.hostel': { icon: 'bed-fill', tone: 'blue' },
  // 设施（PV2-06-007）
  'accommodation.elevator': { icon: 'elevator-fill', tone: 'blue' },
  'accommodation.private_bath': { icon: 'bath-fill', tone: 'blue' },
  'accommodation.breakfast': { icon: 'breakfast-fill', tone: 'amber' },
  'accommodation.kitchen': { icon: 'kitchen-fill', tone: 'blue' },
  'accommodation.laundry': { icon: 'laundry-fill', tone: 'blue' },
  'accommodation.bathtub': { icon: 'bathtub-fill', tone: 'blue' },
  'accommodation.gym': { icon: 'gym-fill', tone: 'blue' },
  'accommodation.pool': { icon: 'pool-fill', tone: 'blue' },
  'accommodation.workspace': { icon: 'workspace-fill', tone: 'green' },
  'accommodation.front_desk_24h': { icon: 'bell-fill', tone: 'blue' },
  // 位置取舍（PV2-06-005）
  TRANSIT_CONVENIENT: { icon: 'car-front-fill', tone: 'blue' },
  WALK_TO_SIGHTS: { icon: 'transport-walk-fill', tone: 'blue' },
  QUIET: { icon: 'moon-stars-fill', tone: 'blue' },
  NIGHTLIFE: { icon: 'moon-fill', tone: 'purple' },
  SHOPPING: { icon: 'shopping-bag-fill', tone: 'blue' },
  SEA_OR_NATURE: { icon: 'mountain-view-fill', tone: 'green' },
  HOTEL_ITSELF: { icon: 'hotel-fill', tone: 'blue' },
  // 睡眠与入住要求（PV2-06-008）
  VERY_QUIET: { icon: 'moon-stars-fill', tone: 'blue' },
  HIGH_FLOOR: { icon: 'layers-fill', tone: 'blue' },
  NON_SMOKING: { icon: 'cigarette-off-fill', tone: 'blue' },
  LATE_CHECK_IN: { icon: 'key-fill', tone: 'blue' },
  EARLY_CHECK_IN: { icon: 'sunrise-fill', tone: 'amber' },
  LATE_CHECK_OUT: { icon: 'door-open-fill', tone: 'blue' },
  // ── 第 7 步：吃好也玩好（step7-design.png，描边图标 + 语义色）──
  // 餐饮体验（PV2-07-001）
  LOCAL_SPECIALTY: { icon: 'bowl', tone: 'amber' },
  FINE_DINING: { icon: 'wine', tone: 'purple' },
  STREET_FOOD: { icon: 'noodles', tone: 'orange' },
  MARKET: { icon: 'basket', tone: 'green' },
  CAFE_DESSERT: { icon: 'cupcake', tone: 'red' },
  BAR_IZAKAYA: { icon: 'cocktail', tone: 'purple' },
  CHINESE: { icon: 'chopsticks', tone: 'red' },
  JAPANESE: { icon: 'fish', tone: 'blue' },
  WESTERN: { icon: 'utensils', tone: 'slate' },
  // 饮食方式（PV2-07-002）
  VEGETARIAN: { icon: 'leaf', tone: 'green' },
  VEGAN: { icon: 'sprout', tone: 'green' },
  HALAL: { icon: 'moon-star', tone: 'green' },
  KOSHER: { icon: 'star-of-david', tone: 'blue' },
  NO_SPICY: { icon: 'chili', tone: 'red' },
  ALCOHOL_FREE: { icon: 'no-alcohol', tone: 'red' },
  OTHER: { icon: 'dots', tone: 'slate' },
  // 是否存在食物过敏（PV2-07-003）
  NO: { icon: 'circle-check', tone: 'green' },
  YES: { icon: 'circle-alert', tone: 'red' },
  UNSURE: { icon: 'circle-help', tone: 'slate' },
  // 怎么吃（PV2-07-005）
  MOSTLY_CASUAL: { icon: 'budget', tone: 'slate' },
  MODERATE: { icon: 'budget', tone: 'amber' },
  QUALITY_FIRST: { icon: 'budget', tone: 'purple' },
  WILL_BOOK_AHEAD: { icon: 'calendar-check', tone: 'blue' },
  WILL_QUEUE: { icon: 'queue', tone: 'blue' },
  AVOID_QUEUE: { icon: 'no-queue', tone: 'slate' },
  // 兴趣主题（PV2-07-006）
  'interest.history_culture': { icon: 'landmark', tone: 'slate' },
  'interest.nature': { icon: 'mountain-view-fill', tone: 'green' },
  'interest.food': { icon: 'food', tone: 'amber' },
  'interest.shopping': { icon: 'shopping-bag-fill', tone: 'blue' },
  'interest.art_museum': { icon: 'palette', tone: 'purple' },
  'interest.nightlife': { icon: 'moon-fill', tone: 'purple' },
  'interest.photography': { icon: 'camera', tone: 'blue' },
  'interest.family_kids': { icon: 'users-fill', tone: 'blue' },
  'interest.city_walk': { icon: 'transport-walk-fill', tone: 'green' },
  'interest.cafe': { icon: 'cupcake', tone: 'amber' },
  'interest.hot_spring': { icon: 'hot-spring', tone: 'blue' },
  'interest.theme_park': { icon: 'roller-coaster', tone: 'red' },
  'interest.zoo_aquarium': { icon: 'paw', tone: 'blue' },
  'interest.light_hiking': { icon: 'hiking-boot', tone: 'green' },
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
 * 两段式选择标签（`check` 的紧凑变体）。
 *
 * 选项只有「要 / 不要」两个状态（选中 / 未选中）。点击切换选中态，
 * 不循环、无中间状态。值形状为 `string[]`（选中的选项代码数组），
 * 与 `CheckGroup` 共用同一套数据读写逻辑。
 *
 * ## 与 CheckGroup 的区别
 *
 * `CheckGroup` 用于需要「明确没有」入口（`empty_label`）或「其他」补充
 * （`check-other`）的场景；本控件用于纯选项集合，无额外交互。
 */
export function CheckTag({
  value,
  onChange,
  options,
  labelOf,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const selected = selectedValues(value, false);

  const write = (values: readonly string[]): void => {
    onChange(values.length === 0 ? undefined : values);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      <div className="planner-tags" role="group">
        {options.map((code) => {
          const on = selected.includes(code);
          return (
            <button
              type="button"
              key={code}
              className={`planner-tag${on ? ' planner-tag--prefer' : ''}`}
              aria-label={on ? `${labelOf(code)}，已选。点击取消` : `${labelOf(code)}，未选择。点击选中`}
              aria-pressed={on}
              onClick={() => write(on ? selected.filter((entry) => entry !== code) : [...selected, code])}
            >
              {optionIcon(code)}
              <span className="planner-tag__label">{labelOf(code)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
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
