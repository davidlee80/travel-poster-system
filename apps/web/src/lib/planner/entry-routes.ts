import type { PlannerStepId } from '@tps/schemas';

import type { PlannerSection } from '@/components/planner/steps/sections';
import type { EntryRoute } from '@/lib/planner/state';

/**
 * 入口路线 → 第 1 步可见区块（按 `STEP_SECTIONS['01']` 的 `title` 匹配）。
 *
 * ## 为什么这是一张表而不是组件里的 if
 *
 * 第 0 步选卡会改变第 1 步**显示哪些区块**，而需求方已明确「区块差异会随
 * 需求频繁变化」。把规则集中在一张表里，是为了让下一次调整只改数据、
 * 不动 `StepPage` 的渲染分支 —— 四个 if 散在组件里，第五次需求来时
 * 就要重读整个组件。
 *
 * ## TODO（后端契约重梳理时处理）
 *
 * 被隐藏的字段目前仍按原契约参与必填/阻塞计算；本表只做**视觉过滤**，
 * 不解除阻塞。等后端契约重梳理时，需要把「该路线下哪些字段不再是
 * 必填/阻塞」下沉为正式契约规则，前端再改为读取契约而不是这张表。
 *
 * 当前为宽松实现：隐藏字段**不参与**第 1 步的渲染；阻塞校验是否放宽
 * 由 `step-state` / `triggers` 在后续契约对齐时统一处理。
 */

/** 第 1 步五个区块的标题（与 sections.ts 的 `title` 逐字一致） */
export type Step1SectionTitle =
  | '从哪出发，去哪里'
  | '出发日期与返回日期'
  | '目的地 / 备选目的地'
  | '这趟旅行为了什么'
  | '已经订好的部分';

/**
 * 每条路线在第 1 步显示的区块标题集合。
 *
 * `undefined` 表示「未选路线 / plan 路线」→ 显示全部区块（现状）。
 * 选 `plan`（都定了）时展示全部，因为那条路线的语义就是「信息已齐，
 * 只差串起来」，隐藏任何区块都会违背这个预期。
 */
export const STEP1_SECTIONS_BY_ROUTE: Readonly<
  Record<EntryRoute, readonly Step1SectionTitle[] | undefined>
> = {
  /* 还没想好去哪：目的地与已订订单都无意义，先问日期与目的 */
  explore: ['从哪出发，去哪里', '出发日期与返回日期', '这趟旅行为了什么'],
  /* 假期已定：缺的是目的地 */
  destination: ['从哪出发，去哪里', '出发日期与返回日期', '这趟旅行为了什么'],
  /* 目的地已定：缺的是时间 */
  time: ['从哪出发，去哪里', '目的地 / 备选目的地', '这趟旅行为了什么'],
  /* 都定了：全量展示 */
  plan: undefined,
};

/**
 * 给定路线，返回第 1 步应当显示的区块。
 * 返回 `undefined` 表示不过滤（显示全部）。
 *
 * 用 `title` 匹配而不是 `fields` 匹配：同一张卡在两种视角下
 * （「哪些字段算这一步」与「哪些区块给用户看」）可能用不同粒度，
 * 而标题是两者中更稳定、更接近 UX 语义的锚点。
 */
export function filterStep1Sections(
  route: EntryRoute | null,
  sections: readonly PlannerSection[],
): readonly PlannerSection[] {
  if (route === null) return sections;
  const visible = STEP1_SECTIONS_BY_ROUTE[route];
  if (visible === undefined) return sections;
  const visibleSet = new Set<string>(visible);
  return sections.filter((section) => visibleSet.has(section.title));
}

/** 供 UI 展示用的路线标签（第 0 步卡片标题） */
export const ENTRY_ROUTE_LABEL: Record<EntryRoute, string> = {
  explore: '还没想好去哪',
  destination: '假期有了，去哪好呢',
  time: '有想去的地方，时间待定',
  plan: '都定了，开始规划吧',
};

/**
 * 判断某个步骤是否受入口路线影响（目前只有第 1 步）。
 *
 * 单独抽出来而不是在 StepPage 里写 `step === '01'`：将来若第 2、3 步
 * 也按路线分版，只需在这里加映射，StepPage 的调用点不变。
 */
export function routeAffectsStep(step: PlannerStepId): boolean {
  return step === '01';
}
