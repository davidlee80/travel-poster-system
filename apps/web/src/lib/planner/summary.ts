import {
  plannerField,
  type PlannerFieldId,
  type PlannerStepId,
  type PlannerSummaryGroup,
} from '@tps/schemas';

import { ABSTRACT_SUMMARY, isMasked, optionLabel } from './field-spec';
import { isSatisfied, type FieldState } from './field-state';
import { readAnswer, type PlannerState } from './state';
import type { PlannerSnapshot } from './step-state';

/**
 * 右侧旅行画像的五组（规范 17）。
 *
 * ## chip 是可回跳的按钮，不是标签
 *
 * 规范 17.2：每个摘要项保留 `source_field_id`，点击回跳来源 Step、
 * 滚动到字段并聚焦。因此这里产出的每个 chip 都带 `fieldId` 与 `step`。
 *
 * ## LOCKED 从已有订单派生，不是某个字段的静态类型
 *
 * 规范 4 章的注：LOCKED 由 `trip.locked_order_types` / `trip.locked_orders` 的
 * 有效记录派生。因此 `PV2-01-009` 的元数据类型是 HARD，而它在右栏要显示成
 * 带锁图标的 LOCKED —— 这一层转换只发生在这里。
 */

/** 五组的显示顺序与标题（规范 17 的表）*/
export const SUMMARY_GROUPS = [
  { group: 'SKELETON', title: '旅行骨架', collapsible: false },
  { group: 'MUST', title: '必须满足', collapsible: false },
  { group: 'PREFER', title: '优先满足', collapsible: true },
  { group: 'EXCLUDE', title: '明确不要', collapsible: true },
  { group: 'VERIFY', title: '还需要确认', collapsible: false },
] as const satisfies readonly {
  readonly group: PlannerSummaryGroup;
  readonly title: string;
  readonly collapsible: boolean;
}[];

export type SummaryChipKind = 'fact' | 'locked' | 'must' | 'prefer' | 'exclude' | 'verify';

export interface SummaryChip {
  readonly fieldId: PlannerFieldId;
  readonly step: PlannerStepId;
  /** 显示文案。高度敏感字段是抽象状态而不是具体值 */
  readonly text: string;
  readonly kind: SummaryChipKind;
  /** VERIFY 项里影响生成的那些。右栏高亮它们（规范 17）*/
  readonly blocking: boolean;
}

export interface SummarySection {
  readonly group: PlannerSummaryGroup;
  readonly title: string;
  readonly collapsible: boolean;
  readonly chips: readonly SummaryChip[];
}

/**
 * 把答案渲染成一句话。
 *
 * 逐形状处理，与 `hasValue` 对应的五种包装一一对应。渲染不出来时返回 null
 * 而不是空串 —— 调用方据此**不产出 chip**，而一个空 chip 会让用户以为
 * 自己填的东西丢了。
 */
export function formatAnswer(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim().length > 0 ? optionLabel(value) : null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';

  if (Array.isArray(value)) {
    const parts = value.map((entry) => formatAnswer(entry)).filter((part) => part !== null);
    return parts.length === 0 ? null : parts.join('、');
  }

  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  /* 三态标签：显示「标签 · 态」，因为「必须公共交通」与「不要公共交通」是两件事 */
  if (typeof record['code'] === 'string' && typeof record['stance'] === 'string') {
    return `${optionLabel(record['code'])}${STANCE_SUFFIX[record['stance']] ?? ''}`;
  }

  if ('user_reported' in record) return formatAnswer(record['user_reported']);

  if ('values' in record) {
    const values = formatAnswer(record['values']);
    const other = typeof record['other_text'] === 'string' ? record['other_text'].trim() : '';
    if (values === null) return other.length > 0 ? other : null;
    return other.length > 0 ? `${values}、${other}` : values;
  }

  if ('enabled' in record) {
    if (record['enabled'] !== true) return null;
    const rest = Object.entries(record).filter(([key]) => key !== 'enabled');
    const detail = formatAnswer(Object.fromEntries(rest));
    return detail === null ? '已开启' : detail;
  }

  /* 金额与时间区间 */
  if ('min' in record && 'max' in record)
    return `${String(record['min'])}～${String(record['max'])}`;
  if ('start' in record && 'end' in record)
    return `${String(record['start'])}–${String(record['end'])}`;
  if ('start_date' in record && 'end_date' in record) {
    return `${String(record['start_date'])} 至 ${String(record['end_date'])}`;
  }

  const parts = Object.values(record)
    .map((entry) => formatAnswer(entry))
    .filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join('、');
}

const STANCE_SUFFIX: Record<string, string> = {
  PREFER: '（偏好）',
  REQUIRE: '（必须）',
  EXCLUDE: '（不要）',
};

const KIND_BY_GROUP: Record<PlannerSummaryGroup, SummaryChipKind> = {
  SKELETON: 'fact',
  MUST: 'must',
  PREFER: 'prefer',
  EXCLUDE: 'exclude',
  VERIFY: 'verify',
  HIDDEN: 'fact',
};

/**
 * 产出五组画像。
 *
 * 只收**已触发且已回答**的字段（规范 6：未触发不占位）。`inactive` 的草稿
 * 也不进 —— 它对当前这份计划不生效，出现在画像里会让用户以为它仍然有效。
 */
export function buildSummary(
  state: PlannerState,
  snapshot: PlannerSnapshot,
): readonly SummarySection[] {
  const chipsByGroup = new Map<PlannerSummaryGroup, SummaryChip[]>();
  for (const entry of SUMMARY_GROUPS) chipsByGroup.set(entry.group, []);

  const lockedIds = new Set<PlannerFieldId>(
    hasLockedOrders(state) ? (['PV2-01-008', 'PV2-01-009'] as const) : [],
  );

  for (const fieldId of snapshot.triggered) {
    const spec = plannerField(fieldId);
    if (spec.summary_group === 'HIDDEN') continue;

    const fs: FieldState | undefined = snapshot.states.get(fieldId);
    if (fs === undefined || !isSatisfied(fs)) continue;

    const text = chipText(state, fieldId);
    if (text === null) continue;

    const bucket = chipsByGroup.get(spec.summary_group);
    if (bucket === undefined) continue;

    bucket.push({
      fieldId,
      step: spec.step,
      text,
      kind: lockedIds.has(fieldId) ? 'locked' : KIND_BY_GROUP[spec.summary_group],
      blocking: spec.runtime_type === 'VERIFY_BLOCKING' && fs === 'verify_pending',
    });
  }

  return SUMMARY_GROUPS.map((entry) => ({
    group: entry.group,
    title: entry.title,
    collapsible: entry.collapsible,
    /* blocking 项置顶（规范 17：blocking 项高亮）*/
    chips: (chipsByGroup.get(entry.group) ?? []).sort(
      (a, b) => Number(b.blocking) - Number(a.blocking),
    ),
  }));
}

function chipText(state: PlannerState, fieldId: PlannerFieldId): string | null {
  const spec = plannerField(fieldId);
  if (isMasked(fieldId)) {
    /*
     * 高度敏感字段用抽象文案。没配抽象文案时**不产出 chip**，
     * 而不是回退到显示具体值 —— 回退会让漏配变成一次隐私泄露，
     * 而漏 chip 只是少显示一条。
     */
    return ABSTRACT_SUMMARY[fieldId] ?? null;
  }
  const value = formatAnswer(readAnswer(state.answers, spec.api_key));
  return value === null ? null : `${shortQuestion(spec.question)}：${value}`;
}

/**
 * 把问句压成 chip 上放得下的短标签。
 *
 * 去掉问号与「是否」「有没有」这类问句词头 —— chip 只有一行高度，
 * 「是否有会影响旅行安排的健康、行动或无障碍需求？：有」读起来比不写更糟。
 */
export function shortQuestion(question: string): string {
  return question
    .replace(/[？?]$/, '')
    .replace(/^(是否有|是否存在|是否|有没有|哪些|还有哪些)/, '')
    .trim();
}

function hasLockedOrders(state: PlannerState): boolean {
  const orders = readAnswer(state.answers, 'trip.locked_orders');
  return Array.isArray(orders) && orders.length > 0;
}

/** 待核验清单。右栏「还需要确认」与第 9 步的 blocker 列表共用 */
export function verifyItems(
  state: PlannerState,
  snapshot: PlannerSnapshot,
): readonly SummaryChip[] {
  const section = buildSummary(state, snapshot).find((entry) => entry.group === 'VERIFY');
  return section?.chips ?? [];
}
