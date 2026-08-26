import {
  DirectLlmClient,
  FakeLlmClient,
  GatewayLlmClient,
  type HttpLlmOptions,
  type LlmClient,
} from './client.js';

/**
 * 模型访问配置（TP-2-10，设计稿 1.3）。
 *
 * 1.3 的要求是「配置切换不改业务代码」。这里把「选哪个实现」收敛到
 * 一个函数，业务侧只见 `LlmClient`。
 */

export type LlmMode = 'fake' | 'direct' | 'gateway';

export const LLM_MODES: readonly LlmMode[] = ['fake', 'direct', 'gateway'];

export interface LlmConfig {
  readonly mode: LlmMode;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 3.2.2：单次重生成超时 30 秒 */
  readonly timeoutMs: number;
}

export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

function readEnv(env: Record<string, string | undefined>, key: string): string {
  return env[key]?.trim() ?? '';
}

/**
 * base URL 不得带 `/v1` 尾缀。
 *
 * `direct` 走 ofox（`https://api.ofox.ai`），而 ofox 的文档给的是 SDK 用户的
 * 写法 —— `baseURL: "https://api.ofox.ai/v1"`，因为各家 SDK 自己拼后半段路径。
 * 我们不用 SDK：两个客户端都自己拼完整路径（`/v1/chat/completions`、
 * `/v1/images/generations`）。照文档原样填进来会打到
 * `/v1/v1/chat/completions`，而那个 404 会被归类为「上游不可用」并进入重试 ——
 * 日志里只有一行 `HTTP 404`，配置看起来完全正常，直到任务耗尽重试次数失败。
 *
 * 选启动即失败而不是静默剥掉尾缀：剥离是替运维猜意图，且会让「哪一层负责拼
 * 路径」这个契约说不清。一条启动日志能在部署时就拦住，一次 404 重试风暴不能。
 *
 * 用 `\/v\d+` 而不是只匹配 `/v1`：`/v2` 填错的后果一模一样。
 */
export function assertBaseUrlHasNoApiVersion(key: string, value: string): void {
  if (/\/v\d+$/.test(value.replace(/\/+$/, ''))) {
    throw new LlmConfigError(
      `${key} 不应带 /v1 尾缀（客户端自己拼 /v1/... 路径）：${value}。` +
        'ofox 填 https://api.ofox.ai',
    );
  }
}

/**
 * 从环境变量读配置。
 *
 * `direct` 与 `gateway` 模式下 `baseUrl` 与 `apiKey` **必填且启动即校验**。
 * 缺配置时不回退到 fake：回退的表现是「上线后用户拿到的全是同一份录制计划」，
 * 而系统看起来完全正常 —— 没有报错、没有告警、响应还特别快。
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const raw = readEnv(env, 'LLM_MODE') || 'fake';
  if (!LLM_MODES.includes(raw as LlmMode)) {
    throw new LlmConfigError(`LLM_MODE 取值非法：${raw}（应为 ${LLM_MODES.join(' / ')}）`);
  }
  const mode = raw as LlmMode;

  const timeoutRaw = readEnv(env, 'LLM_TIMEOUT_MS');
  const timeoutMs = timeoutRaw === '' ? DEFAULT_LLM_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LlmConfigError(`LLM_TIMEOUT_MS 取值非法：${timeoutRaw}`);
  }

  const config: LlmConfig = {
    mode,
    model: readEnv(env, 'LLM_MODEL'),
    baseUrl: readEnv(env, mode === 'gateway' ? 'LLM_GATEWAY_URL' : 'LLM_BASE_URL'),
    apiKey: readEnv(env, 'LLM_API_KEY'),
    timeoutMs,
  };

  if (mode !== 'fake') {
    const urlKey = mode === 'gateway' ? 'LLM_GATEWAY_URL' : 'LLM_BASE_URL';
    for (const [key, value] of [
      [urlKey, config.baseUrl],
      ['LLM_API_KEY', config.apiKey],
      ['LLM_MODEL', config.model],
    ] as const) {
      if (value === '') {
        throw new LlmConfigError(`LLM_MODE=${mode} 时 ${key} 必填`);
      }
    }
    assertBaseUrlHasNoApiVersion(urlKey, config.baseUrl);
  }

  return config;
}

export interface CreateLlmClientOptions {
  /** `fake` 模式下的录制输出。缺省时用一个会明确报错的空实现 */
  readonly fixtures?: readonly unknown[];
  readonly fetchImpl?: typeof fetch;
}

export function createLlmClient(
  config: LlmConfig,
  options: CreateLlmClientOptions = {},
): LlmClient {
  if (config.mode === 'fake') {
    const fixtures = options.fixtures ?? [
      new Error('LLM_MODE=fake 但没有提供录制输出（createLlmClient 的 fixtures）'),
    ];
    return new FakeLlmClient(fixtures);
  }

  const httpOptions: HttpLlmOptions = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };

  return config.mode === 'gateway'
    ? new GatewayLlmClient(httpOptions)
    : new DirectLlmClient(httpOptions);
}
