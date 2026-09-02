import type { CreditWalletRepository } from '@tps/db';
import type { Logger } from '@tps/shared';

import { creditHoldExpiredTotal } from './retention-metrics.js';

/**
 * 过期 CR 预留的回收（docs/用户货币与计费.md 的「进程被 SIGKILL → 由
 * `expires_at`（2 小时）兜住」）。
 *
 * ## 这个兜底此前并不存在
 *
 * 迁移 0013 建了 `EXPIRED` 状态与 `credit_holds_active_expiry_idx`
 * （一个 `WHERE status = 'ACTIVE'` 的部分索引，只可能为这类扫描而建），
 * 而全仓没有任何代码读过 `expires_at`。四处注释与计费专文都写着
 * 「由过期清理兜住」—— 那句话在此之前是空的。
 *
 * 后果不是「延迟回收」而是**永久冻结**：`reserve` 把 CR 从 `balance_cr`
 * 搬到 `held_cr`，没有人搬回来的话用户的可用余额就一直少那么多，
 * 而 `credit_holds_job_uk` 让那个任务连重新预留都做不到。
 *
 * ## 为什么住在 retention-worker
 *
 * 它已经是单副本 + 进程内定时器 + 与 `GracefulShutdown` 协作的形状，
 * 而这三条正是这个清理需要的。另起一个进程只为跑一条 UPDATE 不值得。
 *
 * 但**周期与匿名清理不同**：保留期清理按 15.1 是「每日一次」，
 * 而预留的 TTL 只有 2 小时 —— 用 24 小时的周期扫它，最坏情况下用户的钱
 * 要冻 26 小时。因此它有自己的定时器（见 main.ts）。
 */

/** 单轮上限。取 200 是「一轮别跑太久」与「积压时能追上」之间的折中 */
export const HOLD_SWEEP_BATCH_SIZE = 200;

/**
 * 默认扫描周期：15 分钟。
 *
 * 预留 TTL 是 2 小时，因此这个值只决定「过期之后还要多久才退回」。
 * 取 15 分钟让最坏延迟远小于用户能察觉的量级，而每轮的代价是一次
 * 走索引的空查询 —— 没有泄漏时它读到 0 行。
 */
export const HOLD_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;

export interface HoldSweepDeps {
  readonly wallet: CreditWalletRepository;
  readonly logger: Logger;
  readonly batchSize?: number;
  /** 注入以便测试可控时间 */
  readonly now?: () => Date;
}

export interface HoldSweepResult {
  readonly expired: number;
  readonly refundedCr: number;
}

/**
 * 跑一轮回收。
 *
 * 异常**往上抛**由调用方记录：一轮失败多半是数据库不可用，而那种情况下
 * 下一个周期重试是对的。这里只保证指标被打上 `failed` —— 少了它，
 * 「清理器一直在报错」与「没有东西需要清理」在图上完全一样。
 */
export async function runHoldSweep(deps: HoldSweepDeps): Promise<HoldSweepResult> {
  const batchSize = deps.batchSize ?? HOLD_SWEEP_BATCH_SIZE;

  /*
   * 先把两个维度初始化为 0。
   *
   * Prometheus 里一条从未被 inc 过的序列**不存在**，而 `absent()` 告警
   * 需要它存在才能区分「没有泄漏」与「清理器没在跑」。没有这两行的话，
   * 一个健康系统（永远 0 笔过期）看起来与一个挂掉的清理器完全一样。
   */
  creditHoldExpiredTotal.inc({ outcome: 'expired' }, 0);
  creditHoldExpiredTotal.inc({ outcome: 'failed' }, 0);

  let outcomes;
  try {
    outcomes = await deps.wallet.expireHolds({
      limit: batchSize,
      ...(deps.now === undefined ? {} : { now: deps.now() }),
    });
  } catch (error) {
    creditHoldExpiredTotal.inc({ outcome: 'failed' });
    throw error;
  }

  if (outcomes.length === 0) return { expired: 0, refundedCr: 0 };

  let refundedCr = 0;
  for (const outcome of outcomes) {
    refundedCr += outcome.refundedCr;
    creditHoldExpiredTotal.inc({ outcome: 'expired' });
    /*
     * 逐笔记 info 而不是只记一条汇总：每一笔都代表**一次没有正常结算的
     * 生成任务**，而 job_id 是唯一能回到那次任务的线索。
     * 数量级不成问题 —— 正常情况下这里一条都不打印。
     */
    deps.logger.info(
      {
        stage: 'billing',
        job_id: outcome.jobId,
        user_id: outcome.userId,
        refunded_cr: outcome.refundedCr,
        overdue_seconds: outcome.overdueSeconds,
      },
      '过期预留已退回可用余额（该任务未经正常结算，值得查一下原因）',
    );
  }

  /*
   * 满批说明可能还有积压。不在本轮继续拉下一批：那会让一轮的时长不可预测，
   * 而停机时 `await running` 要等它跑完。下一个周期（15 分钟后）自然接上。
   */
  if (outcomes.length >= batchSize) {
    deps.logger.warn(
      { stage: 'billing', batch_size: batchSize },
      '过期预留满批回收，可能仍有积压，将在下一周期继续',
    );
  }

  deps.logger.info(
    { stage: 'billing', expired: outcomes.length, refunded_cr: refundedCr },
    `本轮回收 ${outcomes.length} 笔过期预留，退回 ${refundedCr} CR`,
  );

  return { expired: outcomes.length, refundedCr };
}
