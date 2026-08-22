import { DOMAIN_ERRORS } from '@tps/schemas';

/**
 * 错误码体系（设计稿 13.7、13.9.6）。
 *
 * 全表由两部分拼成：
 *   `AUTH` 域       在本文件 —— 它与会话、Cookie、限流紧密耦合，
 *                   只有 api 会产生它，没有第二个引用方；
 *   其余四域        在 `@tps/schemas` 的 `DOMAIN_ERRORS` —— 生产它们的地方
 *                   不止一个（请求校验在 @tps/planning、渲染在 render-worker），
 *                   放共享包里三处引用同一张表。
 *
 * 每个码有唯一的 HTTP 状态与 `retryable` 语义，由测试保证两部分不重名。
 *
 * 命名规则：`<域>_<具体原因>`，全大写下划线。
 */

export interface ErrorDefinition {
  readonly httpStatus: number;
  readonly retryable: boolean;
  /** 面向用户的中文提示。**不含内部细节、堆栈、SQL、模型原文**（13.0） */
  readonly message: string;
}

/** AUTH 域（13.7 + 13.9.6） */
export const AUTH_ERRORS = {
  AUTH_IDENTITY_REQUIRED: {
    httpStatus: 401,
    retryable: false,
    /*
     * P7 之后这句必须引导**注册**，不能引导「访问首页取凭据」。
     *
     * 原文是「请先访问首页以获取访问凭据。」—— 那是匿名入口开着时的正确
     * 指引（首页那一次 `/auth/session` 会现场建匿名号并下发 Cookie）。
     * `FEATURE_ANONYMOUS_ENABLED` 默认关闭后首页不再发任何凭据，
     * 用户照着这句做一定失败，而且会反复失败：他做的事看起来完全合理。
     */
    message: '请先注册或登录后再使用。',
  },
  AUTH_SESSION_INVALID: {
    httpStatus: 401,
    retryable: false,
    message: '登录状态已失效，请重新登录。',
  },
  AUTH_CREDENTIALS_INVALID: {
    httpStatus: 401,
    retryable: false,
    message: '邮箱或密码不正确。',
  },
  AUTH_ANONYMOUS_FORBIDDEN: {
    httpStatus: 403,
    retryable: false,
    message: '该操作需要注册账号。',
  },
  AUTH_EMAIL_ALREADY_REGISTERED: {
    httpStatus: 409,
    retryable: false,
    message: '该邮箱已注册，请直接登录。',
  },
  AUTH_PASSWORD_TOO_WEAK: {
    httpStatus: 400,
    retryable: false,
    message: '密码强度不足，请使用至少 10 个字符且不易被猜到的密码。',
  },
  AUTH_ANONYMOUS_ALREADY_UPGRADED: {
    httpStatus: 409,
    retryable: false,
    message: '该访客身份已完成注册，请直接登录。',
  },
  AUTH_MERGE_FAILED: {
    httpStatus: 500,
    retryable: true,
    message: '合并历史记录时出错，请重试登录。',
  },
  AUTH_ANON_CREATION_RATE_LIMITED: {
    httpStatus: 429,
    retryable: true,
    message: '访问过于频繁，请稍后再试。',
  },
  AUTH_RATE_LIMITED: {
    httpStatus: 429,
    retryable: true,
    message: '操作过于频繁，请稍后再试。',
  },
  AUTH_QUOTA_EXCEEDED: {
    httpStatus: 429,
    retryable: false,
    message: '已达到使用额度上限。注册账号可获得更多额度与长期保存。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/**
 * api 独有的系统域。
 *
 * `SYS_INTERNAL_ERROR` 在 `DOMAIN_ERRORS` 里（JOB 域），这里只补
 * `SYS_DEPENDENCY_UNAVAILABLE` —— 它只由 `/readyz` 产生，
 * 属于运维探针而不是业务错误。
 */
export const SYS_ERRORS = {
  SYS_DEPENDENCY_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    message: '服务暂时不可用，请稍后重试。',
  },
} as const satisfies Record<string, ErrorDefinition>;

export const ERROR_CATALOG = {
  ...DOMAIN_ERRORS,
  ...AUTH_ERRORS,
  ...SYS_ERRORS,
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
}

/**
 * 按**任意字符串**查文案，用于数据库里存的 `error_code`。
 *
 * `generation_jobs.error_code` 是 `VARCHAR(60)`，可能是旧版本写入的码，
 * 也可能是某次改名后失效的码。返回 `undefined` 让调用方走兜底文案，
 * 而不是让 `ERROR_CATALOG[code]` 返回 `undefined` 再被拼成
 * 「undefined」显示给用户。
 */
export function messageForCode(code: string): string | undefined {
  return (ERROR_CATALOG as Record<string, ErrorDefinition | undefined>)[code]?.message;
}

/** 13.0 定义的统一错误响应体 */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly field?: string;
    readonly request_id: string;
    readonly trace_id: string;
  };
}

export function buildErrorBody(
  code: ErrorCode,
  context: { readonly requestId: string; readonly traceId: string; readonly field?: string },
): ErrorResponseBody {
  const def = errorDefinition(code);
  return {
    error: {
      code,
      message: def.message,
      retryable: def.retryable,
      ...(context.field === undefined ? {} : { field: context.field }),
      request_id: context.requestId,
      trace_id: context.traceId,
    },
  };
}
