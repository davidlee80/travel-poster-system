import type { PageType } from '@tps/schemas';
import type { ComponentType } from 'react';

import { TravelInfographic } from './ink-paper-v1/daily';
import { TravelFullPlan } from './ink-paper-v1/full';
import { BlueprintDaily } from './blueprint-v1/daily';
import { BlueprintFullPlan } from './blueprint-v1/full';

/**
 * 样式套件注册表：`(templateId, pageType) → 组件`（R-85）。
 *
 * ## 为什么需要一张表
 *
 * 在 R-85 之前两个渲染路由各自**静态 import** 一个组件
 * （`import { TravelInfographic } from '@/templates/travel-infographic-v1'`），
 * 也就是把「用哪一套样式」写死在路由里。用户选的模板因此无处生效 ——
 * 请求契约收下了 `template_id`，而渲染端从头到尾没读过它。
 *
 * ## 一个套件覆盖两个页型
 *
 * 表的第一层是套件、第二层是页型。这与 `plan_presentations_uk`
 * （`plan_version_id, template_id, page_type, day_number`）的形状一致 ——
 * 套件与页型是两个正交维度。
 *
 * 用 `Record` 而不是 `Map`：键集合在编译期已知，漏一个页型是类型错误。
 * 新增套件时 TypeScript 会要求它同时提供 `DAILY_POSTER` 与 `FULL_PLAN` ——
 * 这正是「任何模板都应包含全览页和每日页」这条产品约束的落地方式。
 *
 * ## 为什么不做动态 import
 *
 * 渲染页面在 Playwright 里跑，首屏时间直接进 T3 预算（16.3）。
 * 动态 import 会引入一次额外的 chunk 往返，而套件数量是个位数、
 * 每个套件的 CSS 只有几百行 —— 静态引入的体积代价远小于那次往返。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- 两个页型的 ViewModel 形状不同，注册表只负责选组件不负责校验入参 */
type TemplateComponent = ComponentType<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const TEMPLATE_REGISTRY: Readonly<
  Record<string, Readonly<Record<PageType, TemplateComponent>>>
> = {
  ink_paper_v1: {
    DAILY_POSTER: TravelInfographic,
    FULL_PLAN: TravelFullPlan,
  },
  blueprint_v1: {
    DAILY_POSTER: BlueprintDaily,
    FULL_PLAN: BlueprintFullPlan,
  },
};

/**
 * 取组件。未注册的套件返回 `null` —— 由调用方决定是 404 还是回退。
 *
 * **不在这里静默回退到默认套件**：那会让「模板名写错」表现为
 * 「导出成功但样式不对」，而那种失败没有任何信号。路由拿到 null 时
 * 走 `notFound()`，让错误在第一次请求就暴露。
 */
export function templateComponent(
  templateId: string,
  pageType: PageType,
): TemplateComponent | null {
  return TEMPLATE_REGISTRY[templateId]?.[pageType] ?? null;
}
