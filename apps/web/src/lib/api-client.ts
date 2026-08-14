/**
 * API 客户端（TP-1-40）。
 *
 * 只做三件事：拼 URL、带 Cookie、把错误体转成可判别的联合类型。
 *
 * `credentials: 'include'` 是必须的 —— 身份完全依赖 HttpOnly Cookie
 * （13.0），不带它每个请求都会被当成新访客。
 */

export interface SessionInfo {
  readonly user_type: 'ANONYMOUS' | 'REGISTERED';
  readonly user_id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly quota: {
    readonly daily_remaining: number;
    readonly monthly_remaining: number;
    readonly reset_at: string;
  };
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly field?: string;
    readonly request_id: string;
    readonly trace_id: string;
  };
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly field?: string;
    };

const API_BASE = process.env['NEXT_PUBLIC_API_BASE'] ?? '';

async function request<T>(
  path: string,
  init: RequestInit & { readonly method: string },
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      // 身份靠 HttpOnly Cookie，不带 credentials 每次都会被当成新访客
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  } catch {
    /*
     * 网络错误也走统一的失败形态，而不是抛异常。
     * 调用方只需处理一种失败路径 —— 混用异常与返回值会让某一种被漏掉，
     * 而漏掉的通常是网络错误（本地开发几乎不会遇到）。
     */
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络后重试。',
      retryable: true,
    };
  }

  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok) {
    return { ok: true, data: body as T };
  }

  const error = (body as ApiErrorBody | null)?.error;
  return {
    ok: false,
    status: response.status,
    code: error?.code ?? 'SYS_INTERNAL_ERROR',
    message: error?.message ?? '服务暂时不可用，请稍后重试。',
    retryable: error?.retryable ?? true,
    ...(error?.field === undefined ? {} : { field: error.field }),
  };
}

/**
 * 13.9.1 获取当前身份。
 *
 * 无任何身份 Cookie 时服务端会**自动创建匿名用户**，因此前端在应用启动时
 * 调一次即可，之后所有请求都带上了身份。
 */
export function getSession(): Promise<ApiResult<SessionInfo>> {
  return request<SessionInfo>('/api/v1/auth/session', { method: 'GET' });
}

/** 13.9.2 注册。携带匿名 Cookie 时服务端执行原地升级，历史自动继承。 */
export function register(input: {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}): Promise<ApiResult<SessionInfo>> {
  return request<SessionInfo>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      display_name: input.displayName ?? null,
    }),
  });
}

/** 13.9.3 登录。副作用含匿名归并（13.9.4）。 */
export function login(input: {
  readonly email: string;
  readonly password: string;
}): Promise<ApiResult<SessionInfo>> {
  return request<SessionInfo>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function logout(): Promise<ApiResult<void>> {
  return request<void>('/api/v1/auth/logout', { method: 'POST' });
}
