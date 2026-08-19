import { z } from 'zod';

import { AspectRatioSchema } from './asset-requirement.js';
import { AiAssetTypeSchema, VisualBriefTaskSchema } from './enums.js';
import { NonEmptyStringSchema } from './primitives.js';

/**
 * AI 图片生成的契约（TP-4-01/04，设计稿 11.1、11.3、14.3、二十章）。
 *
 * ## 为什么 Brief 是一个独立契约，而不是「拼一段提示词」
 *
 * 11.1 的原话是「图片模型接收的不是整个旅行计划，而是标准化的视觉 Brief」。
 * 这不是措辞讲究：二十章要求 `generation_metadata.visual_brief` 存下
 * **完整 Brief** 作为「为什么这张图不对」的唯一排查依据。如果 Brief 只以
 * 提示词字符串的形式存在，那么落库的就是一段自然语言 —— 排查时无法回答
 * 「当时的 elements 是哪几个」「比例约束传的是什么」这类结构性问题。
 *
 * 因此这里定义结构，提示词由结构渲染而来（见 `@tps/assets` 的 visual-brief）。
 *
 * ## Brief 里不允许出现用户私有内容
 *
 * 二十章：`visual_brief` 「只含目的地与主题，不含用户 ID、日期或预算」。
 * 结构上就没有这些字段 —— 这比「约定不要放」可靠。字段名是白名单，
 * 多传的键会被 Zod 剥掉（`strip` 是默认行为），因此调用方即使拼错也进不去。
 *
 * ## 11.3 的五条禁止项落在两个不同的层
 *
 * ```text
 * 不绘制标题 / 门票价格 / 地图文字 / 品牌 Logo  → 负向提示词（本文件 + @tps/assets）
 * 不把 AI 景点图标记成真实照片                  → representation_type 与数据库 CHECK
 * ```
 * 前四条只能「尽力要求」，模型仍可能违反；最后一条是我们自己的标记行为，
 * 必须**强制**成立 —— 迁移 0005 的 `assets_ai_must_be_illustrative` 就是它。
 */

// ── 11.1 视觉 Brief ─────────────────────────────────────────

/**
 * 版面约束。
 *
 * `reserved_text_area` 只有 Hero 需要（模板在左上角压标题与日期，
 * 那块区域必须留白，否则文字压在建筑上不可读）。景点图与美食图是卡片内的
 * 配图，模板不在图上压字，因此取 `NONE`。
 */
export const BriefLayoutSchema = z.object({
  reserved_text_area: z.enum(['LEFT_TOP', 'NONE']),
  subject_area: z.enum(['RIGHT_AND_BOTTOM', 'CENTER']),
  aspect_ratio: AspectRatioSchema,
});
export type BriefLayout = z.infer<typeof BriefLayoutSchema>;

export const VisualBriefSchema = z.object({
  task: VisualBriefTaskSchema,
  destination: NonEmptyStringSchema,
  /** Hero 的主题短语；景点/美食图为该实体名。两者都不是用户输入的自由文本 */
  theme: NonEmptyStringSchema,
  /** 11.1 的画面元素。空数组合法（模型据 theme 自行发挥），但不接受空串 */
  elements: z.array(NonEmptyStringSchema),
  /** 英文风格短语。中文风格枚举（`VISUAL_STYLE`）在这里已翻译完成 */
  style: NonEmptyStringSchema,
  palette: z.array(NonEmptyStringSchema),
  layout: BriefLayoutSchema,
  /** 11.3 的禁止项。至少一条 —— 空数组说明构造函数出了问题 */
  negative_requirements: z.array(NonEmptyStringSchema).min(1),
});
export type VisualBrief = z.infer<typeof VisualBriefSchema>;

// ── 二十章：generation_metadata ─────────────────────────────

/**
 * `assets.generation_metadata` 的固定结构（二十章 R-11 补充）。
 *
 * 十五章要求 `source_type = 'AI_GENERATED'` 时该列非空，迁移 0005 用
 * `assets_ai_metadata_check` 强制。这个 schema 是那条 CHECK 的应用层对应物：
 * CHECK 只能验「非空」，验不了「有没有 seed」。
 *
 * `cost_units` 支撑 21.4 的成本核算；`seed` 与 `prompt_template_version`
 * 一起保证产物可复现 —— **前提是图片供应商支持 seed**。不支持时我们记录的
 * 是「请求时传了什么」而不是「产物由什么决定」，这一点写在这里而不是
 * 让排查的人自己去发现（见 `@tps/llm` 的 image.ts）。
 */
export const GenerationMetadataSchema = z.object({
  generated_model: NonEmptyStringSchema,
  model_version: NonEmptyStringSchema,
  /** ISO 8601。用字符串而不是 Date：它要原样进 JSONB */
  generated_at: NonEmptyStringSchema,
  prompt_template_version: NonEmptyStringSchema,
  visual_brief: VisualBriefSchema,
  negative_requirements: z.array(NonEmptyStringSchema).min(1),
  seed: z.number().int().nonnegative(),
  cost_units: z.number().nonnegative(),
  /** 19.2 的缓存键。生成物一定带键 —— 不带键的 AI 图永远不会被复用 */
  cache_key: NonEmptyStringSchema,
});
export type GenerationMetadata = z.infer<typeof GenerationMetadataSchema>;

/**
 * 搜索入库图的来源元数据（9.6 / R-46，迁移 0008 的 `assets.source_metadata`）。
 *
 * 与 `GenerationMetadataSchema` 对称：数据库的 CHECK 保证「有」
 * （`LICENSED_SOURCE ⇒ 非空`），这个 schema 保证「全」。
 *
 * 9.6 逐项点名了四类内容：provider、original_url、检索词、
 * license 原文与到期日。**四项全是必填**（到期日可为 null 但键必须在）——
 * 少任何一项，「素材可追踪来源」（验收标准 12）对搜索图就是空话，
 * 版权争议时也无从举证。
 */
export const SourceMetadataSchema = z.object({
  /** 图源名，必须来自 `IMAGE_SEARCH_PROVIDERS` 白名单 */
  provider: NonEmptyStringSchema,
  /** 图源上的页面地址（不是下载直链 —— 后者会过期，举证要的是可访问的出处） */
  original_url: NonEmptyStringSchema,
  /** 触发本次入库的检索词。排查「这张图为什么被挂到这个 POI 下」的起点 */
  search_query: NonEmptyStringSchema,
  /** 图源返回的授权类型原文 */
  license: NonEmptyStringSchema,
  /** ISO 8601 或 null（永久授权）。同时写入 `assets.license_expires_at` */
  license_expires_at: z.string().nullable(),
  /** ISO 8601。入库时刻 */
  retrieved_at: NonEmptyStringSchema,
});
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

// ── 14.3 的请求与响应 ───────────────────────────────────────

/**
 * `POST /internal/v1/assets/generate` 的请求体。
 *
 * 14.3 只规定了「该接口只允许受控的素材类型」，没给请求体。这里把
 * 「受控类型」做成必填的独立字段而不是从 `brief.task` 反推：
 * 两者是不同的轴 —— 类型说的是「产物在库里算哪一类」（进
 * `assets`/配额统计），task 说的是「模型该画什么」。用一个推另一个的话，
 * 新增一种 task 就会静默落进某个既有类型的统计里。
 */
export const AiAssetGenerateRequestSchema = z.object({
  asset_type: AiAssetTypeSchema,
  brief: VisualBriefSchema,
  /** 19.2 的缓存键。由调用方算，因为键规则依赖角色与主题桶（19.1） */
  cache_key: NonEmptyStringSchema,
  /** 10.1 的 `resolution_score` 下限，同时是 11.2 第 2 步的校验口径 */
  min_width: z.number().int().positive(),
});
export type AiAssetGenerateRequest = z.infer<typeof AiAssetGenerateRequestSchema>;

export const AiAssetGenerateResponseSchema = z.object({
  asset_id: z.string().uuid(),
  /** 已存在同键素材时为 false（13.8 的并发去重命中，或 19.5 的跨计划复用） */
  created: z.boolean(),
  url: NonEmptyStringSchema,
  thumbnail_url: NonEmptyStringSchema.nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  generation_metadata: GenerationMetadataSchema,
});
export type AiAssetGenerateResponse = z.infer<typeof AiAssetGenerateResponseSchema>;
