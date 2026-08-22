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

// ── 计划相关（13.1～13.3、13.9.5）─────────────────────────────

export interface GenerateResponse {
  readonly request_id: string;
  readonly plan_id: string;
  readonly job_id: string;
  readonly status: string;
}

export interface JobStatusResponse {
  readonly job_id: string;
  readonly status: string;
  readonly progress: number;
  readonly message: string;
  readonly error_code?: string;
  /** 13.7 的非阻断告警码。任务仍会 COMPLETED，只是某些素材走了降级 */
  readonly warnings?: readonly string[];
  /**
   * 21.2 措施一的两个里程碑。
   *
   * 可选是为了兼容老服务端（这两个字段在 P5 之后才有）——
   * 缺失时前端退回按 `status` 判断，与 P2 的行为一致。
   */
  readonly milestones?: {
    readonly plan_readable: boolean;
    readonly page_viewable: boolean;
  };
}

/** 13.5 / 13.6 的导出任务。字段名与 `ExportDetailSchema` 一致 */
export interface ExportResponse {
  readonly export_id: string;
  readonly status: 'QUEUED' | 'RENDERING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  readonly format: 'PNG' | 'PDF';
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
  readonly progress: number;
  readonly files: readonly {
    readonly format: 'PNG' | 'PDF';
    /** `ALL_DAYS` 的 PNG 每天一项；PDF 合并为一个文件，此处为 null */
    readonly day_number: number | null;
    readonly url: string;
    readonly byte_size: number;
    readonly expires_at: string;
  }[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** 13.4 的展示数据。`view_model` 由调用方用 schema 解析 */
export interface PresentationResponse {
  readonly plan_id: string;
  readonly plan_version_id: string;
  readonly template_id: string;
  readonly page_type: 'DAILY_POSTER' | 'FULL_PLAN';
  readonly day_number: number | null;
  readonly validation_status: 'VALID' | 'DEGRADED' | 'INVALID';
  readonly view_model: unknown;
}

export interface PlanListItem {
  readonly plan_id: string;
  readonly title: string | null;
  readonly destination_name: string;
  readonly start_date: string;
  readonly total_days: number;
  readonly status: string;
  readonly cover_url: string | null;
  readonly created_at: string;
}

export interface PlanListResponse {
  readonly items: readonly PlanListItem[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

/**
 * 13.1 提交生成请求。
 *
 * **会因为未登录而失败**：P7（R-54）关闭匿名入口后，13.0 第 3.a 条
 * 「生成端点永不因缺身份返回 401」的适用条件是 `FEATURE_ANONYMOUS_ENABLED=true`，
 * 而它默认 false。无身份或会话失效时这里返回 401 `AUTH_IDENTITY_REQUIRED` /
 * `AUTH_SESSION_INVALID`。
 *
 * 调用方拿到 401 必须**重新解析身份**（`SessionProvider.refresh()`），
 * 否则界面继续显示「已登录」，而后端那句「请重新登录」在屏幕上找不到
 * 可以登录的地方。参考实现见 `Planner` 的 `reauthOn401`。
 */
export function generatePlan(body: unknown): Promise<ApiResult<GenerateResponse>> {
  return request<GenerateResponse>('/api/v1/travel-plans/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** 13.2 查询任务状态。轮询用。 */
export function getJobStatus(jobId: string): Promise<ApiResult<JobStatusResponse>> {
  return request<JobStatusResponse>(`/api/v1/generation-jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
  });
}

/**
 * 13.3 获取完整计划。
 *
 * 返回类型是 `unknown`：调用方必须用 `TravelPlanSchema` 解析后再用。
 * 直接标成 `TravelPlan` 会让「后端改了契约」表现为渲染时的
 * `undefined is not an object`，而那时离根因已经很远。
 */
export function getPlan(planId: string): Promise<ApiResult<unknown>> {
  return request<unknown>(`/api/v1/travel-plans/${encodeURIComponent(planId)}`, { method: 'GET' });
}

/**
 * 13.4 获取带图的展示数据（完整页，一次返回全部天数）。
 *
 * ## 与 13.3 的分工
 *
 * 13.3 返回 `plan_json` —— 纯行程数据，**不含素材**。前端拿它只能现场
 * 构建一个无图的 ViewModel（`buildFullPlan({ plan })` 的 assets 缺省为空）。
 *
 * 13.4 返回的是**落库的 ViewModel**：Hero 背景、景点与美食配图、路线图 SVG
 * 都已经解析并绑定好（P3/P4 的产物）。这条才是设计稿 1.1「信息图」的数据源。
 *
 * 编排未完成时返回 404 —— 那是**正常的时序**（16.1 的 BUILDING_PRESENTATION
 * 在 SAVING_PLAN 之后），调用方据此退回 13.3 的文字版并稍后重试。
 */
export function getFullPresentation(planId: string): Promise<ApiResult<PresentationResponse>> {
  return request<PresentationResponse>(
    `/api/v1/travel-plans/${encodeURIComponent(planId)}/presentations/full`,
    { method: 'GET' },
  );
}

/** 13.4 获取某一天的信息图展示数据 */
export function getDayPresentation(
  planId: string,
  dayNumber: number,
): Promise<ApiResult<PresentationResponse>> {
  return request<PresentationResponse>(
    `/api/v1/travel-plans/${encodeURIComponent(planId)}/presentations/${String(dayNumber)}`,
    { method: 'GET' },
  );
}

/**
 * 13.5 发起导出。
 *
 * `plan_version_id` 显式传入是刻意的：用户在「查看计划」页面点导出，
 * 而此刻计划刚好被重新生成时，他要的是**屏幕上那一版**。
 * 不带这个字段的话服务端会取当前版本，用户拿到一份内容与他看到的不同的 PDF
 * （13.7 的 `EXPORT_PLAN_VERSION_MISMATCH` 就是为这种情况准备的）。
 */
export function createExport(
  planId: string,
  body: {
    readonly format: 'PNG' | 'PDF';
    readonly template_id: string;
    readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
    readonly day_numbers: readonly number[] | null;
    readonly plan_version_id?: string;
  },
): Promise<ApiResult<ExportResponse>> {
  return request<ExportResponse>(`/api/v1/travel-plans/${encodeURIComponent(planId)}/exports`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * 13.6 查询导出状态。轮询用。
 *
 * 每次调用服务端都会**重新签名** URL（13.6）—— 因此拿到的链接总是新鲜的，
 * 前端不需要自己判断 7 天有没有过期。
 */
export function getExport(exportId: string): Promise<ApiResult<ExportResponse>> {
  return request<ExportResponse>(`/api/v1/exports/${encodeURIComponent(exportId)}`, {
    method: 'GET',
  });
}

/** 13.9.5 计划列表。 */
export function listPlans(
  params: {
    readonly limit?: number;
    readonly cursor?: string;
  } = {},
): Promise<ApiResult<PlanListResponse>> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor !== undefined) query.set('cursor', params.cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return request<PlanListResponse>(`/api/v1/travel-plans${suffix}`, { method: 'GET' });
}
