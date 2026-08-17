import type { PlanErrorCode } from '@tps/schemas';

/**
 * 大模型访问抽象（TP-2-10，设计稿 1.3、6.3）。
 *
 * ## 三个实现，一个接口
 *
 * ```text
 * FakeLlmClient     回放录制好的输出。本地开发与 CI 用它 ——
 *                   不需要凭据，也不会因为模型改版让测试变红
 * DirectLlmClient   直连供应商的 OpenAI 兼容端点
 * GatewayLlmClient  经企业 AI 网关（同为 OpenAI 兼容），
 *                   由网关统一做鉴权、限流、路由与成本归集
 * ```
 *
 * 「配置切换不改业务代码」是 1.3 的明确要求：业务侧只见 `LlmClient`，
 * 选哪个实现由 `createLlmClient` 按配置决定。
 *
 * ## 为什么错误要分三类
 *
 * 13.7 给了三个不同的码，客户端处置各不相同：
 *   `PLAN_LLM_UNAVAILABLE`        可重试，上游不可用
 *   `PLAN_LLM_TIMEOUT`            可重试，但要计入 3.2.2 的重生成次数
 *   `PLAN_LLM_OUTPUT_UNPARSEABLE` 可重试，且说明提示或 schema 有问题
 * 合成一个「调用失败」会让第三种永远查不出来 —— 它是**我们的**缺陷，
 * 而前两种是上游的。
 */

export type LlmPurpose = 'plan' | 'repair';

export interface LlmJsonSchema {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  /** 6.3：通过结构化输出获取单个 JSON 对象，**不解析 Markdown 代码块** */
  readonly jsonSchema: LlmJsonSchema;
  /** 6.3 的分档值，由调用方按天数算好 */
  readonly maxTokens: number;
  readonly purpose: LlmPurpose;
  readonly timeoutMs: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmResult {
  /** 已解析的 JSON 对象，未经业务校验 */
  readonly data: unknown;
  readonly model: string;
  readonly usage: LlmUsage;
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

export class LlmUnavailableError extends Error {
  constructor(detail: string) {
    super(`大模型服务不可用：${detail}`);
    this.name = 'LlmUnavailableError';
  }
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`大模型调用超过 ${timeoutMs} 毫秒上限`);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmOutputUnparseableError extends Error {
  constructor(detail: string) {
    super(`大模型输出无法解析：${detail}`);
    this.name = 'LlmOutputUnparseableError';
  }
}

/** 映射到 13.7 的错误码 */
export function llmErrorCode(error: unknown): PlanErrorCode {
  if (error instanceof LlmTimeoutError) return 'PLAN_LLM_TIMEOUT';
  if (error instanceof LlmOutputUnparseableError) return 'PLAN_LLM_OUTPUT_UNPARSEABLE';
  if (error instanceof LlmUnavailableError) return 'PLAN_LLM_UNAVAILABLE';
  /*
   * 未知异常按不可用处理（可重试）而不是按输出不可解析：
   * 前者的重试会真的可能成功，后者标错会让运维去查提示词，
   * 而问题其实在网络上。
   */
  return 'PLAN_LLM_UNAVAILABLE';
}

// ── Fake ────────────────────────────────────────────────────

/**
 * 回放式假实现。
 *
 * 按调用顺序返回预置输出；用完后重复最后一个 —— 3.2.2 的定向重生成会
 * 多次调用，而多数测试只关心「第一次给什么」。
 *
 * `calls` 保留每次请求，供断言提示内容（6.3 的约束是否真的写进了提示）。
 */
export class FakeLlmClient implements LlmClient {
  readonly model = 'fake-recorded';
  readonly calls: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly unknown[]) {
    if (responses.length === 0) {
      throw new Error('FakeLlmClient 至少需要一个预置输出');
    }
  }

  complete(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request);
    const data = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;

    if (data instanceof Error) return Promise.reject(data);

    return Promise.resolve({
      data,
      model: this.model,
      /*
       * token 计数给 0 而不是编一个数：`travel_llm_tokens_total` 是成本核算
       * 指标，假数据混进去会让成本报表在开发与生产之间无法区分。
       */
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
}

// ── OpenAI 兼容的 HTTP 实现 ─────────────────────────────────

interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly model?: string;
}

export interface HttpLlmOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 注入以便测试；生产用全局 fetch */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Direct 与 Gateway 的公共实现。
 *
 * 两者的差别只有**端点与凭据**：网关本身是 OpenAI 兼容的，请求体一字不差。
 * 因此写两份 HTTP 逻辑没有意义 —— 那只会让「重试策略在直连路径上改了、
 * 网关路径上没改」这类偏差成为可能。子类只提供 URL 与请求头。
 */
abstract class HttpLlmClient implements LlmClient {
  readonly model: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpLlmOptions) {
    this.model = options.model;
    // 去掉末尾斜杠，避免拼出 `//v1/chat/completions`
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  protected abstract endpoint(): string;
  protected abstract headers(): Record<string, string>;

  async complete(request: LlmRequest): Promise<LlmResult> {
    const body = {
      model: this.model,
      max_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      /*
       * 6.3：「通过结构化输出（JSON Schema 约束模式）获取，不解析 Markdown
       * 代码块」。`strict: true` 让供应商在解码阶段就约束输出形状 ——
       * 靠提示词要求「只输出 JSON」在长输出下必然偶发失败，
       * 而那种失败会以「第 9 天之后是一段散文」的形式出现。
       */
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: true,
        },
      },
      // 行程生成要稳定可复现，不要发散
      temperature: 0.3,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.endpoint()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      // AbortSignal.timeout 触发时抛 TimeoutError（DOMException）
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new LlmTimeoutError(request.timeoutMs);
      }
      throw new LlmUnavailableError(error instanceof Error ? error.name : '网络错误');
    }

    if (!response.ok) {
      /*
       * 只带状态码，不带响应体。上游的错误体可能回显我们发过去的提示
       * （含用户的自由文本），而这里的字符串会进日志与错误详情 ——
       * 二十章禁止 `raw_request` 全文落日志，回显同样违反它。
       */
      throw new LlmUnavailableError(`HTTP ${response.status}`);
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new LlmOutputUnparseableError('响应不是合法 JSON');
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new LlmOutputUnparseableError('响应缺少 message.content');
    }
    /*
     * 输出被截断时内容是**语法上不完整的 JSON**，解析必然失败。
     * 先看 finish_reason 是为了给出正确的原因 —— 否则排查方向会从
     * 「max_tokens 分档不够（6.3）」错误地转向「模型不听指令」。
     */
    if (choice?.finish_reason === 'length') {
      throw new LlmOutputUnparseableError(`输出在 ${request.maxTokens} token 处被截断`);
    }

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new LlmOutputUnparseableError('message.content 不是合法 JSON');
    }

    return {
      data,
      model: payload.model ?? this.model,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** 直连供应商 */
export class DirectLlmClient extends HttpLlmClient {
  protected endpoint(): string {
    return '/v1/chat/completions';
  }

  protected headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }
}

/**
 * 经企业 AI 网关。
 *
 * 网关暴露 OpenAI 兼容的 `POST /v1/chat/completions`，鉴权同样用
 * `Authorization: Bearer <api_key>`。额外带一个业务标识请求头，
 * 让网关侧能按调用方归集成本 —— 这是走网关的主要收益之一，
 * 不带的话所有调用在网关报表里混成一团。
 */
export class GatewayLlmClient extends HttpLlmClient {
  protected endpoint(): string {
    return '/v1/chat/completions';
  }

  protected headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'x-tps-service': 'travel-poster-system',
    };
  }
}
