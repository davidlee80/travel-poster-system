/**
 * API 客户端（TP-1-40）。
 *
 * 只做三件事：拼 URL、带 Cookie、把错误体转成可判别的联合类型。
 *
 * `credentials: 'include'` 是必须的 —— 身份完全依赖 HttpOnly Cookie
 * （13.0），不带它每个请求都会被当成新访客。
 */

import type { PlannerFieldId, PlannerFieldRequirement } from '@tps/schemas';

export interface SessionInfo {
  readonly user_type: 'ANONYMOUS' | 'REGISTERED';
  readonly user_id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly has_password: boolean;
  readonly display_name: string | null;
  readonly quota: {
    readonly daily_remaining: number;
    readonly monthly_remaining: number;
    readonly reset_at: string;
  };
  /**
   * CR 钱包（C-3）。**只在服务端装配了计费、且身份是注册用户时出现。**
   *
   * 可选而不是补一个 `balance_cr: 0`：计费关着的部署里 CR 这个概念
   * 对用户根本不存在，而一个恒为 0 的余额会让界面画出一个永远不够用的钱包。
   * 判据因此是「有没有这个字段」。
   */
  readonly wallet?: WalletInfo;
}

export interface WalletInfo {
  readonly balance_cr: number;
  /** 生成中的任务冻结的额度。展示成「处理中」而不是从余额里消失 */
  readonly held_cr: number;
  /** 人民币等值。由服务端算 —— 前端没有兑换比率，硬编码一个就会漂移 */
  readonly balance_cny: string;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly field?: string;
    readonly details?: Readonly<Record<string, number>>;
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
      /**
       * 让错误可被行动的数值。目前只有 402 用它
       * （`required_cr` / `balance_cr`），见 13.0 的错误信封。
       */
      readonly details?: Readonly<Record<string, number>>;
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
        /*
         * 只在**有请求体**时声明 content-type。
         *
         * 原来是无条件加的，于是 `logout()`（无请求体）发出的是
         * 「content-type: application/json + 空体」—— Fastify 对此回 400
         * `FST_ERR_CTP_EMPTY_JSON_BODY`。而调用方不看登出的返回值
         * （它接着去重新取身份，而身份还在），表现是**「退出登录」点了
         * 没反应**，没有任何报错。
         *
         * 服务端也做了容忍（见 `apps/api/src/server.ts` 的
         * `addContentTypeParser`），两边都改是有意的：这一侧是「不声明自己
         * 没有的东西」，那一侧是「别让第三方前端踩同一个坑」。
         */
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
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
    ...(error?.details === undefined ? {} : { details: error.details }),
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
  readonly phone: string;
  readonly verificationCode: string;
  readonly password?: string;
  readonly displayName?: string;
}): Promise<ApiResult<SessionInfo>> {
  return request<SessionInfo>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      phone: input.phone,
      verification_code: input.verificationCode,
      password: input.password ?? null,
      display_name: input.displayName ?? null,
    }),
  });
}

/** 13.9.3 登录。副作用含匿名归并（13.9.4）。 */
export function login(input: {
  readonly phone: string;
  readonly method: 'CODE' | 'PASSWORD';
  readonly credential: string;
}): Promise<ApiResult<SessionInfo>> {
  return request<SessionInfo>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      phone: input.phone,
      login_type: input.method,
      ...(input.method === 'CODE'
        ? { verification_code: input.credential }
        : { password: input.credential }),
    }),
  });
}

export interface SendCodeResponse {
  readonly sent: true;
  readonly expires_in_seconds: number;
  /** 仅 SMS_MODE=local 时存在，便于本地浏览器测试。 */
  readonly dev_code?: string;
}

export function sendVerificationCode(input: {
  readonly phone: string;
  readonly purpose: 'REGISTER' | 'LOGIN';
}): Promise<ApiResult<SendCodeResponse>> {
  return request<SendCodeResponse>('/api/v1/auth/sms/send', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface PlannerConfigOption {
  readonly key: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PlannerConfigResponse {
  readonly version: number;
  readonly published_at: string;
  readonly fields: Readonly<Record<string, readonly PlannerConfigOption[]>>;
  /** 后台认定的生成必填字段；可选用于兼容尚未升级的旧 API 实例。 */
  readonly generation_required_field_ids?: readonly PlannerFieldId[];
  /** 字段分类及条件必填触发器。新版本以它为准。 */
  readonly field_requirements?: readonly PlannerFieldRequirement[];
}

export function getPlannerConfig(): Promise<ApiResult<PlannerConfigResponse>> {
  return request<PlannerConfigResponse>('/api/v1/planner/config', { method: 'GET' });
}

export function logout(): Promise<ApiResult<void>> {
  return request<void>('/api/v1/auth/logout', { method: 'POST' });
}

/**
 * 13.9.2 改口令。
 *
 * 成功时服务端**吊销该账号的全部会话**并在响应头里下发一个新的 —— 因此
 * 当前这台设备仍然登录着，其他设备全部退出。界面必须把这件事说出来：
 * 它是用户改口令时想要的效果，但不说的话是个意外。
 *
 * 返回 204 无响应体。拿到 400 `AUTH_CURRENT_PASSWORD_INVALID` 时
 * `field` 是 `current_password`，`AUTH_PASSWORD_TOO_WEAK` 时是 `new_password`。
 */
export function changePassword(input: {
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<ApiResult<void>> {
  return request<void>('/api/v1/auth/password', {
    method: 'POST',
    body: JSON.stringify({
      current_password: input.currentPassword,
      new_password: input.newPassword,
    }),
  });
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
  readonly plan_version_id: string;
  readonly template_id: string;
  readonly status: 'QUEUED' | 'RENDERING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  readonly format: 'PNG' | 'PDF';
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
  readonly day_numbers: readonly number[] | null;
  readonly progress: number;
  readonly files: readonly {
    readonly format: 'PNG' | 'PDF' | 'ZIP';
    /** `ALL_DAYS` 的 PNG 每天一项；PDF 合并为一个文件，此处为 null */
    readonly day_number: number | null;
    readonly file_name: string;
    readonly url: string;
    readonly byte_size: number;
    readonly expires_at: string;
  }[];
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface CreateExportResponse {
  readonly export_id: string;
  readonly status: ExportResponse['status'];
}

export interface ExportHistoryResponse {
  readonly items: readonly ExportResponse[];
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
): Promise<ApiResult<CreateExportResponse>> {
  return request<CreateExportResponse>(
    `/api/v1/travel-plans/${encodeURIComponent(planId)}/exports`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

/** 结果页刷新后恢复该计划已有的导出任务。 */
export function listExports(planId: string): Promise<ApiResult<ExportHistoryResponse>> {
  return request<ExportHistoryResponse>(
    `/api/v1/travel-plans/${encodeURIComponent(planId)}/exports`,
    { method: 'GET' },
  );
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

// ── CR 钱包（C-6）──────────────────────────────────────────

export interface CreditQuoteResponse {
  /** `null` = 一版价目表都没发布，本次生成不计费 */
  readonly price_version: number | null;
  readonly typical_cr: number;
  readonly ceiling_cr: number;
  /** 实际会冻结的额度。「够不够」比的是它 */
  readonly hold_cr: number;
  readonly typical_cny: string;
  readonly ceiling_cny: string;
  readonly balance_cr: number;
  readonly held_cr: number;
  /**
   * 结论由服务端给。前端**不自己拿单价算** ——
   * 两处各算一份的表现是「按钮说够、提交被拒」。
   */
  readonly sufficient: boolean;
}

/**
 * 一次生成的报价。
 *
 * 只传天数：报价是展示用的估算，用户还在填表时就想看到「大概多少钱」，
 * 而那时表单必然不完整。权威金额在生成端点按标准化后的天数现算。
 */
export function quoteCredits(totalDays: number): Promise<ApiResult<CreditQuoteResponse>> {
  return request<CreditQuoteResponse>('/api/v1/credits/quote', {
    method: 'POST',
    body: JSON.stringify({ total_days: totalDays }),
  });
}

export interface LedgerEntryView {
  readonly entry_id: string;
  readonly kind: string;
  /** 有符号：进账为正、消费为负 */
  readonly amount_cr: number;
  readonly balance_after_cr: number;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly created_at: string;
}

export interface CreditLedgerResponse {
  readonly items: readonly LedgerEntryView[];
  /** 下一页的游标（上一页最后一条的 `created_at`）。`null` = 没有下一页 */
  readonly next_cursor: string | null;
}

/** 消费流水。游标用时间而不是 offset，理由见服务端 */
export function getCreditLedger(
  input: { readonly limit?: number; readonly before?: string } = {},
): Promise<ApiResult<CreditLedgerResponse>> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.before !== undefined) params.set('before', input.before);
  const query = params.size === 0 ? '' : `?${params.toString()}`;
  return request<CreditLedgerResponse>(`/api/v1/credits/ledger${query}`, { method: 'GET' });
}
