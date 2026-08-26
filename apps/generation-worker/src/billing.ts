import { priceUsage, type PriceBook, type PricedUsage, type UsageSnapshot } from '@tps/billing';
import type { CreditWalletRepository } from '@tps/db';
import type { Logger } from '@tps/shared';

/**
 * 生成任务的 CR 结算（C-4）。
 *
 * API 侧在入队前冻结了一笔预留（`credit_holds`），这里按**真实用量**把它结掉：
 *
 * ```text
 * 任务成功        settle    实际用量计价，多退少补（不足由我们承担）
 * 不可重试的失败  release   预留全额退，另记一条 WRITE_OFF 记我们烧掉的成本
 * 可重试的失败    什么都不做  预留留给重试用，见下
 * 用户取消        release
 * ```
 *
 * ## 为什么可重试的失败不释放预留
 *
 * 释放了的话，BullMQ 重试成功时 `settle` 找不到 ACTIVE 的预留，
 * 按 C-2 的设计它会**不扣费**（凭空扣一笔用户看不懂的钱更严重）——
 * 于是「失败一次然后成功」的任务全都免费。而 LLM 超时导致的重试并不罕见，
 * 这会是一个持续漏钱且完全不可见的洞。
 *
 * 因此预留跨重试保留。重试全部耗尽时由队列的 `failed` 事件释放
 * （见 main.ts 的死信分支）；连那里也没走到（进程被 SIGKILL）时，
 * 预留由 `expires_at` 兜住 —— 那是它存在的理由。
 *
 * 代价是失败那一次烧掉的成本没有进 `WRITE_OFF` 流水（只进日志）：
 * 那一笔的载体是 `writeoff:<job_id>`，而它必须与释放同一个事务，
 * 否则重试成功后会出现「既结算又坏账」的两条自相矛盾的记录。
 *
 * ## 为什么按预留锁定的价目版本算钱
 *
 * `credit_holds.price_version` 是提交那一刻的版本。运营在任务在途时调价，
 * 用当前发布版结算会让用户按他提交时看不到的价格被扣 ——
 * 「已提交的任务不受调价影响」这条承诺就落在这里。
 */

/** 价目表缓存时长。与 API 侧一致（docs 第八节承诺「最多 60 秒」） */
export const PRICE_BOOK_CACHE_MS = 60_000;

export interface JobBilling {
  /** 任务成功：按真实用量结算 */
  settle(input: { readonly jobId: string; readonly usage: UsageSnapshot }): Promise<void>;
  /** 任务终态失败或被取消：预留全额退 + 记坏账 */
  release(input: { readonly jobId: string; readonly usage: UsageSnapshot }): Promise<void>;
  /** 只算钱不动账。用于「留着预留等重试」那条路径的日志 */
  priceOf(input: {
    readonly jobId: string;
    readonly usage: UsageSnapshot;
  }): Promise<PricedUsage | null>;
}

export interface JobBillingDeps {
  readonly wallet: CreditWalletRepository;
  readonly logger: Logger;
  readonly now?: () => number;
  /** 测试传 0 关闭缓存 */
  readonly priceCacheMs?: number;
}

export function createJobBilling(deps: JobBillingDeps): JobBilling {
  const now = deps.now ?? Date.now;
  const ttl = deps.priceCacheMs ?? PRICE_BOOK_CACHE_MS;
  /*
   * 按版本缓存。同一进程同时在跑的任务可能锁着不同版本（调价前后各一批），
   * 因此不能只缓存一份 —— 但版本数极少，Map 不会长。
   */
  const cache = new Map<number, { readonly book: PriceBook | null; readonly at: number }>();

  async function bookForVersion(version: number): Promise<PriceBook | null> {
    const cached = cache.get(version);
    const nowMs = now();
    if (cached !== undefined && nowMs - cached.at < ttl) return cached.book;

    const book = await deps.wallet.pricesForVersion(version);
    cache.set(version, { book, at: nowMs });
    return book;
  }

  /**
   * 把用量折成钱。
   *
   * 返回 `null` **只**表示「这个任务没有预留」—— 那时不该动任何账
   * （0013 之前入队，或入队时计费还关着）。
   *
   * 而「价目版本查不到」返回的是 `{ priced: null }`：那两件事必须分开。
   * 混成同一个 `null` 的后果是**价目数据一出问题，用户的预留就再也不释放**
   * —— 钱冻到两小时后过期，而根因是一张查不到的价目表。
   * 算不出钱就按 0 算：少收一笔，而不是把钱卡住。
   */
  async function priceJob(
    jobId: string,
    usage: UsageSnapshot,
    options: { readonly includeBaseFee: boolean },
  ): Promise<{ readonly priced: PricedUsage | null } | null> {
    const hold = await deps.wallet.findHold(jobId);
    if (hold === null) return null;

    const book = await bookForVersion(hold.priceVersion);
    if (book === null) {
      deps.logger.error(
        { job_id: jobId, stage: 'billing', price_version: hold.priceVersion },
        '预留锁定的价目版本查不到，本次按 0 结算（预留照常释放）',
      );
      return { priced: null };
    }

    const priced = priceUsage(usage, book, { includeBaseFee: options.includeBaseFee });
    if (priced.unpriced.length > 0) {
      /*
       * 命中兜底价或压根没登记。两者都要报出来 —— 前者按一个偏贵的价收，
       * 后者不收。静默的话「运营加了模型忘了配价」永远不会被发现。
       */
      deps.logger.warn(
        { job_id: jobId, stage: 'billing', sku: priced.unpriced.join(',') },
        '有 SKU 没有登记单价（走兜底或跳过）',
      );
    }
    return { priced };
  }

  return {
    async settle({ jobId, usage }) {
      /* 服务费只在成功时收：用户没拿到东西就不该付我们的服务费 */
      const result = await priceJob(jobId, usage, { includeBaseFee: true });
      if (result === null) return;

      const settled = await deps.wallet.settle({
        jobId,
        actualCr: result.priced?.totalCr ?? 0,
        lines: result.priced?.lines ?? [],
        unpriced: result.priced?.unpriced ?? [],
      });

      const level = settled.writeOffCr > 0 ? 'warn' : 'info';
      deps.logger[level](
        {
          job_id: jobId,
          stage: 'billing',
          charged_cr: settled.chargedCr,
          refunded_cr: settled.refundedCr,
          /* 非 0 意味着我们估算不准到了「用户余额兜不住」的程度 —— 直接是损失 */
          write_off_cr: settled.writeOffCr,
          replayed: settled.replayed,
        },
        'CR 结算完成',
      );
    },

    async release({ jobId, usage }) {
      /*
       * 坏账口径**不含服务费**：那是我们的收入项，不是烧掉的供应商成本。
       * 含进去会让「上游故障烧了多少钱」这个数虚高，而它是告警阈值的依据。
       */
      const result = await priceJob(jobId, usage, { includeBaseFee: false });
      if (result === null) return;

      const released = await deps.wallet.releaseFailed({
        jobId,
        burnedCr: result.priced?.totalCr ?? 0,
        lines: result.priced?.lines ?? [],
      });

      deps.logger.info(
        {
          job_id: jobId,
          stage: 'billing',
          refunded_cr: released.refundedCr,
          burned_cr: result.priced?.totalCr ?? 0,
          replayed: released.replayed,
        },
        'CR 预留已释放，成本记为坏账',
      );
    },

    async priceOf({ jobId, usage }) {
      const result = await priceJob(jobId, usage, { includeBaseFee: false });
      return result?.priced ?? null;
    },
  };
}
