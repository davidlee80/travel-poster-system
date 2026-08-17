/**
 * 16.3 的三层超时（TP-4-10）。
 *
 * ```text
 * 单阶段        见二十一章各项       记阶段错误码，按 16.3 判定
 * 整个生成任务  300 秒               FAILED + JOB_TIMEOUT
 * 队列中等待    600 秒               FAILED + JOB_QUEUE_TIMEOUT
 * ```
 *
 * ## 为什么在阶段边界检查，而不是给整个任务套一个 `Promise.race`
 *
 * `race` 只能让**等待**结束，不能让正在跑的工作停下：模型调用还在飞、
 * 数据库事务还在写。一个「已经超时并置为 FAILED」的任务随后仍会写入
 * `plan_versions` 与 `plan_presentations` —— 而那些行属于一个失败的任务，
 * 没有任何东西会引用它们，也没人知道它们是怎么来的。
 *
 * 因此这里用**协作式**超时：每个阶段边界检查一次剩余预算，超了就在那个
 * 边界上停下并置 FAILED。代价是最坏情况会超出 300 秒（正好卡在一次 30 秒的
 * LLM 调用上），收益是任何时刻的库内状态都是自洽的。
 *
 * 为了把那个「最坏情况」压住，剩余预算同时用来**收紧下一次外部调用的超时**
 * （见 `remainingFor`）：剩 8 秒时不会再发一个 30 秒超时的请求。
 */

/** 16.3：整个生成任务 300 秒 */
export const JOB_TIMEOUT_MS = 300_000;

/** 16.3：队列中等待 600 秒 */
export const QUEUE_TIMEOUT_MS = 600_000;

export interface JobDeadline {
  /** 已超预算 */
  readonly expired: () => boolean;
  /** 剩余毫秒数，最小 0 */
  readonly remainingMs: () => number;
  /**
   * 把某个外部调用的超时压到剩余预算内。
   *
   * 返回 0 表示已经没有预算 —— 调用方应当直接判超时而不是发一个
   * 超时为 0 的请求（那会以「立刻失败」的形式出现，错误码也就错了）。
   */
  readonly remainingFor: (preferredMs: number) => number;
}

export function createJobDeadline(
  startedAt: number,
  budgetMs = JOB_TIMEOUT_MS,
  now: () => number = Date.now,
): JobDeadline {
  const deadline = startedAt + budgetMs;
  const remainingMs = (): number => Math.max(0, deadline - now());

  return {
    remainingMs,
    expired: () => remainingMs() === 0,
    remainingFor: (preferredMs) => Math.min(preferredMs, remainingMs()),
  };
}

/**
 * 队列等待是否超限（16.3）。
 *
 * 判定点是**消费的第一件事**：等了 11 分钟的任务，用户早已离开页面，
 * 而生成它要花掉一次 LLM 调用的钱。先失败掉，让用户重新提交时拿到一个
 * 排在队首的新任务。
 *
 * `createdAt` 取 `generation_jobs.created_at`（入队与建行在同一事务，
 * 见 `createGeneration`），因此它就是入队时刻。
 */
export function queueWaitExceeded(
  createdAt: Date,
  now: number = Date.now(),
  limitMs = QUEUE_TIMEOUT_MS,
): boolean {
  return now - createdAt.getTime() > limitMs;
}
