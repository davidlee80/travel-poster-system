import { z } from 'zod';
import {
  AssetRoleSchema,
  MapStyleSchema,
  RequirementAssetTypeSchema,
  TemplateIdSchema,
  VisualStyleSchema,
} from './enums.js';
import { NonEmptyStringSchema } from './primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * AssetRequirement —— 展示编排器交给素材服务的槽位清单（设计稿七章）。
 *
 * ## 这里可以严格，而且必须严格
 *
 * 与 `TravelPlan` 相反：槽位清单是**我们自己的代码**生成的，不是模型输出。
 * 任何不一致都是程序缺陷，越早拒绝越好。因此比例格式、坐标范围、
 * 角色与类型的搭配全部在 schema 层拦住。
 *
 * ## 三处结构决定
 *
 * 1. **`slot_id` 是跨模块唯一约定**，也是 `plan_asset_bindings` 唯一约束的
 *    组成部分（`UNIQUE(plan_version_id, template_id, slot_id)`）。
 *    生成规则在 `@tps/presentation` 的 slots.ts，格式 `day_3.food.breakfast`。
 * 2. **`subject` 与 `route_data` 互斥**：`ROUTE_MAP` 只需要节点坐标，
 *    其余角色只需要实体与目的地。用一个可选字段的联合而不是把两者都设为
 *    可选，是为了让「路线图槽位没带节点」变成校验失败而不是空图。
 * 3. **信封与单页子集是同一个 `requirements[]`**（3.3.1）：
 *    `PresentationPlan.asset_requirements` 是单页的槽位，
 *    合并去重后套上这个信封提交给 14.1。
 */

// ── 视觉约束 ────────────────────────────────────────────────

/**
 * 画面比例，`宽:高` 形式（七章示例 `16:6`、`4:3`、`16:9`）。
 *
 * 保留字符串而不是直接存 number：`16:6` 要原样进缓存键（19.1 转成 `16x6`），
 * 而 2.6667 反推不回 `16:6`。数值形式由 `aspectRatioValue` 现算。
 */
export const AspectRatioSchema = z
  .string()
  .regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/, '比例必须为 `宽:高` 形式，如 16:9');
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** `16:6` → 2.6667。10.1 的 `aspect_ratio_score` 与 11.2 的比例检查都用它 */
export function aspectRatioValue(ratio: AspectRatio): number {
  const [width, height] = ratio.split(':');
  return Number(width) / Number(height);
}

export const VisualConstraintsSchema = z.object({
  aspect_ratio: AspectRatioSchema,
  /** 10.1 的 `resolution_score` 以此为硬性下限：低于它直接 0 分 */
  min_width: z.number().int().positive(),
  style: VisualStyleSchema.nullish(),
  /** 11.1 的负向要求。景点/美食槽位不设，Hero 必设（11.3） */
  avoid_text: z.boolean().nullish(),
  avoid_logo: z.boolean().nullish(),
});
export type VisualConstraints = z.infer<typeof VisualConstraintsSchema>;

// ── 主体 ────────────────────────────────────────────────────

/**
 * 槽位主体。
 *
 * `entity_name` 可缺省 —— `HERO_BACKGROUND` 表达的是主题而不是某个地点。
 * 10.1 因此规定 `entity_match` 在缺省时按 **0.5 中性值**计入，
 * 否则权重最大的一项归零，Hero 永远走不到素材库。
 */
export const AssetSubjectSchema = z.object({
  destination: NonEmptyStringSchema,
  /** 优先于名称用于缓存键与检索过滤（19.1） */
  destination_place_id: z.string().nullish(),
  entity_name: z.string().nullish(),
  /** 景点槽位的稳定标识，进景点图缓存键（19.2 `place:v1:{place_id}:...`） */
  entity_place_id: z.string().nullish(),
  /** Hero 专用：LLM 生成的中文主题短语，归桶后进缓存键（19.1） */
  theme: z.string().nullish(),
  /** 11.1 的 `elements`，同时作为语义检索的查询词来源（10.1） */
  entities: z.array(NonEmptyStringSchema).nullish(),
});
export type AssetSubject = z.infer<typeof AssetSubjectSchema>;

// ── 路线数据 ────────────────────────────────────────────────

/**
 * 路线节点。
 *
 * 坐标可为 null：V-08 把越界坐标修复为置 null，该节点因此退出路线图
 * （TP-3-10「坐标非法节点被剔除」）。剔除发生在渲染器里而不是这里 ——
 * schema 拒绝 null 会让「有一个节点坐标缺失」升级成「整个槽位不合法」。
 */
export const RouteNodeSchema = z.object({
  name: NonEmptyStringSchema,
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
});
export type RouteNode = z.infer<typeof RouteNodeSchema>;

export const RouteDataSchema = z.object({
  nodes: z.array(RouteNodeSchema),
  style: MapStyleSchema,
});
export type RouteData = z.infer<typeof RouteDataSchema>;

// ── 单个槽位 ────────────────────────────────────────────────

/** 角色 → 允许的需求类型。九章四条决策规则的编译期表达 */
export const ROLE_ASSET_TYPE: Record<
  z.infer<typeof AssetRoleSchema>,
  z.infer<typeof RequirementAssetTypeSchema>
> = {
  // 9.3：Hero 可以用 AI，它表达氛围而非精确导航信息
  HERO_BACKGROUND: 'AI_ILLUSTRATION',
  // 9.5：美食图真实性要求低于建筑照片，更适合 AI 兜底
  FOOD_IMAGE: 'PHOTO_OR_AI',
  // 9.4：景点优先真实照片；AI 图必须标 ILLUSTRATIVE 并显示「示意图」
  DESTINATION_PHOTO: 'REAL_PHOTO_PREFERRED',
  // 9.2：不调用图片模型
  ROUTE_MAP: 'GENERATED_SVG',
};

/** 16.3：只有这两个角色是必需素材，且两者都有到底的降级链 */
export const REQUIRED_ROLES = ['HERO_BACKGROUND', 'ROUTE_MAP'] as const;

export const AssetRequirementItemSchema = z
  .object({
    slot_id: NonEmptyStringSchema,
    /**
     * 所属天号。
     *
     * 七章的示例里没有这个字段（槽位 ID 已含 `day_3.` 前缀），但它是必要的：
     *   - `plan_asset_bindings.day_number` 要写它；
     *   - 21.2 的并发模型是「天级 8、单天内槽位 6」，分组需要天号。
     * 从 `slot_id` 反解字符串前缀能得到同样的值，代价是槽位命名规则
     * 变成两处依赖 —— 改一次命名就要同步改解析。显式字段没有这个耦合。
     */
    day_number: z.number().int().positive(),
    role: AssetRoleSchema,
    asset_type: RequirementAssetTypeSchema,
    required: z.boolean(),
    subject: AssetSubjectSchema.nullish(),
    route_data: RouteDataSchema.nullish(),
    visual_constraints: VisualConstraintsSchema,
  })
  .refine((item) => item.asset_type === ROLE_ASSET_TYPE[item.role], {
    message: '角色与素材类型的搭配必须符合九章的来源决策规则',
    path: ['asset_type'],
  })
  .refine(
    (item) =>
      item.role === 'ROUTE_MAP'
        ? item.route_data !== null && item.route_data !== undefined
        : item.subject !== null && item.subject !== undefined,
    {
      message: 'ROUTE_MAP 槽位必须带 route_data，其余角色必须带 subject',
      path: ['route_data'],
    },
  )
  .refine((item) => item.required === (REQUIRED_ROLES as readonly string[]).includes(item.role), {
    message: '必需素材只有 HERO_BACKGROUND 与 ROUTE_MAP（16.3）',
    path: ['required'],
  });
export type AssetRequirementItem = z.infer<typeof AssetRequirementItemSchema>;

// ── 批量解析信封（14.1 的请求体）────────────────────────────

export const AssetRequirementSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSIONS.assetRequirement),
    plan_id: NonEmptyStringSchema,
    plan_version_id: NonEmptyStringSchema,
    template_id: TemplateIdSchema,
    requirements: z.array(AssetRequirementItemSchema),
  })
  /*
   * 槽位 ID 在一次请求内必须唯一。
   *
   * 这条不是形式主义：14.1 的响应按 slot_id 回填到 ViewModel，
   * 重复的 slot_id 会让后一个静默覆盖前一个 —— 症状是「某一天的早餐图
   * 出现在晚餐位置」，而两个槽位都「解析成功」。
   * 3.3.1 的跨页合并去重（TP-3-04）正是为了避免它，这里是那步的断言。
   */
  .refine(
    (envelope) =>
      new Set(envelope.requirements.map((item) => item.slot_id)).size ===
      envelope.requirements.length,
    { message: 'slot_id 不得重复（3.3.1 跨页合并需去重）', path: ['requirements'] },
  );
export type AssetRequirement = z.infer<typeof AssetRequirementSchema>;
