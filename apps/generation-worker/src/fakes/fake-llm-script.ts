import type { LlmClient, LlmRequest, LlmResult } from '@tps/llm';

/**
 * Fake LLM 行为编排（按调用次数）。
 *
 * 与 `FakeLlmClient`（`@tps/llm`）的关系：那个是**回放**式 —— 按调用顺序
 * 返回预置输出，不支持延迟与「前 N 次失败」。本文件在它外面再包一层
 * 装饰器，补上这两项编排能力，用于全链路测试：
 *
 *   - 「LLM 第一次延迟 5 秒，第二次成功」
 *   - 「主候选超时、备选成功」（配合 `wrapLlmFailover`）
 *
 * 零业务代码改动：`LlmClient` 接口不变，装饰器只拦截 `complete`。
 */
export interface FakeLlmCallBehavior {
  /** 延迟毫秒数（模拟模型响应慢） */
  readonly delayMs?: number;
  /** 本次调用抛错（模拟上游 5xx / 超时） */
  readonly error?: Error;
}

export interface FakeLlmScriptOptions {
  /**
   * 按调用序号编排行为（0 起）。下标越界时回落到 `default`。
   *
   * 「第一次失败第二次成功」写成 `[{ error }, {}]` 而不是在 FakeLlmClient
   * 的 responses 里放一个 Error —— 后者只能表达「这次给什么」，
   * 表达不了「这次要慢 5 秒」。
   */
  readonly calls?: readonly FakeLlmCallBehavior[];
  /** 未编排到的调用的默认行为 */
  readonly default?: FakeLlmCallBehavior;
}

/**
 * 包装 `LlmClient`，按调用次数注入延迟/故障。
 */
export function wrapLlmWithScript(client: LlmClient, options: FakeLlmScriptOptions): LlmClient {
  let callIndex = 0;

  return {
    ...client,
    complete: async (request: LlmRequest): Promise<LlmResult> => {
      const behavior = options.calls?.[callIndex] ?? options.default ?? {};
      callIndex += 1;

      if (behavior.error !== undefined) {
        throw behavior.error;
      }

      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      return client.complete(request);
    },
  };
}
