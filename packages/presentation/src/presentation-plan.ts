import type { AssetRequirementItem, PageType, TemplateId, TravelPlan } from '@tps/schemas';
import {
  DAILY_CONTENT_LIMITS,
  FULL_PLAN_CONTENT_LIMITS,
  type ContentLimits,
} from './content-limits.js';
import { requirementsForDay } from './requirements.js';

/**
 * Presentation Planner（TP-3-03，设计稿 3.3、3.3.1）。
 *
 * 对每个计划版本输出 **N+1 个 `PresentationPlan`**：N 天各一页 +
 * 一个完整计划页。它回答的是「页面需要哪些模块、每个模块显示多少条、
 * 哪些槽位要被填充」，**不回答「图片从哪来」**（3.3「它不负责查找图片」）。
 *
 * ## 完整页为什么不带槽位
 *
 * 3.3.1：`FULL_PLAN` 只复用各日已解析的素材，不新增槽位 ——
 * 否则 14 天计划会因为多一个完整页而多出一整套 AI 生成成本，
 * 而完整页展示的本来就是同一批图。
 */

export interface PresentationPlan {
  readonly template_id: TemplateId;
  readonly page_type: PageType;
  /** `DAILY_POSTER` 必填；`FULL_PLAN` 必须为 null（3.3.1） */
  readonly day_number: number | null;
  readonly content_limits: ContentLimits;
  /** 第七章 `requirements[]` 的单页子集（3.3.1） */
  readonly asset_requirements: readonly AssetRequirementItem[];
}

export interface BuildPresentationPlansInput {
  readonly plan: TravelPlan;
  /** 每日模板。默认 `travel_infographic_v1` */
  readonly dailyTemplateId?: TemplateId;
  /** 完整页模板。默认 `travel_full_plan_v1` */
  readonly fullTemplateId?: TemplateId;
  readonly limits?: ContentLimits;
}

export function buildPresentationPlans(input: BuildPresentationPlansInput): PresentationPlan[] {
  const {
    plan,
    dailyTemplateId = 'travel_infographic_v1',
    fullTemplateId = 'travel_full_plan_v1',
    limits = DAILY_CONTENT_LIMITS,
  } = input;

  // 按 day_number 排序而不是相信数组顺序（V-02 的乱序在业务规则阶段已修复，
  // 这里排序是廉价的防御 —— 与 buildFullPlan 同一处理）
  const days = [...plan.days].sort((a, b) => a.day_number - b.day_number);

  const daily: PresentationPlan[] = days.map((day) => ({
    template_id: dailyTemplateId,
    page_type: 'DAILY_POSTER',
    day_number: day.day_number,
    content_limits: limits,
    asset_requirements: requirementsForDay({ plan, day, limits }),
  }));

  return [
    ...daily,
    {
      template_id: fullTemplateId,
      page_type: 'FULL_PLAN',
      day_number: null,
      content_limits: FULL_PLAN_CONTENT_LIMITS,
      asset_requirements: [],
    },
  ];
}
