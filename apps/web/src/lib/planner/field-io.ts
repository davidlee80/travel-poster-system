import { plannerField, type PlannerFieldId, type PlannerProfileInput } from '@tps/schemas';

import { FIELD_DESCRIPTORS, type FieldPart } from './descriptors';
import { readAnswer, type PlannerAnswerPatch } from './state';

/**
 * 描述符与答案树之间的读写层。
 *
 * ## 为什么要单独一层
 *
 * 通用渲染器面对的是「部件」而不是「字段」：护照那个字段有两个部件
 * （状态 + 到期日），而它们的实际路径是
 * `documents.passport_status.user_reported.status` 与 `….expiry_date` ——
 * 三段包装（块 / 字段 / `user_reported`）叠在一起。让每个 primitive 组件
 * 各自拼路径的话，22 个 primitive 就有 22 处拼错的机会，而拼错的表现是
 * 「点了没反应」或者更糟的「写进了一个不存在的键，提交时被 schema 拒」。
 *
 * 这一层把路径拼接收在一处，primitive 只看见「我的值」与「setValue」。
 *
 * ## 清空是删键而不是写 undefined
 *
 * `exactOptionalPropertyTypes` 之下 `{ status: undefined }` 不是合法的
 * `{ status?: PassportStatus }`。更要紧的是语义：`JSON.stringify` 会把
 * `undefined` 的键整个丢掉，而 `'status' in record` 在两种写法下结果不同 ——
 * `hasValue` 与 `formatAnswer` 都靠 `in` 判断包装形状（`'enabled' in record`），
 * 因此写 undefined 会让一个已清空的开关看起来仍然开着。
 */

// ── 读 ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 字段的原始值（`user_reported` / `enabled` 包装都还在） */
export function fieldValue(answers: PlannerProfileInput, fieldId: PlannerFieldId): unknown {
  return readAnswer(answers, plannerField(fieldId).api_key);
}

/**
 * 剥掉 `user_reported` 之后的值。部件的键相对于它。
 *
 * 非 `reported` 字段原样返回 —— 这样调用方不必先问「这个字段包了没包」。
 */
export function effectiveValue(answers: PlannerProfileInput, fieldId: PlannerFieldId): unknown {
  const descriptor = FIELD_DESCRIPTORS[fieldId];
  const raw = fieldValue(answers, fieldId);
  if (descriptor.kind !== 'parts' || descriptor.reported !== true) return raw;
  return asRecord(raw)?.['user_reported'];
}

/** 一个部件当前的值 */
export function partValue(
  answers: PlannerProfileInput,
  fieldId: PlannerFieldId,
  part: FieldPart,
): unknown {
  const effective = effectiveValue(answers, fieldId);
  if (part.key === null) return effective;
  return asRecord(effective)?.[part.key];
}

/** 带前置开关的字段现在开着没开 */
export function isToggleOn(answers: PlannerProfileInput, fieldId: PlannerFieldId): boolean {
  return asRecord(fieldValue(answers, fieldId))?.['enabled'] === true;
}

/**
 * 部件是否满足它的 `requires` 条件。
 *
 * 不满足时不渲染，且**不清值**（规范 6 的「值保留」）—— 用户把「其他器材」
 * 从行李里取消勾选之后又勾回来，之前填的说明还在。
 */
export function partVisible(
  answers: PlannerProfileInput,
  fieldId: PlannerFieldId,
  part: FieldPart,
): boolean {
  const requires = part.requires;
  if (requires === undefined) return true;
  const sibling = asRecord(effectiveValue(answers, fieldId))?.[requires.key];
  if (Array.isArray(sibling)) return sibling.includes(requires.value);
  return sibling === requires.value;
}

// ── 写 ──────────────────────────────────────────────────────

/**
 * 构造一个 patch。
 *
 * `PlannerAnswerPatch` 的键是 19 个字面量，而这里的 `block` 是运行期字符串
 * （来自元数据表的 api_key 第一段），因此这里放弃的是**块名与叶子键名的
 * 编译期校验**。它由 `planner-profile.test.ts` 的双向断言在另一层补回来：
 * 76 个 api_key 逐个走 schema 验证，多一个叶子键或少一个都报错。
 * 也就是说这条路径上写到一个不存在的块只可能是那两者不同步 ——
 * 而那已经在 CI 里红了。
 */
function patchOf(apiKey: string, value: unknown): PlannerAnswerPatch {
  const dot = apiKey.indexOf('.');
  const block = apiKey.slice(0, dot);
  const leaf = apiKey.slice(dot + 1);
  const patch: Record<string, Record<string, unknown>> = { [block]: { [leaf]: value } };
  return patch;
}

/** 按 api_key 直接覆写一个字段。计数器的 `truncates` 与投影清理用它 */
export function patchApiKey(apiKey: string, value: unknown): PlannerAnswerPatch {
  return patchOf(apiKey, value);
}

/** 整体覆写一个字段的值（`user_reported` 包装由本函数补上） */
export function patchField(
  answers: PlannerProfileInput,
  fieldId: PlannerFieldId,
  nextEffective: unknown,
): PlannerAnswerPatch {
  const spec = plannerField(fieldId);
  const descriptor = FIELD_DESCRIPTORS[fieldId];
  if (descriptor.kind !== 'parts' || descriptor.reported !== true) {
    return patchOf(spec.api_key, nextEffective);
  }
  /*
   * `reported_on` 不在这里写。
   *
   * 它是「用户自报的日期」，供后台判断这条自报是否过期。在每次按键时写一个
   * `new Date()` 会让 reducer 变成非纯函数，也会让草稿在没有实质改动时
   * 反复变化（自动保存被触发、`useMemo` 全部失效）。它在提交时由
   * `request.ts` 一次性补上 —— 那时才是「用户把这条自报交出去」的时刻。
   */
  const previous = asRecord(fieldValue(answers, fieldId)) ?? {};
  const next: Record<string, unknown> = { ...previous, user_reported: nextEffective };
  return patchOf(spec.api_key, next);
}

/** 写一个部件 */
export function patchPart(
  answers: PlannerProfileInput,
  fieldId: PlannerFieldId,
  part: FieldPart,
  value: unknown,
): PlannerAnswerPatch {
  if (part.key === null) return patchField(answers, fieldId, value);

  const current = asRecord(effectiveValue(answers, fieldId)) ?? {};
  const next: Record<string, unknown> = { ...current };
  if (value === undefined) delete next[part.key];
  else next[part.key] = value;
  return patchField(answers, fieldId, next);
}

/**
 * 切换前置开关。
 *
 * 关掉时保留其余键（规范 6）：`{ enabled: false, amount: 8000 }` 是
 * 「填过 8000 但现在不生效」，而删掉 amount 会让用户重新打开开关时发现
 * 自己填的数字没了。
 */
export function patchToggle(
  answers: PlannerProfileInput,
  fieldId: PlannerFieldId,
  on: boolean,
): PlannerAnswerPatch {
  const previous = asRecord(fieldValue(answers, fieldId)) ?? {};
  return patchOf(plannerField(fieldId).api_key, { ...previous, enabled: on });
}

// ── 数组工具 ────────────────────────────────────────────────

export function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asStringList(value: unknown): readonly string[] {
  return asList(value).filter((entry): entry is string => typeof entry === 'string');
}

/** 多选的选中集合。`check-other` 的值在 `values` 里，`check` 的值就是数组本身 */
export function selectedValues(partValue_: unknown, wrapped: boolean): readonly string[] {
  if (!wrapped) return asStringList(partValue_);
  return asStringList(asRecord(partValue_)?.['values']);
}

/**
 * 把数组截断到 n 项。
 *
 * 截断而不是清空：计数器从 4 调到 2 时用户想保留前两位旅行者，
 * 而清空会让他把已经填好的两张卡再填一遍。
 */
export function truncated(value: unknown, n: number): readonly unknown[] {
  return asList(value).slice(0, n);
}
