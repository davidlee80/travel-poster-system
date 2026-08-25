import { PLANNER_FIELDS, isKnownConditionCode, type PlannerFieldId } from '@tps/schemas';

import { FIELD_DESCRIPTORS, type FieldPart } from './descriptors';

/**
 * 界面选项列表与配置中心之间的绑定。
 *
 * ## 一句话
 *
 * 「界面上每一个可点的选项都能被配置改掉」这件事需要一个共同的键，
 * 而这里把那个键定成**选项所在的载荷路径**。
 *
 * ## 为什么是载荷路径而不是 field_id
 *
 * 一个字段可以有多个选项列表。`PV2-05-003`（飞行舒适度）有「舱等」与「座位」
 * 两个部件，各自一份选项；`PV2-01-009`（已有订单）的每一行有「类型」与
 * 「可改退」两份。用 field_id 当键会让这些列表挤在一个键下，
 * 于是运营改「舱等」的文案会连带改到「座位」。
 *
 * 载荷路径天然唯一，且与 `planner_profile` 里那个值的实际位置一致：
 *
 *   trip.date_flexibility                     单部件字段 = api_key
 *   transport.flight_comfort.cabin            多部件 = api_key + 部件键
 *   trip.locked_orders.type                   对象数组行内的键
 *   food.allergy_details.allergens.severity   数组套数组，再深一层
 *
 * ## 为什么这张表是**派生**的而不是手写的
 *
 * 手写一份 62 行的映射表，与描述符表的漂移无法被发现：描述符里新加一个
 * 带选项的部件、忘了往映射表里补一行，那个列表就静默退回硬编码 ——
 * 运营改了配置没生效，而界面看起来完全正常。派生让「有选项的部件」
 * 与「可配置的列表」在**结构上**是同一件事。
 *
 * ## 开放与封闭
 *
 * `kind` 决定配置能做什么，而它由**值本身**判定而不是另一张手写表：
 *
 *   CONDITION_CODE  值全部是条件码。契约里是域前缀正则
 *                   （`ConditionCodeSchema`），因此配置可以增、可以删。
 *   ENUM            值是 Zod 枚举成员。配置只能删 / 改文案 / 改排序 ——
 *                   加一个枚举里没有的值，界面会出现一个按钮，
 *                   而点它之后提交被 Zod 拒（`REQ_SCHEMA_INVALID`），
 *                   错误指向 `planner_profile.budget.mode` 这种运营看不懂的路径。
 *                   因此解析器对 ENUM 取配置 ∩ 内置，见 `PlannerConfigProvider`。
 *
 * 用 `isKnownConditionCode` 而不是「值里含点号」判定：后者对
 * 「运营在配置里写了一个拼错的码」也返回真，于是那个列表被当成开放的，
 * 拼错的码一路进到提交再被 N-08 拒。
 */

export type OptionKind = 'CONDITION_CODE' | 'ENUM';

export interface OptionList {
  /** 配置中心的 `field_key`，也就是选项所在的载荷路径 */
  readonly fieldKey: string;
  readonly fieldId: PlannerFieldId;
  /**
   * 字段的 api_key。
   *
   * 与 `fieldKey` 并存是因为**内置文案表按它分层**：`OPTION_LABEL` 的键是
   * api_key（一个字段的全部选项文案挤在一张表里，见 field-spec.ts 的注释），
   * 因此配置缺文案时的回退查询必须用 api_key 而不是更深的载荷路径 ——
   * 用后者查会一路落到「回退原值」，界面上显示 `ECONOMY` 而不是「经济舱」。
   */
  readonly apiKey: string;
  /** 内置选项值，顺序即默认展示顺序 */
  readonly values: readonly string[];
  readonly kind: OptionKind;
}

/**
 * 一个部件的选项列表键。
 *
 * `prefix` 是这个部件所在的层级路径 —— 字段级部件传 api_key，
 * 对象数组行内的部件传「api_key + 数组部件的键」。
 */
export function optionFieldKey(prefix: string, part: FieldPart): string {
  return part.key === null ? prefix : `${prefix}.${part.key}`;
}

function kindOf(values: readonly string[]): OptionKind {
  return values.every((value) => isKnownConditionCode(value)) ? 'CONDITION_CODE' : 'ENUM';
}

function collect(
  fieldId: PlannerFieldId,
  apiKey: string,
  prefix: string,
  parts: readonly FieldPart[],
  out: OptionList[],
): void {
  for (const part of parts) {
    const key = optionFieldKey(prefix, part);

    /*
     * `options_from` 的部件不入表：`interests.top3` 的选项是用户在
     * `interests.tags` 里选中的那些，因此它已经是**传递性可配**的 ——
     * 配置里下线一个兴趣，它同时从多选和排序里消失。
     * 给它注册一份自己的选项会让两处打架，而 `validation.ts` 随即报
     * 「排序只能从你已选的兴趣里挑」。
     */
    if (part.options !== undefined && part.options_from === undefined) {
      out.push({
        fieldKey: key,
        fieldId,
        apiKey,
        values: part.options,
        kind: kindOf(part.options),
      });
    }

    /* 对象数组：行内部件的路径以数组部件为前缀再往下一层 */
    if (part.item_parts !== undefined) collect(fieldId, apiKey, key, part.item_parts, out);
  }
}

/** 全部可配置的选项列表。测试拿它对照迁移 */
export const OPTION_LISTS: readonly OptionList[] = (() => {
  const out: OptionList[] = [];
  for (const spec of PLANNER_FIELDS) {
    const descriptor = FIELD_DESCRIPTORS[spec.field_id];
    if (descriptor.kind !== 'parts') continue;
    collect(spec.field_id, spec.api_key, spec.api_key, descriptor.parts, out);
  }
  return out;
})();

/** `field_key` → 列表。运行期解析选项时按它查 `kind` 与内置值 */
export const OPTION_LIST_BY_KEY: ReadonlyMap<string, OptionList> = new Map(
  OPTION_LISTS.map((list) => [list.fieldKey, list]),
);

/**
 * 解析一个部件的选项时要交给配置层的东西。
 *
 * 比 `OptionList` 少一个 `fieldId`：调用点在控件树里，那里只有部件与路径，
 * 而 `fieldId` 对解析毫无用处 —— 要求它会让每个调用点都去查一次字段。
 */
export type OptionTarget = Omit<OptionList, 'fieldId'>;

/**
 * 一个部件渲染时的解析目标。
 *
 * `options_from` 的部件（只有 `interests.top3`）借**源列表**的键：排序控件里
 * 那些码就是用户在兴趣多选里勾的那些，因此它们的文案与可配性都该归
 * `interests.tags`。给它一个自己的键会让运营改兴趣文案时排序控件不跟着变。
 *
 * 注意调用方仍要用动态值覆盖 `values` —— 见 `FieldControl` 的 `PartField`。
 */
export function resolutionTarget(
  apiKey: string,
  prefix: string,
  part: FieldPart,
  values: readonly string[],
): OptionTarget {
  const fieldKey = part.options_from ?? optionFieldKey(prefix, part);
  return { fieldKey, apiKey, values, kind: OPTION_LIST_BY_KEY.get(fieldKey)?.kind ?? 'ENUM' };
}

/**
 * 投影专用条件码的 `field_key`。
 *
 * 61 个条件码里有 18 个界面上没有对应标签 —— 它们由 `request.ts` 从枚举答案
 * 投影出来（饮食要求 → `diet.*`、行动能力 → `accessibility.*` 等）。
 * 它们必须在白名单里，否则提交被 N-08 拒；但不能挂在任何界面路径下，
 * 否则会渲染出一个用户无法理解的标签。因此单独一个键 ——
 * 它与任何载荷路径都不相等，于是永远不会被渲染。
 */
export const PROJECTED_CODES_FIELD_KEY = 'conditions.projected';
