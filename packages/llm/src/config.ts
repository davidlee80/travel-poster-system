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
    for (const [key, value] of [
      [mode === 'gateway' ? 'LLM_GATEWAY_URL' : 'LLM_BASE_URL', config.baseUrl],
      ['LLM_API_KEY', config.apiKey],
      ['LLM_MODEL', config.model],
    ] as const) {
      if (value === '') {
        throw new LlmConfigError(`LLM_MODE=${mode} 时 ${key} 必填`);
      }
    }
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
