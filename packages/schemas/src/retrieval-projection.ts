import { z } from 'zod';

import { FoodEntityTypeSchema, PeriodSchema } from './enums.js';
import { NonEmptyStringSchema } from './primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * 脱敏投影（TP-2-20，设计稿 3.2.4、15.2、二十章 L2）。
 *
 * ## 这个结构是隐私边界，不是数据传输对象
 *
 * 3.2.4 的历史检索**跨用户、跨身份**：匿名用户 A 的杭州计划会进入注册用户 B
 * 的生成上下文。因此检索路径只允许读这一列，`plan_json` 在检索路径上完全
 * 不可达（15.2 用列级 `GRANT` 把这一点落到数据库层）。
 *
 * ## 白名单，不是黑名单
 *
 * 本 schema 只列 3.2.4 表格里标「是」的字段。任何**未列出**的字段都不进投影，
 * 包括表格没提到的 `title`、`daily_summary`、`must_do`、`photo_spots`、
 * `transport_tips`、`ticket_reminders`、`booking_tips`。
 *
 * 这个方向是刻意的。黑名单（「把敏感字段剔掉，其余都带上」）的失效模式是
 * **沉默的**：`TravelPlan` 以后新增一个字段，它会自动流进投影，而没有任何
 * 测试会失败 —— 直到有人发现别人的行程细节出现在自己的生成结果里。
 * 白名单的失效模式是「新字段没进投影，检索质量略降」，可以慢慢发现。
 *
 * 因此**给投影加字段必须先改设计稿 3.2.4 的表格**，不是改代码顺手加一行。
 *
 * ## 为什么没有 day_number
 *
 * 3.2.4 的表格里没有它，而 `days` 是有序数组 —— 第几天由下标表达。
 * 「不在表格里的字段一律不进」这条规则对每个字段一视同仁，
 * 包括看起来完全无害的那些。
 */

/** 地点：名称 + place_id。3.2.4 明确「POI 序列是核心可复用知识」 */
const ProjectionPlaceSchema = z.object({
  name: NonEmptyStringSchema,
  place_id: z.string().nullable(),
});

const ProjectionScheduleItemSchema = z.object({
  title: NonEmptyStringSchema,
  period: PeriodSchema,
  duration_minutes: z.number().int(),
  /** 3.2.4：已由 V-45 清洗，不含用户输入 */
  description: z.string(),
  location: ProjectionPlaceSchema,
});

const ProjectionDaySchema = z.object({
  theme: z.string(),
  subtitle: z.string(),
  schedule: z.array(ProjectionScheduleItemSchema),
  food_recommendations: z.array(
    z.object({
      name: NonEmptyStringSchema,
      entity_type: FoodEntityTypeSchema,
    }),
  ),
  /** 只要节点序列。`type` 与 `title` 不在 3.2.4 的表格里 */
  route_recommendations: z.array(z.object({ nodes: z.array(NonEmptyStringSchema) })),
});

export const RetrievalProjectionSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.retrievalProjection),
  destination: ProjectionPlaceSchema,
  /** 3.2.4：用于筛选相近长度的行程（±3 天） */
  total_days: z.number().int(),
  days: z.array(ProjectionDaySchema),
});

export type RetrievalProjection = z.infer<typeof RetrievalProjectionSchema>;
export type ProjectionDay = z.infer<typeof ProjectionDaySchema>;
export type ProjectionScheduleItem = z.infer<typeof ProjectionScheduleItemSchema>;

/**
 * 投影里**绝不允许出现**的键名（3.2.4 的「否」行 + 二十章 L1）。
 *
 * 单独列出来供运行期扫描使用：类型系统能保证「我们构造的对象没有这些键」，
 * 但保证不了「从数据库读回来的历史行没有」—— 投影规则修订前写入的行、
 * 或某次手工修数据留下的行，都可能带着旧字段。跨用户读取前扫一遍是廉价的。
 */
export const FORBIDDEN_PROJECTION_KEYS = [
  'user_id',
  'plan_id',
  'plan_version_id',
  'request_id',
  'start_date',
  'end_date',
  'date',
  'traveler_count',
  'children',
  'seniors',
  'has_child',
  'has_senior',
  'budget',
  'total_budget',
  'daily_budget',
  'estimated_cost',
  'price',
  'currency',
  'custom_requirements',
  'raw_text',
  'custom_text',
  'constraint_report',
  'assumptions',
  'email',
] as const;

/**
 * 递归查找投影中出现的禁止键。
 *
 * 返回全部命中而不是第一个：修订投影规则时需要一次看到所有漏网字段。
 */
export function findForbiddenProjectionKeys(value: unknown, path = ''): string[] {
  const forbidden = new Set<string>(FORBIDDEN_PROJECTION_KEYS);
  const hits: string[] = [];

  const walk = (node: unknown, current: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${current}[${index}]`);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, child] of Object.entries(node)) {
      const next = current === '' ? key : `${current}.${key}`;
      if (forbidden.has(key)) hits.push(next);
      walk(child, next);
    }
  };

  walk(value, path);
  return hits;
}
