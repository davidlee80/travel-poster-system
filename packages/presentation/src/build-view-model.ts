import {
  SCHEMA_VERSIONS,
  TEMPLATE_ID_VALUES,
  type HeroAsset,
  type TemplateId,
  type TravelPlan,
  type TravelPlanDay,
  type TravelPosterViewModel,
  type ViewImage,
} from '@tps/schemas';
import { COMPACT_LIMITS, toCompact } from './compact.js';
import { DAILY_CONTENT_LIMITS, applyLimit, type ContentLimits } from './content-limits.js';
import {
  BOOKING_CATEGORY_LABEL,
  MEAL_LABEL,
  PERIOD_LABEL,
  PREFERRED_TIME_LABEL,
  ROUTE_TYPE_LABEL,
  advanceText,
  amountText,
  dayLabel,
  durationText,
  periodIconName,
  priceText,
  totalText,
  transportIconName,
} from './derive.js';
import { moduleIcons } from './icons.js';
import { foodSlotId, heroSlotId, photoSpotSlotId, routeMapSlotId } from './slots.js';

/**
 * TravelPlan → TravelPosterViewModel（设计稿 12.1）。
 *
 * 素材以「按槽位查询」的形式注入，而不是让本模块自己去解析：
 * 展示编排器只回答「页面需要展示什么」，素材从哪来是素材服务的职责
 * （设计稿 3.3「它不负责查找图片」）。这个边界让 P1 能用桩素材跑通模板，
 * P3 换成真实解析结果时无需改动本模块。
 */

/** 单个槽位的解析结果。P3 由 `plan_asset_bindings` + `ResolvedAsset` 提供。 */
export interface SlotResolution {
  /** 图片类槽位的结果；未解析或降级到占位时为 null */
  readonly image: ViewImage | null;
  /** Hero 槽位专用（多了 source_type） */
  readonly hero?: HeroAsset | null;
  /** ROUTE_MAP 槽位专用；降级为文字路线时为 null（设计稿 8.2） */
  readonly svgUrl?: string | null;
}

/** 按槽位 ID 查询素材。返回 undefined 与返回 null 等价，均视为未解析。 */
export type AssetLookup = (slotId: string) => SlotResolution | undefined;

/** 全部槽位均未解析的查询器，供 P1 的纯文本/占位渲染使用 */
export const EMPTY_ASSET_LOOKUP: AssetLookup = () => undefined;

export interface BuildDailyPosterInput {
  readonly plan: TravelPlan;
  readonly dayNumber: number;
  readonly templateId?: TemplateId;
  readonly assets?: AssetLookup;
  /**
   * 3.3 的 `content_limits`。默认取每日海报的限额。
   *
   * 必须与 `requirementsForDay` 用同一份限额 —— 两处不一致时会解析出
   * 页面上不显示的图（多花钱），或显示一个没有解析过的槽位（空占位）。
   */
  readonly limits?: ContentLimits;
}

export class PresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresentationError';
  }
}

function findDay(plan: TravelPlan, dayNumber: number): TravelPlanDay {
  const day = plan.days.find((d) => d.day_number === dayNumber);
  if (!day) {
    throw new PresentationError(
      `计划 ${plan.plan_version_id} 中不存在第 ${dayNumber} 天。` +
        `已有天号: ${plan.days.map((d) => d.day_number).join(', ') || '(无)'}`,
    );
  }
  return day;
}

/**
 * 预算模块。
 *
 * 12.1 要求断言 `sum(items) === daily_budget.total` —— 预算数字对不上是
 * 用户可见的严重错误。这里**不抛错**而是以 `breakdown` 之和为准重算 total，
 * 因为 V-20 把这类不一致定为 REPAIRABLE；抛错等于把它升级成阻断。
 * 不一致的事实由返回值中的 `budgetMismatch` 上报，交由调用方记违规。
 */
function buildBudget(day: TravelPlanDay): {
  budget: TravelPosterViewModel['budget'];
  budgetMismatch: boolean;
} {
  const { breakdown, total, currency } = day.daily_budget;

  const items = breakdown.map((item) => ({
    label: item.label,
    amount_text: amountText({ amount: item.amount, currency }),
  }));

  const sum = breakdown.reduce((acc, item) => acc + item.amount, 0);
  const budgetMismatch = Math.abs(sum - total) > 0.005;

  return {
    budget: {
      items,
      // 以 breakdown 之和为准：items 是它逐条映射来的，两者必须自洽，
      // 否则页面上「各项相加 ≠ 总计」是用户一眼能看出的错误
      total_text: totalText(sum, currency),
    },
    budgetMismatch,
  };
}

export interface BuildResult {
  readonly viewModel: TravelPosterViewModel;
  /** `daily_budget.total` 与 `breakdown` 之和不一致（V-20），调用方应记违规 */
  readonly budgetMismatch: boolean;
  /**
   * 因 `content_limits` 被裁掉的条目数，按模块。
   *
   * 上报而不是静默丢弃：裁剪是编排层的决定，而页面上看不出「本来还有一条」。
   * 调用方据此打点（21.3），异常值说明限额与实际内容量长期不匹配。
   */
  readonly omitted: Readonly<
    Record<'schedule' | 'food' | 'photoSpot' | 'ticket' | 'bookingTip', number>
  >;
}

/** 构造单日信息图 ViewModel（page_type = DAILY_POSTER） */
export function buildDailyPoster(input: BuildDailyPosterInput): BuildResult {
  const {
    plan,
    dayNumber,
    templateId = TEMPLATE_ID_VALUES[0],
    assets = EMPTY_ASSET_LOOKUP,
    limits = DAILY_CONTENT_LIMITS,
  } = input;

  const day = findDay(plan, dayNumber);
  const { budget, budgetMismatch } = buildBudget(day);

  const schedule = applyLimit(day.schedule, limits.schedule_max_items);
  const foods = applyLimit(day.food_recommendations, limits.food_max_items);
  const spots = applyLimit(day.photo_spots, limits.photo_spot_max_items);
  const tickets = applyLimit(day.ticket_reminders, limits.ticket_max_items);
  const bookingTips = applyLimit(day.booking_tips, limits.booking_tip_max_items);

  const heroSlot = assets(heroSlotId(dayNumber));
  const routeSlot = assets(routeMapSlotId(dayNumber));

  const viewModel: TravelPosterViewModel = {
    schema_version: SCHEMA_VERSIONS.travelPosterViewModel,
    template_id: templateId,
    page_type: 'DAILY_POSTER',
    plan_id: plan.plan_id,
    plan_version_id: plan.plan_version_id,
    day_number: dayNumber,

    header: {
      /*
       * P9：单日海报显示**这一天所在的城市**，不是 plan 级目的地。
       *
       * 多城行程里两者不同。单日海报是一张「第 4 天在哪、做什么」的图，
       * 上面写着东京而当天在京都是直接的错误信息 —— 而这一页的其余内容
       * （行程、美食、机位）全部来自京都，因此错的只有标题那一个词，
       * 最不容易被发现。
       *
       * 单城行程（含全部存量计划）里 `day.city === plan.destination.name`，
       * 因此这一改动对它们完全无影响 —— 视觉基线不受影响。
       */
      destination: day.city,
      total_days: plan.total_days,
      day_label: dayLabel(dayNumber),
      title: day.theme,
      title_compact: toCompact(day.theme, limits.title_max_chars ?? COMPACT_LIMITS.title),
      subtitle: day.subtitle,
      subtitle_compact: toCompact(
        day.subtitle,
        limits.subtitle_max_chars ?? COMPACT_LIMITS.subtitle,
      ),
      hero_asset: heroSlot?.hero ?? null,
    },

    schedule: schedule.map((item) => ({
      period: PERIOD_LABEL[item.period],
      period_icon: periodIconName(item.period),
      title: item.title,
      description: item.description,
      description_compact: toCompact(item.description, COMPACT_LIMITS.scheduleDescription),
      duration_text: durationText(item.duration_minutes),
    })),

    food_cards: foods.map((food) => ({
      meal: MEAL_LABEL[food.meal],
      name: food.name,
      description: food.description,
      description_compact: toCompact(food.description, COMPACT_LIMITS.foodDescription),
      image: assets(foodSlotId(dayNumber, food.meal))?.image ?? null,
    })),

    route_map: {
      // svg_url 为 null 时模板渲染 nodes 文字列表（设计稿 8.2 text_fallback）
      svg_url: routeSlot?.svgUrl ?? null,
      /*
       * nodes 始终提供 —— 它既是地图的节点来源，也是降级时的文字路线。
       * 取裁剪后的 schedule：地图上的点必须与「今日行程」列出的点一致，
       * 否则用户会在图里看到一个行程里没有的地方。
       */
      nodes: schedule.map((s) => s.location.name),
    },

    route_recommendations: day.route_recommendations.map((route) => ({
      type: route.type,
      label: ROUTE_TYPE_LABEL[route.type],
      nodes: [...route.nodes],
    })),

    must_do: [...day.must_do],

    transport_tips: day.transport_tips.map((tip) => ({
      text: tip.text,
      icon: transportIconName(tip.mode),
    })),

    photo_spots: spots.map((spot, index) => ({
      name: spot.name,
      time_text: PREFERRED_TIME_LABEL[spot.preferred_time],
      image: assets(photoSpotSlotId(dayNumber, index))?.image ?? null,
    })),

    ticket_reminders: tickets.map((reminder) => ({
      entity_name: reminder.entity_name,
      text: reminder.text,
      price_text: priceText(reminder.price),
      advance_text: advanceText(reminder.advance_days),
    })),

    budget,

    booking_tips: bookingTips.map((tip) => ({
      text: tip.text,
      category_text: BOOKING_CATEGORY_LABEL[tip.category],
    })),

    daily_summary: day.daily_summary,
    daily_summary_compact: toCompact(day.daily_summary, COMPACT_LIMITS.dailySummary),

    icons: moduleIcons(),
  };

  return {
    viewModel,
    budgetMismatch,
    omitted: {
      schedule: day.schedule.length - schedule.length,
      food: day.food_recommendations.length - foods.length,
      photoSpot: day.photo_spots.length - spots.length,
      ticket: day.ticket_reminders.length - tickets.length,
      bookingTip: day.booking_tips.length - bookingTips.length,
    },
  };
}
