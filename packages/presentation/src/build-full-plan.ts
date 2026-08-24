import type { FullPlanViewModelShape, TemplateId, TravelPlan } from '@tps/schemas';
import { buildDailyPoster, EMPTY_ASSET_LOOKUP, type AssetLookup } from './build-view-model.js';
import { FULL_PLAN_CONTENT_LIMITS } from './content-limits.js';
import { CURRENCY_SYMBOL } from './derive.js';

/**
 * 完整计划页 ViewModel（TP-1-06，设计稿 3.3.1 的 FULL_PLAN）。
 *
 * ## 为什么是「每日 ViewModel 的集合」而不是另一套结构
 *
 * 3.3.1 明确 `FULL_PLAN` **不新增素材槽位，只复用各日已解析的素材**。
 * 因此完整页的数据就是各日 ViewModel 的集合加上一个计划级头部 ——
 * 引入第三套数据结构只会多一处需要保持一致的地方。
 *
 * `content_limits` 全为 null（完整页不裁剪内容），所以各日 ViewModel 里的
 * `*_compact` 在完整页中不会被使用，但仍然存在 —— 它们是同一个 ViewModel
 * 契约，不为完整页单独裁剪字段。
 */

/**
 * 完整计划页的 ViewModel。
 *
 * 类型由 `FullPlanViewModelSchema` 推导（V1.6）—— 此前这里是一份手写的
 * interface，而 13.4 的 `/presentations/full` 响应因此无法被校验：
 * 服务端存进去什么、客户端就得信什么。而落库的 ViewModel 是历史数据，
 * 模板契约改版后库里还留着旧结构。
 *
 * `readonly` 由 schema 侧的推导带不出来，因此这里再包一层 —— 编排阶段
 * 构造它时不该有人往 `days` 里 push。
 */
export type FullPlanViewModel = FullPlanViewModelShape;

export interface BuildFullPlanInput {
  readonly plan: TravelPlan;
  readonly templateId?: TemplateId;
  readonly assets?: AssetLookup;
}

export interface BuildFullPlanResult {
  readonly viewModel: FullPlanViewModel;
  /** 任一天出现 V-20 预算不一致 */
  readonly budgetMismatch: boolean;
}

/** 日期区间文案：`2026-10-01 – 2026-10-05`，同日时只显示一个日期 */
function dateRangeText(start: string, end: string): string {
  return start === end ? start : `${start} – ${end}`;
}

function travelerText(count: number): string {
  return `${count} 人`;
}

export function buildFullPlan(input: BuildFullPlanInput): BuildFullPlanResult {
  const { plan, templateId = 'travel_full_plan_v1', assets = EMPTY_ASSET_LOOKUP } = input;

  // 按 day_number 排序而不是相信数组顺序 —— V-02 的乱序是 BLOCKING 违规，
  // 但修复发生在业务规则阶段；展示层排序是廉价的防御
  const sortedDays = [...plan.days].sort((a, b) => a.day_number - b.day_number);

  const built = sortedDays.map((day) =>
    buildDailyPoster({
      plan,
      dayNumber: day.day_number,
      // 各日 ViewModel 仍标为 DAILY_POSTER 的模板，因为它们的内容布局不变；
      // 完整页只是把它们串起来
      templateId: 'travel_infographic_v1',
      assets,
      /*
       * 3.3.1：完整页不裁剪内容，因此 content_limits 全为 null。
       *
       * 副作用是完整页可能出现「有内容但没有图」的条目 —— 第 4 张美食图
       * 没有对应槽位（槽位按每日限额生成，而 3.3.1 明确完整页
       * **不新增素材槽位**）。模板对此有占位分支，是可接受的结果：
       * 内容完整比配图完整重要，而多生成一张图要花真实的钱。
       */
      limits: FULL_PLAN_CONTENT_LIMITS,
    }),
  );

  const budget = plan.total_budget;
  /*
   * 与 `amountText` / `totalText` 共用一张符号表。P9 之前这里是
   * `currency === 'CNY' ? '¥' : currency` —— 币种只有 CNY 时两种写法等价，
   * 扩到 6 种之后它会在完整页显示「JPY 12000」而单日页显示「JP¥12000」。
   */
  const symbol = CURRENCY_SYMBOL[budget.currency];

  return {
    viewModel: {
      schema_version: 'travel_poster_view_model_v1',
      template_id: templateId,
      page_type: 'FULL_PLAN',
      plan_id: plan.plan_id,
      plan_version_id: plan.plan_version_id,
      day_number: null,

      overview: {
        title: plan.title,
        summary: plan.summary,
        destination: plan.destination.name,
        total_days: plan.total_days,
        date_range_text: dateRangeText(plan.start_date, plan.end_date),
        traveler_text: travelerText(plan.traveler_count),
        total_budget_text: `${symbol}${Math.round(budget.total)}`,
        per_person_text: `${symbol}${Math.round(budget.per_person)} / 人`,
      },

      days: built.map((b) => b.viewModel),
      icons: built[0]?.viewModel.icons ?? {
        schedule: '/icons/travel/calendar.svg',
        food: '/icons/travel/food.svg',
        map: '/icons/travel/map.svg',
        route: '/icons/travel/route.svg',
        camera: '/icons/travel/camera.svg',
        ticket: '/icons/travel/ticket.svg',
        budget: '/icons/travel/budget.svg',
        tips: '/icons/travel/tips.svg',
      },
    },
    budgetMismatch: built.some((b) => b.budgetMismatch),
  };
}
