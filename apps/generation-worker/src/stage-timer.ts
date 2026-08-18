import type { JobStatus } from '@tps/schemas';

import { jobDurationSeconds } from './plan-metrics.js';

/**
 * 阶段计时（TP-5-01，设计稿十五章的 `stage_timings`、21.3 的
 * `travel_job_duration_seconds`）。
 *
 * ## 为什么两者必须同源
 *
 * 十五章说 `stage_timings` 是「二十一章性能目标的唯一度量来源」，21.3 又要求
 * `travel_job_duration_seconds{stage}`。分别实现的话，两份数字必然在某次
 * 重构后开始分歧，而那时无法判断哪个才对 —— 排查性能问题时最先被怀疑的
 * 恰恰是度量本身。因此这里一次计时同时喂给指标与数据库。
 *
 * ## 为什么耗时随状态推进一起写库，而不是任务结束时一次性写
 *
 * 崩溃的任务是最需要耗时数据的那一类：它卡在哪个阶段、卡了多久，只有
 * 已落库的部分能回答。结束时一次性写等于「只有成功的任务有耗时」。
 *
 * 代价本来会是「每阶段多一次 UPDATE」，但状态推进本来就要写一次
 * （16.1 要求状态与 progress 同一事务），因此把耗时挂到那次写入上是零成本的
 * —— `updateJobState` 因此多了一个可选的 `stageTimings` 参数。
 */

/** 聚合项的键名。小写以区别于大写的 `JobStatus` 阶段名 */
export const TOTAL_STAGE = 'total';

export type JobOutcome = 'ok' | 'failed' | 'cancelled';

export class StageTimer {
  private currentStage: JobStatus | null = null;
  private stageStartedMs: number;
  private readonly jobStartedMs: number;
  private finished = false;

  /**
   * @param startedMs 进程侧的计时起点（开始消费的时刻，取自 `now`）。
   * @param queuedForMs 到 `startedMs` 为止已排队的毫秒数，**由数据库算出**。
   *
   * ## 为什么起点分成两段（R-40）
   *
   * 21.2 要求总耗时从**入队时刻**算（排队那段同样是用户的等待）。但入队时刻
   * 来自数据库时钟，直接用 `now() - createdAt` 就是跨时钟相减 ——
   * 实测中这让 `total` 出现了负数（宿主时钟比数据库慢几十毫秒）。
   *
   * 因此：排队那段用数据库自己算的时长，消费之后的用进程内的差值，
   * 两段相加。每一段都在单一时钟内，没有跨时钟减法。
   */
  constructor(
    startedMs: number,
    private readonly now: () => number,
    private readonly totalDaysBucketValue: string,
    private readonly queuedForMs = 0,
  ) {
    this.stageStartedMs = startedMs;
    this.jobStartedMs = startedMs;
  }

  /**
   * 进入新阶段：结算上一个阶段，返回应随本次状态写入一并落库的耗时增量。
   *
   * 返回增量而不是全量：SQL 侧用 `stage_timings || $n::jsonb` 合并，
   * 因此并发或重试写入不会互相覆盖已有的键。
   */
  enter(stage: JobStatus): Record<string, number> {
    const at = this.now();
    const timings = this.settle(at, 'ok');
    this.currentStage = stage;
    this.stageStartedMs = at;
    return timings;
  }

  /**
   * 任务终局：结算当前阶段并追加 `total`。
   *
   * `outcome` 只影响指标标签，不影响 `stage_timings` 的键 —— 库里那一列是
   * 纯耗时数据，结局已经由 `status` / `error_code` 两列表达了。
   */
  finish(outcome: JobOutcome): Record<string, number> {
    /*
     * 幂等。终局有两条路径会汇合：写终态的那次 `advance` 返回 false（说明
     * 用户在此期间取消了），调用方随即走取消分支 —— 两处都要结算。
     * 不做幂等的话 `total` 会被观测两次，而 21.2 的 P95 是按样本数算的。
     */
    if (this.finished) return {};
    this.finished = true;
    const at = this.now();
    const timings = this.settle(at, outcome);
    const totalMs = this.queuedForMs + (at - this.jobStartedMs);
    jobDurationSeconds.observe(
      { stage: TOTAL_STAGE, total_days_bucket: this.totalDaysBucketValue, outcome },
      totalMs / 1000,
    );
    return { ...timings, [TOTAL_STAGE]: totalMs };
  }

  private settle(at: number, outcome: JobOutcome): Record<string, number> {
    const stage = this.currentStage;
    if (stage === null) return {};

    const elapsedMs = at - this.stageStartedMs;
    jobDurationSeconds.observe(
      { stage, total_days_bucket: this.totalDaysBucketValue, outcome },
      elapsedMs / 1000,
    );
    this.currentStage = null;
    /*
     * 回边（REPAIRING_PLAN → VALIDATING_PLAN）会让同一个阶段被进入多次。
     * 返回增量、由 SQL 侧的 `||` 覆盖同名键 —— 因此库里存的是**最后一次**
     * 该阶段的耗时，而指标里每一次都有观测。
     *
     * 这个不对称是有意的：库里那一列用于单任务排查（「这次卡在哪」），
     * 而分位数统计要的是全部样本（3.2.2 的修复循环最多跑 3 轮，
     * 只留最后一轮会让修复的真实开销少算三分之二）。
     */
    return { [stage]: elapsedMs };
  }
}
