import { z } from 'zod';

import { ExportFormatSchema, ExportScopeSchema, TemplateIdSchema } from './enums.js';
import { NonEmptyStringSchema } from './primitives.js';

/**
 * 导出契约（TP-4-12/13，设计稿 13.5、13.6）。
 *
 * ## `day_numbers` 是数组而不是标量
 *
 * 13.5 的 R-07 补充说得很清楚：「数组而非标量，为 V2 的多选天导出预留」。
 * V1 只允许长度 1（`SINGLE_DAY`），其余必须为 null —— 这条约束同时存在于
 * 这里、数据库的 `exports_day_numbers_check`（含 R-18 的三值逻辑修正）
 * 与 API 的校验里。三处都有是有意的：schema 挡住程序缺陷，
 * CHECK 挡住绕过应用层的写入，API 给出带 `field` 的 400。
 */

// ── 13.5 请求 ───────────────────────────────────────────────

export const CreateExportRequestSchema = z
  .object({
    format: ExportFormatSchema,
    /**
     * 样式套件。**可缺省**（R-85）—— 缺省时服务端取这份计划自己的套件。
     *
     * 不给它一个 Zod 默认值（比如 `TEMPLATE_ID_VALUES[0]`）：导出必须用
     * **生成时那一套**，而全局默认在计划用了别的套件时会指向一份不存在的
     * 展示数据 —— 然后被 `EXPORT_TEMPLATE_UNAVAILABLE` 拒掉，而客户端根本
     * 没提过模板，那个报错毫无道理。
     *
     * 因此默认值必须在**路由里**解析（从 `plan_presentations` 读），
     * 而不是在 schema 里填一个常量。
     */
    template_id: TemplateIdSchema.optional(),
    scope: ExportScopeSchema,
    /** `SINGLE_DAY` 时必填且长度为 1；其余必须为 null（13.5） */
    day_numbers: z.array(z.number().int().min(1).max(14)).nullish(),
    /**
     * 指定要导出的版本。缺省取计划的当前版本。
     *
     * 显式传入的意义是 13.7 的 `EXPORT_PLAN_VERSION_MISMATCH`：用户在
     * 「查看计划」页面点导出，而此刻计划刚好被重新生成 —— 他要的是屏幕上
     * 那一版，不是刚出现的新版本。不带这个字段的话，这个错误码永远不会触发，
     * 而用户会拿到一份内容与他看到的不同的 PDF。
     */
    plan_version_id: z.string().uuid().nullish(),
  })
  .refine(
    (input) =>
      input.scope === 'SINGLE_DAY'
        ? Array.isArray(input.day_numbers) && input.day_numbers.length === 1
        : input.day_numbers === null || input.day_numbers === undefined,
    {
      message: 'SINGLE_DAY 必须给出恰好一个天号，其余 scope 不得带 day_numbers',
      path: ['day_numbers'],
    },
  );
export type CreateExportRequest = z.infer<typeof CreateExportRequestSchema>;

// ── 13.6 响应 ───────────────────────────────────────────────

export const EXPORT_STATUS_VALUES = [
  'QUEUED',
  'RENDERING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
] as const;
export const ExportStatusSchema = z.enum(EXPORT_STATUS_VALUES);
export type ExportStatus = (typeof EXPORT_STATUS_VALUES)[number];

/** 13.6 的 `files[]`，也是 `exports.files` 的 JSONB 结构 */
export const ExportFileSchema = z.object({
  format: ExportFormatSchema,
  /** `ALL_DAYS` 的 PNG 每天一项；PDF 合并为一个文件，此处为 null */
  day_number: z.number().int().min(1).max(14).nullable(),
  url: NonEmptyStringSchema,
  byte_size: z.number().int().nonnegative(),
  /**
   * 预签名 URL 的过期时刻（13.6：7 天）。
   *
   * 显式返回而不是让客户端自己算：「过期后重新调用本端点获取新签名，
   * 不重新渲染」这条行为要求客户端知道什么时候该重新调用。
   */
  expires_at: NonEmptyStringSchema,
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

/**
 * 对象键。落库保存，因为**重签名需要它** ——
 * 13.6 的「过期后重签不重渲染」意味着 7 天后要凭键重新生成 URL，
 * 而 URL 本身带签名参数，从里面反解键既脆弱又依赖签名格式。
 */
export const ExportArtifactSchema = ExportFileSchema.extend({
  storage_key: NonEmptyStringSchema,
});
export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;

export const ExportDetailSchema = z.object({
  export_id: z.string().uuid(),
  status: ExportStatusSchema,
  format: ExportFormatSchema,
  scope: ExportScopeSchema,
  progress: z.number().int().min(0).max(100),
  files: z.array(ExportFileSchema),
  /** `PARTIAL` / `FAILED` 时携带 13.0 定义的错误对象 */
  error: z.object({ code: NonEmptyStringSchema, message: NonEmptyStringSchema }).nullable(),
});
export type ExportDetail = z.infer<typeof ExportDetailSchema>;

/**
 * 13.6 的 `progress`。
 *
 * 与 16.2 同一处理：查表而不是估算。`RENDERING` 取 50 是因为导出只有
 * 「渲染 + 上传」两段，而上传相对渲染可以忽略 —— 给一个会跳的数字
 * （比如按天数算百分比）会让 `ALL_DAYS` 与 `SINGLE_DAY` 的进度条行为不一致。
 */
export const EXPORT_PROGRESS: Record<ExportStatus, number> = {
  QUEUED: 0,
  RENDERING: 50,
  COMPLETED: 100,
  // PARTIAL 也是终态：产物已经交付了一部分，进度条不该停在中间
  PARTIAL: 100,
  FAILED: 0,
};

/** 13.6：预签名 URL 有效期 7 天 */
export const EXPORT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
