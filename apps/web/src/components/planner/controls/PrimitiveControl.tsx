'use client';

import type { FieldPart } from '@/lib/planner/descriptors';
import { asList } from '@/lib/planner/field-io';

import { CheckGroup, ChoiceRow, RankSelect, TriStateTag } from './ChoiceControls';
import { PlaceList, PlacePicker } from './PlaceControls';
import {
  BoolSwitch,
  Counter,
  DateInput,
  DateRange,
  DualTime,
  MoneyInput,
  MoneyRange,
  NumberInput,
  RangeSlider,
  TextArea,
  TextInput,
  TextList,
  TimeInput,
} from './ValueControls';
import type { ControlProps } from './control-props';

/**
 * 原语分派器。
 *
 * ## 为什么是 switch 而不是一张 `Record<ControlPrimitive, Component>`
 *
 * 三个原语要额外参数：`check` / `check-other` 与 `rank` / `rank-other` 共用
 * 组件但 `wrapped` 不同，`choice` 的币种走紧凑变体。查表写法要么给每个组件
 * 都加上这些可选参数（于是每个组件都要处理与自己无关的参数），
 * 要么包一层适配函数 —— 而 switch 本身就是那层适配，且 `never` 兜底让
 * 新增原语漏接变成**编译错误**而不是一个空白区块。
 */
export function PrimitiveControl(props: ControlProps): React.ReactElement {
  switch (props.part.primitive) {
    case 'choice':
      /* 币种 6 个 ISO 代码没有比较价值，用紧凑排布省掉半屏高度 */
      return <ChoiceRow {...props} compact={props.apiKey === 'budget.currency'} />;
    case 'check':
      return <CheckGroup {...props} wrapped={false} />;
    case 'check-other':
      return <CheckGroup {...props} wrapped />;
    case 'rank':
      return <RankSelect {...props} wrapped={false} />;
    case 'rank-other':
      return <RankSelect {...props} wrapped />;
    case 'tristate':
      return <TriStateTag {...props} />;
    case 'counter':
      return <Counter {...props} />;
    case 'number':
      return <NumberInput {...props} />;
    case 'slider':
      return <RangeSlider {...props} />;
    case 'money':
      return <MoneyInput {...props} />;
    case 'money-range':
      return <MoneyRange {...props} />;
    case 'time':
      return <TimeInput {...props} />;
    case 'time-range':
      return <DualTime {...props} />;
    case 'date':
      return <DateInput {...props} />;
    case 'date-range':
      return <DateRange {...props} />;
    case 'text':
      return <TextInput {...props} />;
    case 'textarea':
      return <TextArea {...props} />;
    case 'text-list':
      return <TextList {...props} />;
    case 'bool':
      return <BoolSwitch {...props} />;
    case 'place':
      return <PlacePicker {...props} />;
    case 'place-list':
      return <PlaceList {...props} />;
    case 'object-list':
      return <ObjectList {...props} />;
    default: {
      /* 漏接一个原语是编译错误。运行期表现（一个空白区块）几乎无法定位 */
      const exhaustive: never = props.part.primitive;
      return <>{exhaustive}</>;
    }
  }
}

/**
 * 对象数组控件（Repeater）。
 *
 * ## 为什么七个 Repeater 共用一个实现
 *
 * 已有订单、旅行者卡、房型配置、过敏原、必去清单、工作安排、会员权益 ——
 * 七处的差别全部落在「每行有哪几个键、每个键什么控件」，而那是描述符的
 * `item_parts` 已经说清楚的事。写七个组件的代价不是行数，是**七套各自演化的
 * 增删逻辑**：其中一处忘了在删除后重排 `room_index`，症状是房型配置里出现
 * 两个「第 2 间房」而校验说人数没配满。
 *
 * ## `follow_count`：行数跟着计数器
 *
 * 规范 8（人数变化自动创建或回收 Traveler Card）与规范 12（房间数与房型配置
 * 一致）是同一条规则。行数由计数器决定，因此这两处**没有**添加/删除按钮 ——
 * 改人数就是改行数，两个入口会立刻打架。
 */
function ObjectList({
  value,
  onChange,
  part,
  apiKey,
  id,
  describedBy,
  rows,
}: ControlProps): React.ReactElement {
  const items = asList(value);
  const itemParts = part.item_parts ?? [];
  const max = part.max ?? 20;

  /*
   * `rows` 来自 `follow_count`。取 `max(计数器, 已存行数)` 而不是直接取计数器：
   * 用户把人数从 4 改到 2 时截断由计数器的 `truncates` 负责，而在那次截断
   * 生效之前的一帧里，直接取计数器会让第 3、4 行的值在界面上凭空消失。
   */
  const rowCount = rows === undefined ? items.length : Math.max(rows, items.length);
  const fixed = rows !== undefined;

  const writeRow = (index: number, next: Record<string, unknown> | undefined): void => {
    const list: unknown[] = [];
    for (let i = 0; i < Math.max(rowCount, items.length); i += 1) {
      /*
       * 补齐 0..index-1 的空洞。稀疏数组会让 `JSON.stringify` 写出 `null`，
       * 而契约里每一行都是必填键齐全的对象 —— `null` 会在提交时被拒。
       */
      const existing = items[i];
      list[i] = existing === undefined ? { ...part.item_defaults } : existing;
    }
    if (next === undefined) list.splice(index, 1);
    else list[index] = next;

    /*
     * 行号重排（房型配置的 `room_index`）必须在**删除之后**做。
     * 删掉第 2 间房而不重排的结果是 `[1, 3]`，而规范 12 的界面文案是
     * 「第 N 间房」—— 用户会看到房间列表从 1 跳到 3。
     */
    const indexKey = part.index_key;
    const withIndex =
      indexKey === undefined
        ? list
        : list.map((row, i) =>
            typeof row === 'object' && row !== null
              ? { ...(row as Record<string, unknown>), [indexKey]: i + 1 }
              : row,
          );
    onChange(withIndex.length === 0 ? undefined : withIndex);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      {Array.from({ length: rowCount }, (_unused, index) => {
        const raw = items[index];
        const row: Record<string, unknown> =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : { ...part.item_defaults };
        return (
          /* key 用下标：行没有稳定标识（契约里没有 id 字段），下标是唯一可用的 key */
          <fieldset className="planner-repeater" key={index}>
            <legend className="planner-repeater__legend">
              {part.add_label === undefined ? `第 ${index + 1} 项` : `${part.add_label.replace(/^添加/, '')} ${index + 1}`}
            </legend>

            {itemParts.map((itemPart) => (
              <RowField
                key={itemPart.key ?? 'self'}
                part={itemPart}
                apiKey={apiKey}
                row={row}
                id={`${id}-${index}-${itemPart.key ?? 'self'}`}
                onWrite={(nextRow) => writeRow(index, nextRow)}
              />
            ))}

            {fixed ? null : (
              <button
                type="button"
                className="planner-button planner-button--light planner-repeater__remove"
                onClick={() => writeRow(index, undefined)}
              >
                删除{part.add_label === undefined ? '本项' : part.add_label.replace(/^添加/, '')}
              </button>
            )}
          </fieldset>
        );
      })}

      {fixed || rowCount >= max ? null : (
        <button
          type="button"
          className="planner-button planner-button--light"
          onClick={() => onChange([...items, { ...part.item_defaults }])}
        >
          ＋ {part.add_label ?? '添加一项'}
        </button>
      )}

      {rowCount === 0 ? <p className="planner-hint">还没有任何记录。</p> : null}
    </div>
  );
}

/**
 * Repeater 一行里的一个键。
 *
 * `requires` 在行内也生效（旅行者卡的「关系补充」只在关系选了「其他」时出现）：
 * 判定读的是**本行**的兄弟键而不是字段级的，因此不能复用 `field-io` 的
 * `partVisible` —— 那个函数读的是字段值。
 */
function RowField({
  part,
  apiKey,
  row,
  id,
  onWrite,
}: {
  readonly part: FieldPart;
  readonly apiKey: string;
  readonly row: Record<string, unknown>;
  readonly id: string;
  readonly onWrite: (next: Record<string, unknown>) => void;
}): React.ReactElement | null {
  const key = part.key;
  if (key === null) return null;

  const requires = part.requires;
  if (requires !== undefined) {
    const sibling = row[requires.key];
    const satisfied = Array.isArray(sibling)
      ? sibling.includes(requires.value)
      : sibling === requires.value;
    if (!satisfied) return null;
  }

  return (
    <div className="planner-repeater__field">
      <label className="planner-label" htmlFor={id}>
        {part.label ?? key}
      </label>
      <PrimitiveControl
        part={part}
        apiKey={apiKey}
        value={row[key]}
        id={id}
        options={part.options ?? []}
        onChange={(next) => {
          const nextRow = { ...row };
          if (next === undefined) delete nextRow[key];
          else nextRow[key] = next;
          onWrite(nextRow);
        }}
      />
    </div>
  );
}
