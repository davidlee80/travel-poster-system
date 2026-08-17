import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * 生成任务队列（TP-2-09，设计稿 13.1、22.1）。
 *
 * ## 载荷里只放标识符，不放请求体
 *
 * `travel_requests.raw_request` 与 `normalized_request` 已经落库，Worker 用
 * `request_id` 读回来即可。把请求体塞进队列有三个具体问题：
 *   1. Redis 里会出现一份 L1 个人数据的副本（二十章），而它不受
 *      15.1 的保留策略管辖 —— 用户删了账号，Redis 里那份还在；
 *   2. 队列积压时 Redis 内存随载荷线性增长；
 *   3. 载荷与库里的行可能不一致（重试时用的是入队那一刻的快照）。
 */

export const PLAN_QUEUE_NAME = 'travel-plan-generation';

export const GenerationJobPayloadSchema = z.object({
  jobId: z.string().min(1),
  requestId: z.string().min(1),
  planId: z.string().min(1),
  userId: z.string().min(1),
});

export type GenerationJobPayload = z.infer<typeof GenerationJobPayloadSchema>;

export interface PlanQueue {
  /** 返回队列侧的 job id，写入 `generation_jobs.queue_job_id` 供排查 */
  enqueue(payload: GenerationJobPayload): Promise<string>;
  close(): Promise<void>;
}

/**
 * 13.7 的队列级重试：`attempts: 3`、指数退避基数 5 秒。
 *
 * ## 为什么 P2 时期写的是 2，现在能回到设计稿的 3
 *
 * 当时的顾虑是「更多次重试会让『硬约束不可满足』这类必然失败的任务反复
 * 烧钱」—— 而 3.2.2 已经在任务内部管了 LLM 重生成次数，队列层再叠加会乘起来。
 *
 * TP-4-11 补上了 13.7 的第四层「不可重试」：`PLAN_HARD_CONSTRAINT_UNSATISFIABLE`
 * 与全部 `REQ_*` 现在以 BullMQ 的 `UnrecoverableError` 结束消费，**不占用
 * 重试次数**（见 apps/generation-worker/src/main.ts）。那条顾虑因此不再成立：
 * 会重试 3 次的只剩下真正瞬时的失败（模型抖动、数据库连接被回收），
 * 而它们重试确实会成功。
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  /*
   * 完成与失败的任务都保留一段时间：`removeOnComplete: true` 会让
   * 「任务到底有没有入队」在排查时完全不可查，而那是最常见的工单类型。
   */
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
};

export class BullMqPlanQueue implements PlanQueue {
  private readonly queue: Queue;

  constructor(connection: Redis, queueName: string = PLAN_QUEUE_NAME) {
    this.queue = new Queue(queueName, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  }

  async enqueue(payload: GenerationJobPayload): Promise<string> {
    /*
     * 用业务 `jobId` 作为队列 job id（BullMQ 的 jobId 选项去重）。
     * 13.8 的 Worker 侧并发保护要求「防止队列重复投递导致双执行」，
     * 而同一个 jobId 在 BullMQ 里只会存在一份 —— 这是最省事的一层去重，
     * `lock:job:{job_id}` 那层仍然需要（跨队列实例的重复消费）。
     */
    const job = await this.queue.add(PLAN_QUEUE_NAME, payload, { jobId: payload.jobId });
    return job.id ?? payload.jobId;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * 进程内实现：单测与无 Redis 的本地开发用。
 *
 * **不会真的执行任务** —— 它只记录入队事实。测「入队了没有」用它，
 * 测「任务跑得对不对」用 Worker 自己的测试。
 */
export class InMemoryPlanQueue implements PlanQueue {
  readonly enqueued: GenerationJobPayload[] = [];

  enqueue(payload: GenerationJobPayload): Promise<string> {
    // 与 BullMQ 一致：同 jobId 只入队一次
    if (!this.enqueued.some((entry) => entry.jobId === payload.jobId)) {
      this.enqueued.push(payload);
    }
    return Promise.resolve(payload.jobId);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
