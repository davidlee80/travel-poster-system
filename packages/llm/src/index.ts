/**
 * 模型访问层（设计稿 1.3、6.3、15.2）。
 *
 * 交付节奏：
 *   TP-2-21  向量化（本地哈希实现 + 接口）  ← 本增量
 *   TP-2-10  `LlmClient` + Direct + Gateway
 *   TP-2-11  Prompt 模板与结构化输出
 *
 * 本包**不含任何业务规则**：它只负责「把文本变成向量」「把提示变成结构化
 * 输出」。规则与修复在 `@tps/planning`，两者不互相依赖。
 */

export {
  EMBEDDING_DIMENSIONS,
  LocalHashingEmbeddingClient,
  cosineSimilarity,
  hashingVector,
  toVectorLiteral,
  tokenize,
  type EmbeddingClient,
} from './embedding.js';
