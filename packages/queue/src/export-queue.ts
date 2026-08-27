import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { TraceCarrierSchema } from './trace-context.js';

/**
 * 导出任务队列（TP-4-12，设计稿 13.5、22.1）。
 *
 * ## 为什么与生成队列分开
 *
 * 两者的消费者是**不同的进程**：生成在 generation-worker，导出在
 * render-worker（后者带 Chromium，镜像大得多，22.3.2）。共用一个队列
 * 就要让两个进程都能处理两种消息 —— 而那意味着 generation-worker 也要装
 * Chromium（+300MB 与一套 Linux 依赖），或者靠消息类型分派后把不属于自己的
 * 消息扔回去（那会造成消息在两个进程之间反复投递）。
 *
 * 重试策略也不同：导出失败按 16.3 是**非阻断**的（重试 1 次后跳过，
 * 记 `warnings`），而生成失败会让整个任务 FAILED。
 *
 * ## 载荷只放 export_id
 *
 * 与生成队列同一处理（见 plan-queue.ts）：范围、格式、天号都在 `exports`
 * 行里，Worker 读回来即可。放进载荷的代价是「载荷与库里的行可能不一致」——
 * 重试时用的是入队那一刻的快照。
 */

export const EXPORT_QUEUE_NAME = 'travel-plan-export';

export const ExportJobPayloadSchema = z.object({
  exportId: z.string().min(1),
  /** W3C Trace Context（TP-5-03）。理由同 plan-queue.ts */
  traceContext: TraceCarrierSchema.optional(),
});

export type ExportJobPayload = z.infer<typeof ExportJobPayloadSchema>;

/**
 * 16.3：`EXPORT_PNG_FAILED` / `EXPORT_PDF_FAILED` 都是「重试 1 次后跳过」。
 *
 * 因此 `attempts: 2`（首次 + 一次重试），而不是生成队列的 3。
 * 渲染失败多数是资源问题（/dev/shm 不足、内存压力），退避后重试一次有意义；
 * 但导出是非阻断的 —— 用户已经能看 HTML 页面了，反复重渲染一个 14 天的 PDF
 * 只是在占着 Chromium 的并发槽位，而那会拖慢别人的导出。
 */
export const EXPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
};

export interface ExportQueue {
  enqueue(payload: ExportJobPayload): Promise<string>;
  /** 等待中的任务数。取 waiting 而不含 active，理由见 `PlanQueue.depth` */
  depth(): Promise<number>;
  close(): Promise<void>;
}

export class BullMqExportQueue implements ExportQueue {
  private readonly queue: Queue;

  constructor(connection: Redis, queueName: string = EXPORT_QUEUE_NAME) {
    this.queue = new Queue(queueName, { connection, defaultJobOptions: EXPORT_JOB_OPTIONS });
  }

  async enqueue(payload: ExportJobPayload): Promise<string> {
    // 用 export_id 作为队列 job id：同一个导出任务只会存在一条消息
    const job = await this.queue.add(EXPORT_QUEUE_NAME, payload, { jobId: payload.exportId });
    return job.id ?? payload.exportId;
  }

  async depth(): Promise<number> {
    return this.queue.getWaitingCount();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** 进程内实现：单测与无 Redis 的本地开发用。**不会真的执行任务** */
export class InMemoryExportQueue implements ExportQueue {
  readonly enqueued: ExportJobPayload[] = [];

  enqueue(payload: ExportJobPayload): Promise<string> {
    if (!this.enqueued.some((entry) => entry.exportId === payload.exportId)) {
      this.enqueued.push(payload);
    }
    return Promise.resolve(payload.exportId);
  }

  depth(): Promise<number> {
    return Promise.resolve(this.enqueued.length);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
