/**
 * 错误码体系（设计稿 13.7、13.9.6）。
 *
 * P1 只落地 `AUTH` 域 —— 其余域随对应功能在 P2/P4 加入。
 * 每个码有唯一的 HTTP 状态与 `retryable` 语义，由类型保证不漏配。
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
    message: '请先访问首页以获取访问凭据。',
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

/** 请求校验域（13.7）。P2 补全 N-01～N-12，P1 只需通用形态。 */
export const REQ_ERRORS = {
  REQ_SCHEMA_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '请求内容格式不正确。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/** 系统域（13.7） */
export const SYS_ERRORS = {
  SYS_INTERNAL_ERROR: {
    httpStatus: 500,
    retryable: true,
    message: '服务暂时不可用，请稍后重试。',
  },
  SYS_DEPENDENCY_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    message: '服务暂时不可用，请稍后重试。',
  },
} as const satisfies Record<string, ErrorDefinition>;

export const ERROR_CATALOG = {
  ...AUTH_ERRORS,
  ...REQ_ERRORS,
  ...SYS_ERRORS,
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
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
