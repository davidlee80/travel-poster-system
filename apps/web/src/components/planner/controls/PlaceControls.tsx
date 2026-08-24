'use client';

import { asList } from '@/lib/planner/field-io';

import type { ControlProps } from './control-props';

/**
 * 地点选择器与可增删地点列表。
 *
 * ## 为什么要单独问国家
 *
 * 仓库里没有接地点服务（本轮不在范围内），而**跨境判定读的是国家**：
 * 附录 B 的 D-02 要求「出发国与任一目的国都已知且不同」才展开证件模块。
 * 只收一个自由文本的地点名意味着跨境链永远不触发 —— 用户拿到一份
 * 没查签证的跨境方案，而界面上第 8 步看起来只是「没有需要填的」。
 *
 * 因此地点是两个输入框：地点名 + 国家。等接了地点服务，国家由 `place_id`
 * 反查填入，这个输入框改成只读回显即可 —— 契约字段不变。
 */

interface PlaceValue {
  readonly text: string;
  readonly country?: string;
}

function asPlace(value: unknown): PlaceValue {
  if (typeof value !== 'object' || value === null) return { text: '' };
  const record = value as Record<string, unknown>;
  const text = typeof record['text'] === 'string' ? record['text'] : '';
  const country = typeof record['country'] === 'string' ? record['country'] : undefined;
  return country === undefined ? { text } : { text, country };
}

/**
 * 把一个地点折成契约形状。
 *
 * 地点名为空时整个地点是 `undefined`：`text` 在契约里是
 * `NonEmptyStringSchema`，只填了国家的半个地点会在提交时被 schema 拒。
 */
function packPlace(text: string, country: string): PlaceValue | undefined {
  if (text.trim().length === 0) return undefined;
  return country.trim().length === 0 ? { text } : { text, country };
}

function PlaceFields({
  place,
  onChange,
  idPrefix,
  placeholder,
  label,
}: {
  readonly place: PlaceValue;
  readonly onChange: (next: PlaceValue | undefined) => void;
  readonly idPrefix: string;
  readonly placeholder: string;
  readonly label: string;
}): React.ReactElement {
  return (
    <div className="planner-place">
      <input
        className="planner-input"
        type="text"
        id={`${idPrefix}-text`}
        aria-label={`${label}地点`}
        placeholder={placeholder}
        maxLength={200}
        value={place.text}
        onChange={(event) => onChange(packPlace(event.target.value, place.country ?? ''))}
      />
      <input
        className="planner-input planner-input--country"
        type="text"
        id={`${idPrefix}-country`}
        aria-label={`${label}国家或地区`}
        placeholder="国家 / 地区"
        maxLength={100}
        value={place.country ?? ''}
        onChange={(event) => onChange(packPlace(place.text, event.target.value))}
      />
    </div>
  );
}

export function PlacePicker({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      <PlaceFields
        place={asPlace(value)}
        onChange={onChange}
        idPrefix={id}
        placeholder={part.placeholder ?? '城市'}
        label=""
      />
      <p className="planner-hint">国家用来判断是否跨境 —— 跨境时我们才会问签证与证件。</p>
    </div>
  );
}

/** 可增删地点列表。**数组顺序即行程顺序**，因此要能上下移动 */
export function PlaceList({
  value,
  onChange,
  part,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const places = asList(value).map(asPlace);
  const max = part.max ?? 5;

  const write = (next: readonly (PlaceValue | undefined)[]): void => {
    const cleaned = next.filter((entry): entry is PlaceValue => entry !== undefined);
    onChange(cleaned.length === 0 ? undefined : cleaned);
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= places.length) return;
    const next: (PlaceValue | undefined)[] = [...places];
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    write(next);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      {places.map((place, index) => (
        /* key 用下标：行内容可编辑且允许重名，用值做 key 会让两行同名时互相抢占输入焦点 */
        <div className="planner-list-row planner-list-row--place" key={index}>
          <span className="planner-list-row__num" aria-hidden="true">
            {index + 1}
          </span>
          <PlaceFields
            place={place}
            onChange={(next) => {
              const list: (PlaceValue | undefined)[] = [...places];
              list[index] = next;
              write(list);
            }}
            idPrefix={`${id}-${index}`}
            placeholder="城市"
            label={`第 ${index + 1} 个目的地的`}
          />
          <span className="planner-rank__actions">
            <button
              type="button"
              className="planner-icon-button"
              aria-label={`把第 ${index + 1} 个目的地上移`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="planner-icon-button"
              aria-label={`把第 ${index + 1} 个目的地下移`}
              disabled={index === places.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="planner-icon-button"
              aria-label={`删除第 ${index + 1} 个目的地`}
              onClick={() => write(places.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </span>
        </div>
      ))}

      {places.length >= max ? (
        <p className="planner-hint">最多 {max} 个目的地。</p>
      ) : (
        <button
          type="button"
          className="planner-button planner-button--light"
          onClick={() => onChange([...places, { text: '' }])}
        >
          ＋ {part.add_label ?? '添加'}
        </button>
      )}
    </div>
  );
}
