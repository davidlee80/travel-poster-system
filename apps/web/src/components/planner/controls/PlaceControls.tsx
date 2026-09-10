'use client';

import { asList } from '@/lib/planner/field-io';

import { Icon } from '@/components/Icon';

import type { ControlProps } from './control-props';
import { PlaceSelector } from './PlaceSelector';

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

interface DestinationValue extends PlaceValue {
  readonly arrival_date?: string;
  readonly stay_days?: number;
  readonly arrival_transport?: 'PLANE' | 'TRAIN' | 'CAR' | 'OTHER';
}

function asPlace(value: unknown): PlaceValue {
  if (typeof value !== 'object' || value === null) return { text: '' };
  const record = value as Record<string, unknown>;
  const text = typeof record['text'] === 'string' ? record['text'] : '';
  const country = typeof record['country'] === 'string' ? record['country'] : undefined;
  return country === undefined ? { text } : { text, country };
}

function asDestination(value: unknown): DestinationValue {
  const place = asPlace(value);
  if (typeof value !== 'object' || value === null) return { ...place };
  const record = value as Record<string, unknown>;
  const arrival_date =
    typeof record['arrival_date'] === 'string' ? record['arrival_date'] : undefined;
  const stay_days = typeof record['stay_days'] === 'number' ? record['stay_days'] : undefined;
  const arrival_transport =
    typeof record['arrival_transport'] === 'string'
      ? (record['arrival_transport'] as DestinationValue['arrival_transport'])
      : undefined;
  return {
    ...place,
    ...(arrival_date === undefined ? {} : { arrival_date }),
    ...(stay_days === undefined ? {} : { stay_days }),
    ...(arrival_transport === undefined ? {} : { arrival_transport }),
  };
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

function packDestination(
  text: string,
  country: string,
  arrival_date: string,
  stay_days: string,
  arrival_transport: string,
): DestinationValue | undefined {
  if (text.trim().length === 0) return undefined;
  const base = packPlace(text, country);
  if (base === undefined) return undefined;

  const result: DestinationValue = { ...base };
  if (arrival_date.trim().length > 0) {
    (result as { arrival_date?: string }).arrival_date = arrival_date;
  }
  const days = stay_days.trim().length > 0 ? Number(stay_days) : NaN;
  if (!Number.isNaN(days) && days >= 1) {
    (result as { stay_days?: number }).stay_days = days;
  }
  if (arrival_transport.trim().length > 0) {
    (result as { arrival_transport?: DestinationValue['arrival_transport'] }).arrival_transport =
      arrival_transport as DestinationValue['arrival_transport'];
  }
  return result;
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
      <span className="planner-place__text">
        <Icon name="map" size={20} className="planner-place__icon" />
        <input
          className="planner-input planner-input--place"
          type="text"
          id={`${idPrefix}-text`}
          aria-label={`${label}地点`}
          placeholder={placeholder}
          maxLength={200}
          value={place.text}
          onChange={(event) => onChange(packPlace(event.target.value, place.country ?? ''))}
        />
      </span>
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

/**
 * 目的地字段（含抵达日期/驻留天数/到达方式）。
 *
 * 设计稿 banner-1.png：目的地卡片下半部分有三个字段 ——
 * 「抵达日期」（日期选择器）、「驻留天数」（数字步进器）、「到达方式」（下拉选择）。
 * 这三个字段都是可选的（见契约 `DestinationSchema` 的注释）。
 */
function DestinationFields({
  destination,
  onChange,
  idPrefix,
  label,
  part,
  apiKey,
  describedBy,
}: {
  readonly destination: DestinationValue;
  readonly onChange: (next: DestinationValue | undefined) => void;
  readonly idPrefix: string;
  readonly label: string;
  readonly part: ControlProps['part'];
  readonly apiKey: string;
  readonly describedBy?: string;
}): React.ReactElement {
  return (
    <div className="planner-destination">
      <PlaceSelector
        value={destination}
        onChange={(next) => {
          if (next === undefined || next === null) {
            onChange(undefined);
            return;
          }
          if (typeof next === 'object' && 'text' in next && 'country' in next) {
            onChange({
              ...destination,
              ...(next as Partial<DestinationValue>),
            });
          }
        }}
        part={part}
        apiKey={apiKey}
        id={idPrefix}
        options={[]}
        labelOf={(v) => v}
        {...(describedBy === undefined ? {} : { describedBy })}
      />
      <div className="planner-destination__extras">
        <span className="planner-destination__field">
          <label htmlFor={`${idPrefix}-arrival-date`} className="planner-destination__label">
            抵达日期
          </label>
          <input
            className="planner-input planner-input--date"
            type="date"
            id={`${idPrefix}-arrival-date`}
            aria-label={`${label}抵达日期`}
            value={destination.arrival_date ?? ''}
            onChange={(event) =>
              onChange(
                packDestination(
                  destination.text,
                  destination.country ?? '',
                  event.target.value,
                  String(destination.stay_days ?? ''),
                  destination.arrival_transport ?? '',
                ),
              )
            }
          />
        </span>
        <span className="planner-destination__field">
          <label htmlFor={`${idPrefix}-stay-days`} className="planner-destination__label">
            驻留天数
          </label>
          <div className="planner-number-stepper">
            <button
              type="button"
              className="planner-number-stepper__button"
              aria-label="减少天数"
              onClick={() => {
                const current = destination.stay_days ?? 1;
                if (current > 1) {
                  onChange(
                    packDestination(
                      destination.text,
                      destination.country ?? '',
                      destination.arrival_date ?? '',
                      String(current - 1),
                      destination.arrival_transport ?? '',
                    ),
                  );
                }
              }}
              disabled={(destination.stay_days ?? 1) <= 1}
            >
              −
            </button>
            <input
              className="planner-input planner-input--number planner-number-stepper__input"
              type="number"
              id={`${idPrefix}-stay-days`}
              aria-label={`${label}驻留天数`}
              min={1}
              value={destination.stay_days ?? ''}
              onChange={(event) =>
                onChange(
                  packDestination(
                    destination.text,
                    destination.country ?? '',
                    destination.arrival_date ?? '',
                    event.target.value,
                    destination.arrival_transport ?? '',
                  ),
                )
              }
            />
            <button
              type="button"
              className="planner-number-stepper__button"
              aria-label="增加天数"
              onClick={() => {
                const current = destination.stay_days ?? 1;
                onChange(
                  packDestination(
                    destination.text,
                    destination.country ?? '',
                    destination.arrival_date ?? '',
                    String(current + 1),
                    destination.arrival_transport ?? '',
                  ),
                );
              }}
            >
              +
            </button>
          </div>
        </span>
        <span className="planner-destination__field">
          <label htmlFor={`${idPrefix}-arrival-transport`} className="planner-destination__label">
            到达方式
          </label>
          <select
            id={`${idPrefix}-arrival-transport`}
            className="planner-input planner-input--select"
            aria-label={`${label}到达方式`}
            value={destination.arrival_transport ?? ''}
            onChange={(event) =>
              onChange(
                packDestination(
                  destination.text,
                  destination.country ?? '',
                  destination.arrival_date ?? '',
                  String(destination.stay_days ?? ''),
                  event.target.value,
                ),
              )
            }
          >
            <option value="">请选择</option>
            <option value="PLANE">✈️ 飞机</option>
            <option value="TRAIN">🚄 高铁</option>
            <option value="CAR">🚗 自驾</option>
            <option value="OTHER">➕ 其他</option>
          </select>
        </span>
      </div>
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
          <span className="planner-list-row__handle" title="可用右侧按钮调整顺序">
            <Icon name="route" size={18} />
          </span>
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
              上移
            </button>
            <button
              type="button"
              className="planner-icon-button"
              aria-label={`把第 ${index + 1} 个目的地下移`}
              disabled={index === places.length - 1}
              onClick={() => move(index, 1)}
            >
              下移
            </button>
            <button
              type="button"
              className="planner-icon-button"
              aria-label={`删除第 ${index + 1} 个目的地`}
              onClick={() => write(places.filter((_, i) => i !== index))}
            >
              删除
            </button>
          </span>
        </div>
      ))}

      {places.length >= max ? (
        <p className="planner-hint">最多 {max} 个目的地。</p>
      ) : (
        <button
          type="button"
          className="planner-add-card"
          onClick={() => onChange([...places, { text: '' }])}
        >
          <span className="planner-add-card__plus" aria-hidden="true">
            ＋
          </span>
          <span>{part.add_label ?? '添加目的地 / 备选目的地'}</span>
        </button>
      )}
    </div>
  );
}

/** 可增删目的地列表（含抵达日期/驻留天数/到达方式）。**数组顺序即行程顺序**，因此要能上下移动 */
export function DestinationList({
  value,
  onChange,
  part,
  apiKey,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const destinations = asList(value).map(asDestination);
  const max = part.max ?? 5;

  const write = (next: readonly (DestinationValue | undefined)[]): void => {
    const cleaned = next.filter((entry): entry is DestinationValue => entry !== undefined);
    onChange(cleaned.length === 0 ? undefined : cleaned);
  };

  return (
    <div id={id} {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}>
      {destinations.map((destination, index) => (
        /* key 用下标：行内容可编辑且允许重名，用值做 key 会让两行同名时互相抢占输入焦点 */
        <div className="planner-list-row planner-list-row--destination" key={index}>
          <span className="planner-list-row__num" aria-hidden="true">
            {index + 1}
          </span>
          <DestinationFields
            destination={destination}
            onChange={(next) => {
              const list: (DestinationValue | undefined)[] = [...destinations];
              list[index] = next;
              write(list);
            }}
            idPrefix={`${id}-${index}`}
            label={`第 ${index + 1} 个目的地的`}
            part={part}
            apiKey={apiKey}
            {...(describedBy === undefined ? {} : { describedBy })}
          />
          <button
            type="button"
            className="planner-icon-button planner-icon-button--danger"
            aria-label={`删除第 ${index + 1} 个目的地`}
            onClick={() => write(destinations.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}

      {destinations.length >= max ? (
        <p className="planner-hint">最多 {max} 个目的地。</p>
      ) : (
        <button
          type="button"
          className="planner-add-card"
          onClick={() => onChange([...destinations, { text: '' }])}
        >
          <span className="planner-add-card__plus" aria-hidden="true">
            ＋
          </span>
          <span>{part.add_label ?? '添加目的地 / 备选目的地'}</span>
        </button>
      )}
    </div>
  );
}
