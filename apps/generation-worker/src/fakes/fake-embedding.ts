import type { EmbeddingClient } from '@tps/llm';

/**
 * Fake Embedding 行为编排。
 *
 * `LocalHashingEmbeddingClient`（`@tps/llm`）是 V1 的默认实现 —— 纯本地计算，
 * 没有失败路径也没有延迟。本文件包一层装饰器，补上这两项编排能力，
 * 用于全链路测试「向量化失败」与「向量化延迟」的降级路径：
 *
 *   - `generate-plan.ts`：向量化失败不阻断保存（写入 `planEmbedding: null`）；
 *   - `local-library.ts`：查询向量化失败退化为按质量排序。
 *
 * 零业务代码改动：`EmbeddingClient` 接口不变，装饰器只拦截 `embed`。
 */
export interface FakeEmbeddingBehavior {
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 抛错（模拟嵌入服务不可用） */
  readonly error?: Error;
}

/**
 * 包装 `EmbeddingClient`，注入延迟/故障。
 */
export function wrapEmbedding(client: EmbeddingClient, behavior: FakeEmbeddingBehavior): EmbeddingClient {
  return {
    ...client,
    embed: async (texts) => {
      if (behavior.error !== undefined) {
        throw behavior.error;
      }

      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      return client.embed(texts);
    },
  };
}
