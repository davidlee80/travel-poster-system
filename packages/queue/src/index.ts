/**
 * 队列与 Redis 基础设施（设计稿 13.8、22.1）。
 *
 * 单独成包而不是塞进 `@tps/db`：后者的依赖是 `pg`，而这里是 `ioredis` 与
 * `bullmq`。合在一起会让只需要数据库的进程（迁移 CLI、retention-worker）
 * 也拖上队列依赖。
 */

/**
 * 转出 `Redis` 类型，让消费方不必自己依赖 ioredis。
 *
 * 只需要类型的包（如 apps/api 的 RedisSessionStore）因此不用把 ioredis
 * 写进自己的 dependencies —— 少一处版本需要对齐。
 */
export type { Redis } from 'ioredis';

export {
  ASSET_LOCK_TTL_SECONDS,
  InMemoryAssetLock,
  RedisAssetLock,
  type AssetLock,
} from './asset-lock.js';

export {
  DLQ_KEY_PREFIX,
  DLQ_MAX_ENTRIES,
  InMemoryDeadLetterQueue,
  RedisDeadLetterQueue,
  type DeadLetterEntry,
  type DeadLetterQueue,
} from './dlq.js';

export {
  RedisCounterStore,
  RedisIdempotencyLock,
  RedisJobLock,
  createQueueRedis,
  createRedis,
} from './redis.js';

export {
  BullMqExportQueue,
  EXPORT_JOB_OPTIONS,
  EXPORT_QUEUE_NAME,
  ExportJobPayloadSchema,
  InMemoryExportQueue,
  type ExportJobPayload,
  type ExportQueue,
} from './export-queue.js';

export {
  BullMqPlanQueue,
  DEFAULT_JOB_OPTIONS,
  GenerationJobPayloadSchema,
  InMemoryPlanQueue,
  PLAN_QUEUE_NAME,
  type GenerationJobPayload,
  type PlanQueue,
} from './plan-queue.js';

export {
  TraceCarrierSchema,
  captureTraceContext,
  restoreTraceContext,
  traceIdFromCarrier,
  withRestoredTrace,
  type TraceCarrier,
} from './trace-context.js';
