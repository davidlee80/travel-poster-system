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
    message: '手机号、密码或验证码不正确。',
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
  AUTH_PHONE_ALREADY_REGISTERED: {
    httpStatus: 409,
    retryable: false,
    message: '该手机号已注册，请直接登录。',
  },
  AUTH_VERIFICATION_CODE_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '验证码不正确或已失效，请重新获取。',
  },
  AUTH_VERIFICATION_CODE_RATE_LIMITED: {
    httpStatus: 429,
    retryable: true,
    message: '验证码发送或校验过于频繁，请稍后再试。',
  },
  AUTH_SMS_PROVIDER_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    message: '验证码暂时无法发送，请稍后重试。',
  },
  AUTH_PASSWORD_TOO_WEAK: {
    httpStatus: 400,
    retryable: false,
    message: '密码强度不足，请使用至少 10 个字符且不易被猜到的密码。',
  },
  AUTH_CURRENT_PASSWORD_INVALID: {
    /*
     * 400 而**不是** 401，尽管它就是「口令不对」。
     *
     * 401 在这套前端里有一个全局含义：会话已经不作数了，去重新解析身份
     * （见 `Planner` 的 `reauthOn401`）。改口令时输错一个字如果回 401，
     * 用户会因为一个笔误被当成掉线处理。
     *
     * 400 + `field: 'current_password'` 让它落到该落的地方：那一个输入框。
     */
    httpStatus: 400,
    retryable: false,
    message: '当前密码不正确。',
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
  AUTH_INSUFFICIENT_CREDITS: {
    /*
     * 402 是全表唯一的这个状态码，而只有它对。
     *
     * 另两个看起来能用的都会让客户端做错事：
     *   429  「太频繁了，稍后重试」—— 而余额不会自己长回来，重试必然再撞一次；
     *   403  「需要注册账号」—— 而他已经注册了，照着做无路可走。
     *
     * 402 Payment Required 的语义正是「这个请求要付费，而你还没付」。
     * `retryable: false` 与 429 那两条同理：恢复路径是充值，不是重试。
     *
     * 响应体带 `details.required_cr` 与 `details.balance_cr`（见
     * `buildErrorBody`）—— 让「还差多少」不需要客户端再发一次报价请求。
     */
    httpStatus: 402,
    retryable: false,
    message: '账户余额不足，请充值后再使用。',
  },
} as const satisfies Record<string, ErrorDefinition>;

/**
 * api 独有的系统域。
 *
 * `SYS_INTERNAL_ERROR` 在 `DOMAIN_ERRORS` 里（JOB 域），这里只补三个
 * api 自己产生的码。
 */
export const SYS_ERRORS = {
  SYS_DEPENDENCY_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    message: '服务暂时不可用，请稍后重试。',
  },
  /**
   * 队列积压到无法再接新任务（背压准入）。
   *
   * ## 为何不复用 `SYS_DEPENDENCY_UNAVAILABLE`
   *
   * 两者都是 503，但处置手法相反：前者是「依赖挂了」（查 Redis / 数据库），
   * 后者是「我们健康，只是活排不过来」（加 Worker 副本）。
   * 共用一个码的表现是值班按运维手册去查一个没坏的依赖。
   *
   * `retryable: true` 且带 `Retry-After`：积压会自己消下去，
   * 与余额不足（不可重试）不同。
   */
  SYS_QUEUE_SATURATED: {
    httpStatus: 503,
    retryable: true,
    message: '当前排队人数过多，请稍后再试。',
  },
  /**
   * 传输层的每-IP 限流（`@fastify/rate-limit`）。
   *
   * ## 与 `AUTH_RATE_LIMITED` 的分工
   *
   * `AUTH_RATE_LIMITED` 是**业务**限流：21.4 的每分钟 1／3 次生成，
   * 它在身份解析**之后**判定，因此未认证的洪水根本走不到那一层。
   * 这一条在那之前，按 IP 计数，不看身份。
   *
   * 分开两个码是为了让「单一源在打我们」与「用户点得太快」在日志与
   * 告警上可分辨 —— 前者要看源 IP、可能要在网关封，后者什么都不用做。
   */
  SYS_RATE_LIMITED: {
    httpStatus: 429,
    retryable: true,
    message: '请求过于频繁，请稍后再试。',
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
    /**
     * 让错误可被行动的数值。目前只有 402 用它
     * （`required_cr` / `balance_cr`）。
     *
     * 只允许数字，不允许任意结构：13.0 要求错误体不含内部细节，
     * 而一个开放的 `unknown` 字段迟早会被塞进 SQL 片段或模型原文。
     * 键名恒为 snake_case，与响应体其余部分一致。
     */
    readonly details?: Readonly<Record<string, number>>;
    readonly request_id: string;
    readonly trace_id: string;
  };
}

export function buildErrorBody(
  code: ErrorCode,
  context: {
    readonly requestId: string;
    readonly traceId: string;
    readonly field?: string;
    readonly details?: Readonly<Record<string, number>>;
  },
): ErrorResponseBody {
  const def = errorDefinition(code);
  return {
    error: {
      code,
      message: def.message,
      retryable: def.retryable,
      ...(context.field === undefined ? {} : { field: context.field }),
      ...(context.details === undefined ? {} : { details: context.details }),
      request_id: context.requestId,
      trace_id: context.traceId,
    },
  };
}
