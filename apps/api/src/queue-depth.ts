import { createGauge } from '@tps/observability';
import { EXPORT_QUEUE_NAME, PLAN_QUEUE_NAME } from '@tps/queue';
import type { Logger } from '@tps/shared';

/**
 * 队列积压的采样与上报（21.3 的补充项）。
 *
 * ## 它填的是一个「先行 vs 滞后」的空缺
 *
 * 突发并发下最先出问题的是排队时长，而排队时长已经被 T1 计入
 * （`travel_job_milestone_seconds{milestone="t1"}` 从提交算起）。所以
 * `TravelJobT1SlaBreach` 看起来已经覆盖了这件事。
 *
 * 但那条告警是**滞后**的：直方图只在任务**完成时**才落一个样本。队列积压
 * 到 200 条时，T1 的 P95 反映的是三分钟前完成的那批 —— 而正在受苦的这 200 个
 * 用户还没有任何一个进过直方图。等它们进去时，人已经走了。
 *
 * 队列深度是**先行**指标：它在第一个用户超时之前就升高。这是唯一能在
 * 用户受影响前介入的窗口，也是这个指标存在的全部理由。
 *
 * ## 为什么由 API 上报，而不是 Worker
 *
 * API 已经持有两个队列的生产者句柄（`BullMqPlanQueue` / `BullMqExportQueue`），
 * 拿深度不需要新建 Queue 实例或 Redis 连接。Worker 侧要报就得为此多开一个
 * Queue 句柄，而 Worker 的副本数通常比 API 多 —— 那是成比例增加的 Redis 往返。
 *
 * 多副本下每个 API 实例都会上报**同一个全局值**（队列在 Redis 里只有一份），
 * 因此告警必须用 `max by (queue)` 而不是 `sum` —— `sum` 会随副本数翻倍。
 */

/**
 * 采样周期。
 *
 * 15 秒对齐典型的 Prometheus 抓取间隔：采得比抓取快是白费 Redis 往返
 * （抓走的永远是最后一次的值），慢了则在抓取点之间丢失分辨率。
 */
export const QUEUE_DEPTH_SAMPLE_INTERVAL_MS = 15_000;

export const queueDepth = createGauge({
  name: 'travel_queue_depth',
  help: '队列中等待被消费的任务数（不含在跑的）',
  labelNames: ['queue'],
});

/** 只要能问出深度就行，不关心是哪一种队列 */
export interface DepthSource {
  depth(): Promise<number>;
}

export interface QueueDepthSamplerDeps {
  readonly plan: DepthSource;
  readonly export: DepthSource;
  readonly logger: Logger;
}

/**
 * 采一轮并写入 gauge。**永不抛错。**
 *
 * Redis 抖一下不该让上报循环停掉 —— 停掉之后 gauge 会一直停在最后那个值，
 * 而一个「卡住不动的深度」比没有这个指标更糟：它看起来是正常的。
 *
 * 失败时**不写 gauge**（保持上一次的值），并留一条 warn。选「保持旧值」而不是
 * 「置 0」：置 0 会在积压期间造成一个假的「已恢复」，而告警的 `for: 5m`
 * 恰好会被那个假恢复重置掉。
 */
export async function sampleQueueDepth(deps: QueueDepthSamplerDeps): Promise<void> {
  const targets: readonly { readonly name: string; readonly source: DepthSource }[] = [
    { name: PLAN_QUEUE_NAME, source: deps.plan },
    { name: EXPORT_QUEUE_NAME, source: deps.export },
  ];

  for (const target of targets) {
    try {
      const depth = await target.source.depth();
      queueDepth.set({ queue: target.name }, depth);
    } catch (error) {
      deps.logger.warn(
        { queue: target.name, reason_code: 'QUEUE_DEPTH_SAMPLE_FAILED' },
        `队列深度采样失败，保持上一次的值：${String(error)}`,
      );
    }
  }
}

/**
 * 起一个周期采样器，返回停止函数。
 *
 * 立即采一次而不是等第一个周期：否则进程启动后的前 15 秒里这个指标**不存在**
 * （Prometheus 里是 no data 而不是 0），而重启后的第一次抓取恰好落在那个窗口
 * 的概率不低 —— 表现是重启就丢一段曲线。
 *
 * `unref()` 让它不阻止进程退出。不加的话优雅关停会多等最多一个周期，
 * 而 Kubernetes 的 terminationGracePeriod 是有限的。
 */
export function startQueueDepthSampler(
  deps: QueueDepthSamplerDeps,
  intervalMs: number = QUEUE_DEPTH_SAMPLE_INTERVAL_MS,
): () => void {
  void sampleQueueDepth(deps);

  const timer = setInterval(() => {
    void sampleQueueDepth(deps);
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
