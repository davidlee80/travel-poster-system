/**
 * 模型访问层（设计稿 1.3、6.3、15.2）。
 *
 * 交付节奏：
 *   TP-2-21  向量化（本地哈希实现 + 接口）  ← 本增量
 *   TP-2-10  `LlmClient` + Direct + Gateway
 *   TP-2-11  Prompt 模板与结构化输出
 *   TP-4-01  `ImageClient` + 20 秒超时（11.1、21.2 措施二）
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

export {
  DirectLlmClient,
  FakeLlmClient,
  GatewayLlmClient,
  LlmOutputUnparseableError,
  LlmTimeoutError,
  LlmUnavailableError,
  llmErrorCode,
  type HttpLlmOptions,
  type LlmClient,
  type LlmJsonSchema,
  type LlmPurpose,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from './client.js';

export {
  AI_IMAGE_PREHEAT_TIMEOUT_MS,
  AI_IMAGE_TIMEOUT_MS,
  ASSET_RESOLUTION_WINDOW_MS,
  DEFAULT_IMAGE_JOB_AI_BUDGET_MS,
  FakeImageClient,
  HttpImageClient,
  IMAGE_MODES,
  ImageTimeoutError,
  ImageUnavailableError,
  createImageClient,
  imageWarningCode,
  loadImageConfig,
  type CreateImageClientOptions,
  type FakeImageRenderer,
  type HttpImageOptions,
  type ImageClient,
  type ImageConfig,
  type ImageMode,
  type ImageRequest,
  type ImageResult,
} from './image.js';

export {
  DEFAULT_IMAGE_SEARCH_DAILY_BUDGET,
  FakeLicensedSourceClient,
  IMAGE_SEARCH_MODES,
  IMAGE_SEARCH_TIMEOUT_MS,
  ImageSearchTimeoutError,
  ImageSearchUnavailableError,
  createLicensedSourceClient,
  loadImageSearchConfig,
  searchWarningCode,
  type CreateLicensedSourceClientOptions,
  type FakeLicensedSourceOptions,
  type FakeSearchBehavior,
  type ImageSearchConfig,
  type ImageSearchMode,
  type LicensedSourceCandidate,
  type LicensedSourceClient,
  type LicensedSourceQuery,
} from './image-search.js';

export {
  DEFAULT_LLM_TIMEOUT_MS,
  LLM_MODES,
  LlmConfigError,
  createLlmClient,
  loadLlmConfig,
  type CreateLlmClientOptions,
  type LlmConfig,
  type LlmMode,
} from './config.js';

export {
  MAX_DAYS_PER_SEGMENT,
  MAX_TOKENS_TIERS,
  PLAN_SYSTEM_PROMPT,
  buildPlanPrompt,
  buildRepairPrompt,
  maxTokensForDays,
  mergeSegments,
  planSegments,
  type PlanPromptInput,
  type PlanSegment,
  type PromptMessages,
  type RepairPromptInput,
} from './prompt.js';

export {
  raceFirstSuccess,
  wrapImageFailover,
  wrapLlmFailover,
  type Attempt,
  type FailoverClientOptions,
  type FailoverOutcome,
  type RaceOptions,
  type RaceResult,
} from './failover.js';
