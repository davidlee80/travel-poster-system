import { SLA_BUCKETS, createCounter, createHistogram } from '@tps/observability';

/**
 * LLM 调用的指标（TP-5-01，设计稿 21.3）。
 *
 * ## 为什么埋在 Worker 而不是 @tps/llm
 *
 * 与 `plan-metrics.ts` 同一条理由：把 prom-client 拉进 `@tps/llm` 会让那个包
 * 携带一个进程级可变注册表，而它的单测大量构造 `FakeLlmClient` ——
 * 计数会在测试之间互相漏。更重要的是**调用点本来就只有一个**
 * （`generate-plan.ts` 的 `callModel`），在那里埋点不需要任何回调机制。
 *
 * 嵌入调用（`EmbeddingClient`）不计入这两个指标：21.3 的 `purpose` 只有
 * `plan` / `repair` 两个取值，而嵌入的成本量级与生成差三个数量级 ——
 * 混进同一个计数器会让「一次生成花了多少钱」算不出来。
 */

/**
 * 21.3 的 `travel_llm_tokens_total`：成本核算的唯一来源。
 *
 * `direction` 是实现追加的维度。输入与输出 token 的单价通常差 3～5 倍，
 * 合成一个数之后没有任何办法拆回去 —— 而 21.4 的「LLM 输出 token 48K」
 * 上限恰好只管输出侧。
 */
export const llmTokensTotal = createCounter({
  name: 'travel_llm_tokens_total',
  help: 'LLM token 消耗（按模型、用途、输入/输出方向）',
  labelNames: ['model', 'purpose', 'direction'],
});

/**
 * 21.3 的 `travel_llm_duration_seconds`。
 *
 * `outcome` 是实现追加的维度：超时的调用耗时恒等于超时上限，
 * 与成功调用混在同一个直方图里会把 P95 直接顶到上限值 ——
 * 于是「模型变慢了」与「模型挂了」在图上无法区分。
 *
 * 桶用 SLA_BUCKETS：单次调用的上限是 30 秒（16.3），而任务总预算 300 秒，
 * 两者都落在这组边界里。
 */
export const llmDurationSeconds = createHistogram({
  name: 'travel_llm_duration_seconds',
  help: 'LLM 单次调用耗时',
  labelNames: ['model', 'purpose', 'outcome'],
  buckets: [...SLA_BUCKETS],
});

export type LlmCallOutcome = 'succeeded' | 'timeout' | 'failed';

/** 一次调用的观测。token 只在成功时记 —— 失败的调用没有可信的用量数据 */
export function recordLlmCall(input: {
  readonly model: string;
  readonly purpose: 'plan' | 'repair';
  readonly outcome: LlmCallOutcome;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}): void {
  const { model, purpose, outcome } = input;
  llmDurationSeconds.observe({ model, purpose, outcome }, input.durationMs / 1000);

  if (outcome !== 'succeeded') return;
  if (input.inputTokens !== undefined && input.inputTokens > 0) {
    llmTokensTotal.inc({ model, purpose, direction: 'input' }, input.inputTokens);
  }
  if (input.outputTokens !== undefined && input.outputTokens > 0) {
    llmTokensTotal.inc({ model, purpose, direction: 'output' }, input.outputTokens);
  }
}
