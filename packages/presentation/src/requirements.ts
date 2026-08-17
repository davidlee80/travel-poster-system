import {
  SCHEMA_VERSIONS,
  type AssetRequirement,
  type AssetRequirementItem,
  type TemplateId,
  type TravelPlan,
  type TravelPlanDay,
} from '@tps/schemas';
import { applyLimit, type ContentLimits } from './content-limits.js';
import { foodSlotId, heroSlotId, photoSpotSlotId, routeMapSlotId } from './slots.js';

/**
 * 槽位生成与跨页合并（TP-3-04，设计稿七章 + 3.3.1）。
 *
 * ## 每天四类槽位，数量随内容而定
 *
 * ```text
 * day_N.hero_background   1 个，必需（16.3）
 * day_N.route_map         1 个，必需（16.3）
 * day_N.food.{meal}       每条美食推荐 1 个，按餐次命名
 * day_N.photo_spot.{i}    每个拍照机位 1 个，1 起序号
 * ```
 *
 * 条数受 `content_limits` 约束 —— 模板只显示 3 张美食图时生成 4 个槽位，
 * 等于多花一次检索（乃至一次 AI 生成）去解析一张不会出现在页面上的图。
 *
 * ## 视觉约束的取值来自七章示例
 *
 * | 角色              | 比例 | 最小宽度 |
 * | ----------------- | ---- | -------- |
 * | HERO_BACKGROUND   | 16:6 | 1600     |
 * | FOOD_IMAGE        | 4:3  | 600      |
 * | DESTINATION_PHOTO | 16:9 | 800      |
 * | ROUTE_MAP         | 3:2  | 1200     |
 *
 * 路线图的 3:2 取自 8.2 的示例产物（1200×800）。这些值同时进缓存键
 * （19.2 的 `{aspect_ratio}` 段），改动等于让旧缓存全部失效，
 * 因此必须集中在这一处而不是散落在各调用点。
 */

const HERO_CONSTRAINTS = {
  aspect_ratio: '16:6',
  min_width: 1600,
  style: 'CHINESE_TRAVEL_EDITORIAL',
  // 11.3：不让 AI 在图里写标题、画价格、加 Logo
  avoid_text: true,
  avoid_logo: true,
} as const;

const FOOD_CONSTRAINTS = {
  aspect_ratio: '4:3',
  min_width: 600,
  style: 'REALISTIC_FOOD_PHOTOGRAPHY',
} as const;

const PHOTO_CONSTRAINTS = { aspect_ratio: '16:9', min_width: 800 } as const;

const ROUTE_MAP_CONSTRAINTS = { aspect_ratio: '3:2', min_width: 1200 } as const;

/**
 * 拍照机位对应的 `place_id`。
 *
 * V-42 保证 `photo_spots[].entity_name` 能在当日 `schedule[].location.name`
 * 中找到，因此这里一定能拿到那个地点的 `place_id`（可能为 null）。
 * 19.2 的景点图缓存键以 `place_id` 为主键段 —— 拿名称当键会因为
 * LLM 措辞变化（「拱宸桥」/「拱宸桥历史街区」）产生不同的键，缓存永不命中。
 */
function placeIdFor(day: TravelPlanDay, entityName: string): string | null {
  return day.schedule.find((item) => item.location.name === entityName)?.location.place_id ?? null;
}

export interface DayRequirementsInput {
  readonly plan: TravelPlan;
  readonly day: TravelPlanDay;
  readonly limits: ContentLimits;
}

/** 生成单日的全部槽位（顺序固定：hero → route_map → food → photo_spot） */
export function requirementsForDay(input: DayRequirementsInput): AssetRequirementItem[] {
  const { plan, day, limits } = input;
  const dayNumber = day.day_number;
  const destination = plan.destination;

  const items: AssetRequirementItem[] = [
    {
      slot_id: heroSlotId(dayNumber),
      role: 'HERO_BACKGROUND',
      asset_type: 'AI_ILLUSTRATION',
      required: true,
      subject: {
        destination: destination.name,
        destination_place_id: destination.place_id,
        // Hero 没有 entity_name —— 它表达主题而非具体地点（10.1 因此按 0.5 中性值计入）
        theme: day.theme,
        entities: day.schedule.map((item) => item.location.name),
      },
      visual_constraints: HERO_CONSTRAINTS,
    },
    {
      slot_id: routeMapSlotId(dayNumber),
      role: 'ROUTE_MAP',
      asset_type: 'GENERATED_SVG',
      required: true,
      route_data: {
        /*
         * 坐标原样带上，包括 null —— V-08 把越界坐标修复为 null，
         * 剔除发生在渲染器里（TP-3-10「坐标非法节点被剔除」）。
         * 在这里剔除会让「节点不足 2 个」的判断丢掉上下文：
         * 渲染器需要知道原本有几个节点才能决定降级成文字列表还是不出图。
         */
        nodes: day.schedule.map((item) => ({
          name: item.location.name,
          latitude: item.location.latitude,
          longitude: item.location.longitude,
        })),
        style: 'CANAL_GREEN',
      },
      visual_constraints: ROUTE_MAP_CONSTRAINTS,
    },
  ];

  for (const food of applyLimit(day.food_recommendations, limits.food_max_items)) {
    items.push({
      slot_id: foodSlotId(dayNumber, food.meal),
      role: 'FOOD_IMAGE',
      asset_type: 'PHOTO_OR_AI',
      required: false,
      subject: {
        destination: destination.name,
        destination_place_id: destination.place_id,
        entity_name: food.name,
      },
      visual_constraints: FOOD_CONSTRAINTS,
    });
  }

  /*
   * 序号必须按**原数组下标**，不能按截断后的下标 ——
   * `photoSpotSlotId` 的序号要与 ViewModel 里 `photo_spots[]` 的下标对齐，
   * 否则第 2 个机位会去取第 1 个槽位的图（模板按同一下标回填）。
   */
  const spots = applyLimit(day.photo_spots, limits.photo_spot_max_items);
  spots.forEach((spot, index) => {
    items.push({
      slot_id: photoSpotSlotId(dayNumber, index),
      role: 'DESTINATION_PHOTO',
      asset_type: 'REAL_PHOTO_PREFERRED',
      required: false,
      subject: {
        destination: destination.name,
        destination_place_id: destination.place_id,
        entity_name: spot.entity_name,
        entity_place_id: placeIdFor(day, spot.entity_name),
      },
      visual_constraints: PHOTO_CONSTRAINTS,
    });
  });

  return items;
}

/**
 * 跨页合并去重（3.3.1：素材解析时把 N+1 页的槽位合并后一次性提交给 14.1）。
 *
 * 槽位 ID 天然带 `day_N` 前缀，因此正常情况下不会重复；
 * 这个函数的价值在于**重复时不静默通过** —— `AssetRequirementSchema` 拒绝
 * 重复的 `slot_id`（一次请求里两个同 ID 槽位会让后者覆盖前者，
 * 表现是「早餐图出现在晚餐位置」，而两个槽位都「解析成功」）。
 * 保留首次出现的那个，并把重复计数返回给调用方记日志。
 */
export interface MergeResult {
  readonly requirements: readonly AssetRequirementItem[];
  /** 被丢弃的重复槽位 ID（正常为空数组） */
  readonly duplicates: readonly string[];
}

export function mergeRequirements(
  pages: readonly { readonly asset_requirements: readonly AssetRequirementItem[] }[],
): MergeResult {
  const seen = new Map<string, AssetRequirementItem>();
  const duplicates: string[] = [];

  for (const page of pages) {
    for (const item of page.asset_requirements) {
      if (seen.has(item.slot_id)) {
        duplicates.push(item.slot_id);
        continue;
      }
      seen.set(item.slot_id, item);
    }
  }

  return { requirements: [...seen.values()], duplicates };
}

/** 套上 14.1 的请求信封（七章的 `plan_id` / `plan_version_id` 层） */
export function assetRequirementEnvelope(input: {
  readonly planId: string;
  readonly planVersionId: string;
  readonly templateId: TemplateId;
  readonly requirements: readonly AssetRequirementItem[];
}): AssetRequirement {
  return {
    schema_version: SCHEMA_VERSIONS.assetRequirement,
    plan_id: input.planId,
    plan_version_id: input.planVersionId,
    template_id: input.templateId,
    requirements: [...input.requirements],
  };
}
