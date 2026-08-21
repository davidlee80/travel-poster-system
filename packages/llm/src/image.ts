import type { AssetWarningCode } from '@tps/schemas';

import { LlmConfigError } from './config.js';

/**
 * 图片模型访问（TP-4-01/03，设计稿 11.1、21.2 措施二、13.7）。
 *
 * ## 与 `LlmClient` 同构，但不是同一个接口
 *
 * 两者的请求与响应完全不同（提示 + JSON Schema → 结构化对象 vs
 * 提示 + 尺寸 → 图片字节），错误码也不同（`PLAN_LLM_*` 是阻断类、
 * `ASSET_AI_GENERATION_*` 是告警类，13.7）。硬塞进一个接口的代价是
 * 每个实现都要处理一半用不到的字段，而「图片失败阻断了任务」这种缺陷
 * 会因此变得可能。
 *
 * ## 超时是分层的三个值，而不是一个常量
 *
 * 21.2 措施二原本把 V1.0 的 40 秒压到 20 秒，理由是算术：T2 目标 P95 < 110 秒
 * 扣掉 T1 的 75 秒，留给素材解析的窗口只有 35 秒。
 *
 * V1.8 引入多模型候选池后那个算术的输入变了：T2 调到 155 秒、窗口放宽到
 * 80 秒（= 40 秒/候选 × 2），而超时成了可配项。于是拆成三个值：
 *
 * ```text
 * AI_IMAGE_TIMEOUT_MS            40s  主路径单候选
 * AI_IMAGE_PREHEAT_TIMEOUT_MS    60s  预热，不在 T2 窗口内
 * DEFAULT_IMAGE_JOB_AI_BUDGET_MS 80s  任务级累计耗时（时延的唯一防线）
 * ```
 *
 * ## 不重试（这一条没变）
 *
 * 13.7 的「Worker 内部重试 3 次」对 LLM 与上传成立，对图片生成不成立：
 * 单槽位预算是 800 毫秒（10.2），而 AI 兜底本身就是超出预算的例外路径。
 * 需要「再试一次」时用的是**候选模型故障转移**（`failover.ts`）而不是重试 ——
 * 同一个模型刚超时，再发一次给它的成功概率不比换一个高，而钱是一样的。
 */

/**
 * 主路径的默认单候选超时。
 *
 * 曾是**硬上限**（21.2 措施二把 V1.0 的 40 秒压到 20 秒）。多模型故障转移
 * 引入后它只是默认值：上限改由 `loadImageConfig` 按「与任务级 AI 预算的关系」
 * 校验，而 T2 目标本身成了可以有意调整的量。40 秒是本轮定的折中值。
 */
export const AI_IMAGE_TIMEOUT_MS = 40_000;

/**
 * 预热路径的默认超时。
 *
 * `assets:preheat` 不在 T2 的 SLA 窗口内 —— 预热过的目的地本来就不需要主路径
 * 再生图，所以那里可以慢慢生。分成两个变量而不是共用一个，是因为共用会强迫
 * 两条路径里较严的那条决定另一条：要么主路径慢到违约 T2，
 * 要么预热被压到跟主路径一样紧而白白降低成图率。
 */
export const AI_IMAGE_PREHEAT_TIMEOUT_MS = 60_000;

/**
 * 任务级 AI 累计耗时预算的默认值。
 *
 * 21.4 的「单任务 3 张」与 21.2 的「Hero 最多 2 次」都是**用次数近似时延**，
 * 而那个近似的前提是「一次生成最多 20 秒」这个常量。超时可配之后，同样的
 * 「2 次」可以是 80 秒也可以是 240 秒，次数就不再约束时延。
 *
 * 因此时延要有自己的预算：次数管成本、耗时管时延，两者先到先停。
 */
export const DEFAULT_IMAGE_JOB_AI_BUDGET_MS = 80_000;

/**
 * 21.2 的素材解析窗口 = T2(155 秒) − T1(75 秒)。
 *
 * 这两个里程碑此前只存在于设计文档与告警规则里，没有代码常量 ——
 * 于是「AI 预算是否越界」这件事没有任何一处能判定。放在这里是因为它唯一的
 * 用途就是校验 `IMAGE_JOB_AI_BUDGET_MS`；真要用到别处再往上提。
 */
export const ASSET_RESOLUTION_WINDOW_MS = 80_000;

export interface ImageRequest {
  readonly prompt: string;
  /** 供应商支持独立负向字段时使用；不支持时正向提示词里已含同样内容 */
  readonly negativePrompt: string;
  readonly width: number;
  readonly height: number;
  /**
   * 随机种子。
   *
   * 二十章要求把它落进 `generation_metadata`，与
   * `prompt_template_version` 一起「保证产物可复现」。
   * **这一点取决于供应商是否支持 seed** —— OpenAI 的 images 端点当前不支持，
   * 而 SD / Flux 系兼容端点支持。不支持时我们记录的是「请求时传了什么」，
   * 不是「产物由什么决定」。把这句话写在类型上而不是留给排查的人自己发现。
   */
  readonly seed: number;
  readonly timeoutMs: number;
  /**
   * 外部取消信号（候选模型故障转移用）。
   *
   * 与 `timeoutMs` 是两件事：后者是「这次调用最多等多久」，前者是
   * 「别等了，已经有别的候选成功了」。两者取并集 —— 任一触发即中止。
   *
   * 没有它的话 `raceFirstSuccess` 的 abort 是空操作：被放弃的请求会继续
   * 占着连接与上游算力直到自己超时，而此刻已经没人在等它的结果。
   */
  readonly signal?: AbortSignal;
}

export interface ImageResult {
  /** 原始字节（PNG 或 WebP）。11.2 的后处理在调用方，本包不依赖 sharp */
  readonly bytes: Uint8Array;
  readonly model: string;
  readonly modelVersion: string;
  /** 实际生效的种子。供应商回传时用它，否则回显请求值 */
  readonly seed: number;
  /** 21.4 的成本核算单位。一次调用一张图记 1 */
  readonly costUnits: number;
}

export interface ImageClient {
  readonly model: string;
  generate(request: ImageRequest): Promise<ImageResult>;
}

export class ImageTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`图片生成超过 ${timeoutMs} 毫秒上限`);
    this.name = 'ImageTimeoutError';
  }
}

export class ImageUnavailableError extends Error {
  constructor(detail: string) {
    super(`图片生成服务不可用：${detail}`);
    this.name = 'ImageUnavailableError';
  }
}

/**
 * 映射到 13.7 的**告警**码（不是错误码）。
 *
 * 返回类型是 `AssetWarningCode` 而不是 `string`：这两个码没有 httpStatus
 * 也没有 retryable，它们只能进 `generation_jobs.warnings`。
 * 类型上就不可能被当成 HTTP 错误返回。
 */
export function imageWarningCode(error: unknown): AssetWarningCode {
  return error instanceof ImageTimeoutError
    ? 'ASSET_AI_GENERATION_TIMEOUT'
    : 'ASSET_AI_GENERATION_FAILED';
}

// ── Fake ────────────────────────────────────────────────────

export type FakeImageRenderer = (request: ImageRequest) => Promise<Uint8Array> | Uint8Array;

/**
 * 由调用方提供渲染函数的假实现。
 *
 * 为什么不像 `FakeLlmClient` 那样预置一组固定响应：图片响应是**字节**，
 * 而下游的 11.2 后处理会校验分辨率与比例（`processImage`）。一组固定字节
 * 只对一种尺寸有效，Hero（16:6）与美食（4:3）就要各备一份，
 * 而两者的尺寸还取决于 `min_width` 配置。让调用方按请求渲染更简单，
 * 也让「请求的尺寸有没有传对」这件事在假实现下同样可测。
 *
 * 生成图片字节需要 sharp（原生依赖），而本包被所有应用引用 ——
 * 因此渲染函数由 generation-worker 注入，本包不引入 sharp。
 */
export class FakeImageClient implements ImageClient {
  readonly calls: ImageRequest[] = [];

  constructor(
    private readonly renderer: FakeImageRenderer,
    readonly model = 'fake-image',
  ) {}

  async generate(request: ImageRequest): Promise<ImageResult> {
    this.calls.push(request);
    const bytes = await this.renderer(request);
    return {
      bytes,
      model: this.model,
      modelVersion: 'fake',
      seed: request.seed,
      /*
       * 成本记 0 而不是 1：`travel_ai_image_total` 与成本报表是同一套数据，
       * 假实现记 1 会让开发环境的调用混进成本核算（与 FakeLlmClient
       * 的 token 计数同一处理）。
       */
      costUnits: 0,
    };
  }
}

// ── OpenAI 兼容的 HTTP 实现 ─────────────────────────────────

interface ImageGenerationResponse {
  readonly data?: readonly {
    readonly b64_json?: string;
    readonly url?: string;
    readonly seed?: number;
  }[];
  readonly model?: string;
}

export interface HttpImageOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  /** 网关模式额外带业务标识头，让网关侧能按调用方归集成本 */
  readonly gateway?: boolean;
}

export class HttpImageClient implements ImageClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gateway: boolean;

  constructor(options: HttpImageOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.gateway = options.gateway ?? false;
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const body = {
      model: this.model,
      prompt: request.prompt,
      /*
       * `negative_prompt` 与 `seed` 不在 OpenAI 的 images 契约里，但在
       * SD / Flux 系的兼容端点里是标准字段。多传的字段被 OpenAI 忽略而不是
       * 报错（它按已知键解析），因此两边都能工作。
       * 真正的兜底是 `renderPrompt` 已经把禁止项写进了正向提示词 ——
       * 供应商忽略 `negative_prompt` 时，11.3 的约束仍然被表达了一次。
       */
      negative_prompt: request.negativePrompt,
      seed: request.seed,
      size: `${request.width}x${request.height}`,
      n: 1,
      /*
       * 必须要 base64 而不是 URL：二十章明确「外部图片应下载、审核并转存
       * 到自己的对象存储，不建议页面直接引用第三方地址」。
       * 要 URL 就得再发一次请求去下载，多一次失败面与一次超时预算。
       */
      response_format: 'b64_json',
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...(this.gateway ? { 'x-tps-service': 'travel-poster-system' } : {}),
        },
        body: JSON.stringify(body),
        /*
         * 两个信号取并集：自身超时，或外部说「别等了」（已有候选成功）。
         * 外部 abort 抛的是 AbortError 而不是 TimeoutError，因此下面会归到
         * `ImageUnavailableError` —— 那是对的，它不是超时而是被放弃。
         */
        signal: AbortSignal.any([
          AbortSignal.timeout(request.timeoutMs),
          ...(request.signal === undefined ? [] : [request.signal]),
        ]),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new ImageTimeoutError(request.timeoutMs);
      }
      throw new ImageUnavailableError(error instanceof Error ? error.name : '网络错误');
    }

    if (!response.ok) {
      /*
       * 只带状态码，不带响应体：上游的错误体会回显我们发过去的提示词，
       * 而提示词里含目的地与主题。二十章禁止请求全文落日志，回显同样违反它。
       */
      throw new ImageUnavailableError(`HTTP ${response.status}`);
    }

    let payload: ImageGenerationResponse;
    try {
      payload = (await response.json()) as ImageGenerationResponse;
    } catch {
      throw new ImageUnavailableError('响应不是合法 JSON');
    }

    const first = payload.data?.[0];
    const b64 = first?.b64_json;
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new ImageUnavailableError('响应缺少 data[0].b64_json');
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    } catch {
      throw new ImageUnavailableError('data[0].b64_json 不是合法 base64');
    }
    if (bytes.byteLength === 0) {
      // Buffer.from 对非法 base64 不抛错，只会给出更短的结果 —— 空结果要显式拦住
      throw new ImageUnavailableError('data[0].b64_json 解码后为空');
    }

    return {
      bytes,
      model: payload.model ?? this.model,
      /*
       * 供应商多数不回传版本号。用模型名兜底而不是留空字符串：
       * 二十章的 `model_version` 是非空字段，而「不知道」比空串更有信息 ——
       * 空串会被误读成「没有版本概念」。
       */
      modelVersion: payload.model ?? this.model,
      seed: first?.seed ?? request.seed,
      costUnits: 1,
    };
  }
}

// ── 配置 ────────────────────────────────────────────────────

export type ImageMode = 'fake' | 'direct' | 'gateway';

export const IMAGE_MODES: readonly ImageMode[] = ['fake', 'direct', 'gateway'];

export interface ImageConfig {
  readonly mode: ImageMode;
  /** 主模型。候选池未配置时它就是唯一候选（回落路径） */
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 主路径的单候选超时 */
  readonly timeoutMs: number;
  /** 预热路径的单候选超时。不受 SLA 窗口约束 */
  readonly preheatTimeoutMs: number;
  /** 任务级 AI 累计耗时预算。次数管成本，这一项管时延 */
  readonly jobAiBudgetMs: number;
  /**
   * 配置越界的说明，非空时调用方**必须**打进启动日志。
   *
   * 存在的理由见 `loadImageConfig` 里那段注释：这条约束从硬拒改成了 warn，
   * 而「允许」的前提是「不静默」。没人显示它的话这个改动就退化成了单纯放宽。
   */
  readonly slaWarning?: string;
}

function readEnv(env: Record<string, string | undefined>, key: string): string {
  return env[key]?.trim() ?? '';
}

/**
 * 图片模型配置。与 `LLM_*` 分开的一组变量。
 *
 * 不复用 `LLM_BASE_URL`：文本与图片在多数供应商上是**不同的端点**，
 * 甚至不同的供应商（文本走企业网关、图片走另一家）。复用一套变量的表现是
 * 「配了网关之后图片请求全部 404」，而排查方向会先落在图片模型名上。
 */
export function loadImageConfig(
  env: Record<string, string | undefined> = process.env,
): ImageConfig {
  const raw = readEnv(env, 'IMAGE_MODE') || 'fake';
  if (!IMAGE_MODES.includes(raw as ImageMode)) {
    throw new LlmConfigError(`IMAGE_MODE 取值非法：${raw}（应为 ${IMAGE_MODES.join(' / ')}）`);
  }
  const mode = raw as ImageMode;

  const readMs = (key: string, fallback: number): number => {
    const raw = readEnv(env, key);
    const value = raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new LlmConfigError(`${key} 取值非法：${raw}`);
    }
    return value;
  };

  const timeoutMs = readMs('IMAGE_TIMEOUT_MS', AI_IMAGE_TIMEOUT_MS);
  const preheatTimeoutMs = readMs('IMAGE_PREHEAT_TIMEOUT_MS', AI_IMAGE_PREHEAT_TIMEOUT_MS);
  const jobAiBudgetMs = readMs('IMAGE_JOB_AI_BUDGET_MS', DEFAULT_IMAGE_JOB_AI_BUDGET_MS);

  /*
   * ## 为什么这一条仍然硬拒
   *
   * 单个候选就能吃掉整个任务的 AI 预算时，候选链**根本轮不到第二个** ——
   * 也就是配了故障转移却不会生效。这不是「更慢」而是「功能静默失效」，
   * 与下面那条（只是更慢）性质不同。
   */
  if (timeoutMs > jobAiBudgetMs) {
    throw new LlmConfigError(
      `IMAGE_TIMEOUT_MS(${timeoutMs}) 不得超过 IMAGE_JOB_AI_BUDGET_MS(${jobAiBudgetMs})：` +
        '单候选就能耗尽任务预算时，候选链轮不到第二个，故障转移不会生效',
    );
  }

  /*
   * ## 为什么这一条从硬拒改成了 warn
   *
   * 原先 `IMAGE_TIMEOUT_MS > 20000` 是硬拒，理由写在 21.2：T2 目标是在
   * 「AI 生成 ≤ 20 秒」的前提下算出来的，允许配大等于让一个配置项静默
   * 推翻 SLA。
   *
   * 而现在 SLA 本身成了可以被有意调整的量（T2 110 → 155 秒），硬拒会挡住
   * **合法**的调整。所以保留的是「不静默」，放开的是「不允许」——
   * 越界时照配置执行，但把后果明确写出来，由调用方在启动日志里显示。
   *
   * 静默才是那条硬拒真正反对的东西。
   */
  const slaWarning =
    jobAiBudgetMs > ASSET_RESOLUTION_WINDOW_MS
      ? `IMAGE_JOB_AI_BUDGET_MS(${jobAiBudgetMs}) 超过 21.2 的素材窗口` +
        `(${ASSET_RESOLUTION_WINDOW_MS} = T2 155s − T1 75s)：T2 会随之延后，` +
        '要么同步调高 T2 目标与告警阈值，要么把 AI 生成移出主路径（assets:preheat）'
      : undefined;

  const config: ImageConfig = {
    mode,
    model: readEnv(env, 'IMAGE_MODEL'),
    baseUrl: readEnv(env, mode === 'gateway' ? 'IMAGE_GATEWAY_URL' : 'IMAGE_BASE_URL'),
    apiKey: readEnv(env, 'IMAGE_API_KEY'),
    timeoutMs,
    preheatTimeoutMs,
    jobAiBudgetMs,
    // exactOptionalPropertyTypes：不能把 undefined 显式赋给可选属性
    ...(slaWarning === undefined ? {} : { slaWarning }),
  };

  if (mode !== 'fake') {
    for (const [key, value] of [
      [mode === 'gateway' ? 'IMAGE_GATEWAY_URL' : 'IMAGE_BASE_URL', config.baseUrl],
      ['IMAGE_API_KEY', config.apiKey],
      ['IMAGE_MODEL', config.model],
    ] as const) {
      if (value === '') {
        throw new LlmConfigError(`IMAGE_MODE=${mode} 时 ${key} 必填`);
      }
    }
  }

  return config;
}

export interface CreateImageClientOptions {
  /** `fake` 模式下的渲染函数。缺省时生成必然失败（降级链因此可测） */
  readonly renderer?: FakeImageRenderer;
  readonly fetchImpl?: typeof fetch;
}

export function createImageClient(
  config: ImageConfig,
  options: CreateImageClientOptions = {},
): ImageClient {
  if (config.mode === 'fake') {
    const renderer =
      options.renderer ??
      (() => {
        throw new ImageUnavailableError('IMAGE_MODE=fake 但没有提供渲染函数');
      });
    return new FakeImageClient(renderer);
  }

  return new HttpImageClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    gateway: config.mode === 'gateway',
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
