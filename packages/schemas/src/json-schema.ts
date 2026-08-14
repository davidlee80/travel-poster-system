import { z } from 'zod';
import { TravelPlanLlmOutputSchema, TravelPlanSchema } from './travel-plan.js';

/**
 * JSON Schema 导出（设计稿 6.3）。
 *
 * 大模型的结构化输出需要 JSON Schema 而不是 Zod 对象。用 Zod 4 内置的
 * `z.toJSONSchema()`，因此**一份 Zod 定义同时服务运行期校验与模型约束** ——
 * 这正是选全 TypeScript 的核心理由（设计稿 22.1）：契约不必维护两份。
 *
 * `io: 'input'` 让导出的 schema 描述**输入**形态。对本项目的 schema 而言
 * 输入输出一致（没有 transform / default），显式声明是为了在将来引入
 * 默认值时不至于把「输出才有的字段」当成模型必须提供的字段。
 */

/** 交给大模型的 schema：不含程序注入的 ID、`schema_version` 与 `status` */
export const travelPlanLlmOutputJsonSchema = z.toJSONSchema(TravelPlanLlmOutputSchema, {
  io: 'input',
  target: 'draft-2020-12',
});

/** 完整 TravelPlan 的 JSON Schema，供契约文档与外部校验工具使用 */
export const travelPlanJsonSchema = z.toJSONSchema(TravelPlanSchema, {
  io: 'input',
  target: 'draft-2020-12',
});
