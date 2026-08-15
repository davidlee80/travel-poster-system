/**
 * 渲染侧错误码（设计稿 13.7、16.3）。
 *
 * 只列渲染 Worker 会产生的码。阻断与降级的分野来自 16.3 的阻断判定表，
 * 不是这里自行决定的 —— 把一个降级项误判为阻断会让本可交付的产物变成失败任务。
 */

export const RENDER_ERROR_CODES = {
  /** 模板抛错、画布横向溢出、中文字形缺失 —— 阻断，任务 FAILED */
  templateFailed: 'RENDER_TEMPLATE_FAILED',
  /** 页面未在超时内 ready —— 阻断 */
  timeout: 'RENDER_TIMEOUT',
  /** 四轮重渲染后仍溢出 —— **不阻断**，产物输出但标记 DEGRADED */
  overflowUnresolved: 'RENDER_OVERFLOW_UNRESOLVED',
} as const;

export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[keyof typeof RENDER_ERROR_CODES];

/** 17.5：中文字形缺失的具体原因，上报时归到 RENDER_TEMPLATE_FAILED */
export const CJK_FONT_UNAVAILABLE = 'CJK_FONT_UNAVAILABLE';

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  /** 具体原因标识，用于日志与指标细分；不进入用户可见响应 */
  readonly detail: string | undefined;

  constructor(code: RenderErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 16.3：本码是否阻断任务。
 *
 * 写成函数而不是在各处 `code === 'RENDER_OVERFLOW_UNRESOLVED'` 判断 ——
 * 后者每增加一个码都要找齐全部判断点，漏一处就会出现「同一个错误在
 * 某条路径上阻断、在另一条路径上不阻断」。
 */
export function isBlocking(code: RenderErrorCode): boolean {
  return code !== RENDER_ERROR_CODES.overflowUnresolved;
}
