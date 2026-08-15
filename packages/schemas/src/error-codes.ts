/**
 * 错误码体系（TP-2-07，设计稿 13.7）。
 *
 * ## 为什么放在 schemas 而不是 api
 *
 * 13.7 说得很清楚：`code` 是「稳定字符串，客户端可据此分支」。它和 Zod
 * 契约一样是对外承诺的一部分。而生产这些码的地方不止一个 ——
 * 请求校验在 `@tps/planning`、渲染在 `apps/render-worker`、
 * HTTP 映射在 `apps/api`。放在共享包里，三处引用同一张表。
 *
 * `AUTH` 域仍在 `apps/api/src/errors/codes.ts`：它与会话、Cookie、限流
 * 紧密耦合，只有 api 会产生它，没有第二个引用方。
 *
 * ## 为什么每个码都必须有 httpStatus 与 retryable
 *
 * 验收标准 14 是「生成失败有明确错误码和**重试机制**」。客户端要靠
 * `retryable` 决定是否自动重试 —— 缺这个字段就只能一律不重试（用户看到
 * 偶发失败）或一律重试（对 `PLAN_HARD_CONSTRAINT_UNSATISFIABLE`
 * 这类永久失败反复烧钱）。因此它是必填而不是可选。
 */

export interface ErrorDefinition {
  readonly httpStatus: number;
  readonly retryable: boolean;
  /** 面向用户的中文提示。**不含内部细节、堆栈、SQL、模型原文**（13.0） */
  readonly message: string;
}

/**
 * REQ 域：请求校验（13.7）。
 *
 * 13.7 规定全部 `400` + `retryable: false`，且一一对应 3.1.2 的 N-01～N-12。
 * `field` 必填由 `RequestViolation` 类型保证（见 @tps/planning）。
 */
export const REQUEST_ERRORS = {
  REQ_SCHEMA_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '请求格式不正确，请刷新页面后重试。',
  },
  REQ_START_DATE_IN_PAST: {
    httpStatus: 400,
    retryable: false,
    message: '出发日期不能早于今天。',
  },
  REQ_DATE_RANGE_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '返回日期不能早于出发日期。',
  },
  REQ_TRIP_DAYS_OUT_OF_RANGE: {
    httpStatus: 400,
    retryable: false,
    message: '行程天数需在 1 到 14 天之间。',
  },
  REQ_BUDGET_RANGE_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '预算上限需不低于下限，且下限需大于 0。',
  },
  REQ_BUDGET_INFEASIBLE: {
    httpStatus: 400,
    retryable: false,
    message: '按当前人数与天数，该预算难以安排出可行的行程，请适当提高。',
  },
  REQ_PACE_RANGE_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '每日景点数量的上限需不低于下限，且下限至少为 1。',
  },
  REQ_ORIGIN_EQUALS_DESTINATION: {
    httpStatus: 400,
    retryable: false,
    message: '出发地与目的地不能相同。',
  },
  REQ_TRAVELER_COUNT_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '出行人数至少为 1 人。',
  },
  REQ_CONDITION_CODE_UNKNOWN: {
    httpStatus: 400,
    retryable: false,
    message: '存在暂不支持的偏好条件，请刷新页面后重新选择。',
  },
  REQ_DATE_FLEXIBILITY_UNSUPPORTED: {
    httpStatus: 400,
    retryable: false,
    message: '暂不支持弹性日期，请选择确定的出发与返回日期。',
  },
  REQ_MULTI_DESTINATION_UNSUPPORTED: {
    httpStatus: 400,
    retryable: false,
    message: '暂不支持多目的地行程，请选择单一目的地。',
  },
  REQ_TEMPLATE_UNKNOWN: {
    httpStatus: 400,
    retryable: false,
    message: '所选模板不可用，请刷新页面后重试。',
  },
  REQ_DESTINATION_UNKNOWN: {
    httpStatus: 400,
    retryable: false,
    message: '无法识别该目的地，请换一种写法。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/** PLAN 域：计划生成（13.7） */
export const PLAN_ERRORS = {
  PLAN_NOT_FOUND: {
    httpStatus: 404,
    retryable: false,
    // 13.0：他人资源也返回 404 而不是 403，避免用状态码枚举计划是否存在。
    // 因此这条文案必须同时适用于「不存在」「不属于你」「版本被拒绝」三种情况
    message: '未找到该计划。',
  },
  PLAN_LLM_TIMEOUT: {
    httpStatus: 502,
    retryable: true,
    message: '生成超时，请重试。',
  },
  PLAN_LLM_UNAVAILABLE: {
    httpStatus: 502,
    retryable: true,
    message: '生成服务暂时不可用，请稍后重试。',
  },
  PLAN_LLM_OUTPUT_UNPARSEABLE: {
    httpStatus: 502,
    retryable: true,
    message: '生成结果解析失败，请重试。',
  },
  PLAN_SCHEMA_INVALID: {
    httpStatus: 502,
    retryable: true,
    message: '生成结果不完整，请重试。',
  },
  PLAN_HARD_CONSTRAINT_UNSATISFIABLE: {
    httpStatus: 422,
    retryable: false,
    // 唯一一个「不可重试的生成失败」：重试不会改变结果，必须由用户放宽条件。
    // 文案因此要指出下一步动作，而不是让用户反复点重试
    message: '当前必选条件无法同时满足，请放宽部分条件后重试。',
  },
  PLAN_REPAIR_EXHAUSTED: {
    httpStatus: 502,
    retryable: true,
    message: '生成结果多次校验未通过，请重试。',
  },
  PLAN_PERSIST_FAILED: {
    httpStatus: 500,
    retryable: true,
    message: '保存计划时出错，请重试。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/**
 * ASSET 域：素材（13.7）。
 *
 * **全部非阻断**：它们只出现在 `generation_jobs.warnings` 里，任务继续。
 * 因此没有 httpStatus 也没有 retryable —— 它们从不作为 HTTP 错误返回。
 * 用单独的字符串数组而不是塞进上面的表，正是为了让「素材错误不是 HTTP 错误」
 * 这件事在类型上就成立。
 */
export const ASSET_WARNING_CODES = [
  'ASSET_LIBRARY_MISS',
  'ASSET_LICENSED_SOURCE_UNAVAILABLE',
  'ASSET_AI_GENERATION_FAILED',
  'ASSET_AI_GENERATION_TIMEOUT',
  'ASSET_POSTPROCESS_FAILED',
  'ASSET_MAP_RENDER_FAILED',
  'ASSET_UPLOAD_FAILED',
] as const;
export type AssetWarningCode = (typeof ASSET_WARNING_CODES)[number];

/** RENDER / EXPORT 域（13.7） */
export const RENDER_ERRORS = {
  RENDER_CORE_ASSET_MISSING: {
    httpStatus: 500,
    retryable: true,
    message: '生成图片所需素材缺失，请重试。',
  },
  RENDER_TEMPLATE_FAILED: {
    httpStatus: 500,
    retryable: true,
    message: '渲染失败，请重试。',
  },
  RENDER_TIMEOUT: {
    httpStatus: 500,
    retryable: true,
    message: '渲染超时，请重试。',
  },
  EXPORT_PNG_FAILED: {
    httpStatus: 500,
    retryable: true,
    message: '导出长图失败，可先使用网页版或 PDF。',
  },
  EXPORT_PDF_FAILED: {
    httpStatus: 500,
    retryable: true,
    message: '导出 PDF 失败，可先使用网页版或长图。',
  },
  EXPORT_NOT_FOUND: {
    httpStatus: 404,
    retryable: false,
    message: '未找到该导出任务。',
  },
  EXPORT_PLAN_VERSION_MISMATCH: {
    httpStatus: 409,
    retryable: false,
    message: '计划已更新，请重新发起导出。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/**
 * 渲染域的**非阻断**告警码（R-24 修订）。
 *
 * `RENDER_OVERFLOW_UNRESOLVED` 原本在上面的 HTTP 表里，标成
 * `500` + `retryable: false`。那个组合本身是矛盾的：5xx 表示服务端出错、
 * 客户端应当重试，而一个不可重试的 5xx 让客户端无从处置。
 *
 * 根因是它压根不走 HTTP 错误路径 —— 17.3 明确「输出当前产物 +
 * `validation_status = 'DEGRADED'`」，任务照常 `COMPLETED`。给它一个
 * httpStatus 只会诱导某处把降级当失败返回，而那会让「有一页排版拥挤」
 * 变成「整个任务失败」。
 *
 * 因此按 `ASSET_WARNING_CODES` 的先例移出 HTTP 表：非阻断的东西不是 HTTP
 * 错误，这一点由类型保证 —— 它根本没有 `httpStatus` 可取。
 */
export const RENDER_WARNING_CODES = ['RENDER_OVERFLOW_UNRESOLVED'] as const;
export type RenderWarningCode = (typeof RENDER_WARNING_CODES)[number];

/** 降级时给用户的说明。它不是错误文案，因此与错误表分开 */
export const RENDER_WARNING_MESSAGES: Record<RenderWarningCode, string> = {
  RENDER_OVERFLOW_UNRESOLVED: '部分内容排版拥挤，已按可读性优先调整。',
};

/** JOB / SYS 域（13.7） */
export const JOB_ERRORS = {
  JOB_NOT_FOUND: {
    httpStatus: 404,
    retryable: false,
    message: '未找到该任务。',
  },
  JOB_ALREADY_RUNNING: {
    httpStatus: 409,
    retryable: false,
    // 13.8：响应携带既有 job_id，客户端应改为轮询它而不是重新提交
    message: '相同的生成请求正在处理中。',
  },
  JOB_CANCELLED: {
    httpStatus: 200,
    retryable: false,
    message: '任务已取消。',
  },
  SYS_INTERNAL_ERROR: {
    httpStatus: 500,
    retryable: true,
    // 13.7：message 固定为通用文案，不透出任何内部细节
    message: '服务暂时不可用，请稍后重试。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/** REQ / PLAN / RENDER / JOB 四域合并。AUTH 域由 apps/api 合入 */
export const DOMAIN_ERRORS = {
  ...REQUEST_ERRORS,
  ...PLAN_ERRORS,
  ...RENDER_ERRORS,
  ...JOB_ERRORS,
} as const;

export type RequestErrorCode = keyof typeof REQUEST_ERRORS;
export type PlanErrorCode = keyof typeof PLAN_ERRORS;
export type RenderErrorCode = keyof typeof RENDER_ERRORS;
export type JobErrorCode = keyof typeof JOB_ERRORS;
export type DomainErrorCode = keyof typeof DOMAIN_ERRORS;
