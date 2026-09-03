import { createCounter, createGauge } from '@tps/observability';
import { EXPORT_QUEUE_NAME, PLAN_QUEUE_NAME } from '@tps/queue';
import { optionalInt, type Logger } from '@tps/shared';

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

export const queueAdmissionRejectedTotal = createCounter({
  name: 'travel_queue_admission_rejected_total',
  help: '因队列积压而在入口被拒的请求数（背压准入）',
  labelNames: ['queue'],
});

/**
 * 背压准入的阈值。
 *
 * ## 它不是告警阈值，也不应该是
 *
 * `TravelQueueBacklogHigh` 在深度 > 8 持续 5 分钟时告警，而那是一个
 * **叫人扩容的 warning**，不是拒绝点。把准入也定在 8 的表现是：
 * 告警有意容忍的那五分钟瞬时突发，全部变成用户可见的 503。
 *
 * ## 推导：拒的是「已经注定失败的活」
 *
 * 16.3 的队列等待上限是 600 秒，超过就 `JOB_QUEUE_TIMEOUT`。
 * 告警注释给的单副本吞吐是约 4～5 任务/分钟，取 4.5 算：
 * 600 秒 × 4.5/60 ≈ **45** —— 深度过了这个数之后，新任务在开始之前
 * 就会先撞上 600 秒。
 *
 * 取 40（稍低于 45）留一点余量。关键在于：超过它仍然接下来并不会让
 * 那个任务跑成，只会额外花掉一格日配额、一笔 CR 预留和一行
 * 用户在列表里看得见的卡住的计划。**准入控制在这里的职责不是保 SLA，
 * 而是不收没法交付的钱、不留没人消费的垃圾行。** SLA 由告警 + 扩容管。
 *
 * ## 加 Worker 副本必须同步抬它
 *
 * 与告警阈值同一条约束（运维手册里已有）：五副本的吞吐下，
 * 深度 40 远达不到 600 秒，这时拒绝是白白丢请求。
 */
export const QUEUE_ADMISSION_MAX_DEPTH = 40;

export function loadQueueAdmissionMaxDepth(): number {
  return optionalInt('QUEUE_ADMISSION_MAX_DEPTH', QUEUE_ADMISSION_MAX_DEPTH);
}

/**
 * 读上一次采样到的深度。
 *
 * ## 为何读缓存而不是每请求查一次 Redis
 *
 * 每请求查一次看上去更准，但它把一条 Redis 往返加进了热路径 ——
 * 而这个判定恰好只在**过载时**才会被大量执行。过载时给 Redis
 * 再加一倍 QPS 是在放大故障，而不是抵御它。
 *
 * 15 秒的陈旧度在这里无关紧要：单任务要跑 20～60 秒，队列不可能在
 * 一个采样间隔里从健康跌到饱和。
 */
export interface QueueBacklog {
  /** `null` = 从未成功采样过（不可判定，调用方应当放行） */
  depthOf(queue: string): number | null;
}

export interface QueueDepthTracker extends QueueBacklog {
  record(queue: string, depth: number): void;
}

/**
 * 采样值的内存快照。
 *
 * 做成显式对象而不是模块级可变量：后者会让测试之间互相泄漏状态，
 * 而“上一条测试把深度置成了 99”这类失败极难定位。
 */
export function createQueueDepthTracker(): QueueDepthTracker {
  const depths = new Map<string, number>();
  return {
    record: (queue, depth) => {
      depths.set(queue, depth);
    },
    depthOf: (queue) => depths.get(queue) ?? null,
  };
}

/** 准入判定结果。`retryAfterSeconds` 直接给 `Retry-After` */
export type AdmissionDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly depth: number; readonly retryAfterSeconds: number };

/**
 * 该不该接这个新任务。
 *
 * **不可判定时放行（fail open）。** 与 13.8 的 Redis 幂等锁同一条取舍：
 * Redis 不可用时宁可放过一些请求，也不能让全站无法生成计划 ——
 * 而那正是 fail closed 的后果：采样一挂，`depthOf` 永远返回 null。
 *
 * `retryAfterSeconds` 按「排空到阈值以下大致要多久」给，并夹在
 * 15～300 秒：给 1 秒会把客户端变成新的压源，给 1 小时则等同于赶客。
 */
export function decideAdmission(
  backlog: QueueBacklog,
  queue: string,
  maxDepth: number,
): AdmissionDecision {
  const depth = backlog.depthOf(queue);
  if (depth === null || depth <= maxDepth) return { admit: true };

  /* 每分钟约 4.5 任务 ⇒ 每消一条约 13 秒（与阈值推导同一个吞吐假设） */
  const drainSeconds = Math.round((depth - maxDepth) * 13);
  return {
    admit: false,
    depth,
    retryAfterSeconds: Math.min(300, Math.max(15, drainSeconds)),
  };
}

/** 只要能问出深度就行，不关心是哪一种队列 */
export interface DepthSource {
  depth(): Promise<number>;
}

export interface QueueDepthSamplerDeps {
  readonly plan: DepthSource;
  readonly export: DepthSource;
  readonly logger: Logger;
  /**
   * 采到的值写进这里，供准入判定读（见 `decideAdmission`）。
   *
   * 可缺省：只要指标不要准入的部署（或只测上报的用例）不必造一个追踪器。
   * 缺省时 `depthOf` 永远是 null，而那条路径 fail open。
   */
  readonly tracker?: QueueDepthTracker;
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
      deps.tracker?.record(target.name, depth);
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
