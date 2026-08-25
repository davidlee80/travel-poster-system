import {
  SKU_FALLBACK_MODEL,
  creditsToCnyText,
  estimateExportCost,
  estimateJobCost,
  holdAmount,
  isSeedPriceBook,
  type CreditConfig,
  type JobLimits,
  type PriceBook,
} from '@tps/billing';
import type { CreditWalletRepository, LedgerEntry, WalletBalance } from '@tps/db';
import type { Logger } from '@tps/shared';

/**
 * CR 计费在 API 侧的那一层（C-3）。
 *
 * 三件事：读价目表（带缓存）、报价、动钱（预留 / 导出扣费）。
 * 定价与估算的算术全在 `@tps/billing`（纯函数），动钱全在
 * `CreditWalletRepository`（原子 + 幂等）。这一层只做编排与降级判定。
 *
 * ## 三条降级规则，都朝「不挡用户」的一侧
 *
 * 1. **一版价目表都没发布 → 免费放行**，只打一条 warn。
 *    反过来（503）的表现是「运营还没配价格，全站不能生成」——
 *    而价目表缺失是我们的配置问题，不是用户的问题。
 * 2. **报价算出 0 CR → 不预留**。`credit_holds.amount_cr` 有 `> 0` 的 CHECK，
 *    预留 0 会让整条请求 500。
 * 3. **兜底价命中 → 照收并报出来**（`unpriced`）。理由见 `priceOf`。
 *
 * 这三条与「次数配额保留不删」是一套：货币闸门失效时次数闸门还在
 * （见 docs/用户货币与计费.md 第一节）。
 *
 * ## 为什么报价按兜底模型算
 *
 * 真正会用哪个模型由 worker 侧的模型池 + `tier_level` 决定，API 不知道，
 * 也不该为了报价把模型选择逻辑复制一份过来（那会是第二个真相源）。
 * 因此估算统一按兜底 SKU `:*` 算 —— 兜底价**刻意定得比常见模型贵**
 * （见 docs 第九节第 2 条），因此这是偏保守的一侧：预留略多于实际，
 * 结算时多退。
 *
 * 若兜底价被配得比某个真实模型便宜，预留会不足 —— 那种情况由结算的
 * 「超出预留从余额继续扣」兜住，最坏是一笔坏账，而不是任务卡住。
 */

/** 价目表缓存时长。改价最多 60 秒后生效，与 docs 第八节的承诺一致 */
export const PRICE_BOOK_CACHE_MS = 60_000;

/**
 * 预留的有效期。
 *
 * 任务被永久丢弃（worker 崩溃且无人接管）时预留会一直挂着，而挂着的钱
 * 用户既用不了也退不回。过期清理由 retention-worker 扫 `expires_at`。
 *
 * 两小时是「排队最坏情况」的量级：生成本身 20～60 秒，但队列积压时
 * 一个任务可能等上几十分钟。取值偏大只影响清理的及时性，偏小的后果
 * 严重得多 —— 一笔还在跑的任务的预留被判过期释放，结算时就找不到它，
 * 于是那次生成免费。
 */
export const HOLD_TTL_MS = 2 * 60 * 60 * 1_000;

/** 报价（面向展示与 402 的数值） */
export interface CreditQuote {
  /** `null` = 一版价目表都没发布，本次生成不计费 */
  readonly priceVersion: number | null;
  /** 典型用量（0 次重生成）的定价 */
  readonly typicalCr: number;
  /** 最坏上界（含最多重生成）。只展示，**不进预留** */
  readonly ceilingCr: number;
  /** 实际会冻结的额度 = 典型值 × buffer */
  readonly holdCr: number;
  readonly typicalCny: string;
  readonly ceilingCny: string;
  /** 没有登记单价、走了兜底或被跳过的 SKU */
  readonly unpriced: readonly string[];
}

export type JobCreditCheck =
  /** 要收费，且余额够。`holdCr` / `priceVersion` 传给后面的 `reserve` */
  | {
      readonly kind: 'chargeable';
      readonly holdCr: number;
      readonly priceVersion: number;
      readonly quote: CreditQuote;
    }
  /** 本次不收费（没有价目表、或算出 0 CR） */
  | { readonly kind: 'free'; readonly reason: 'NO_PRICE_BOOK' | 'ZERO_COST' }
  | { readonly kind: 'insufficient'; readonly requiredCr: number; readonly balanceCr: number };

export type JobReserveOutcome =
  | { readonly kind: 'reserved'; readonly holdId: string }
  /** 这个任务已经预留过了（重投）。不再扣第二次 */
  | { readonly kind: 'already_held'; readonly holdId: string }
  | { readonly kind: 'insufficient'; readonly requiredCr: number; readonly balanceCr: number };

export type ExportChargeOutcome =
  | { readonly kind: 'charged'; readonly amountCr: number }
  /** 导出的那一项没有价目 → 不收费（见 `estimateExportCost`） */
  | { readonly kind: 'free' }
  | { readonly kind: 'insufficient'; readonly requiredCr: number; readonly balanceCr: number };

export interface CreditsServiceDeps {
  readonly wallet: CreditWalletRepository;
  readonly config: CreditConfig;
  readonly limits: JobLimits;
  readonly logger: Logger;
  readonly now: () => Date;
  /** 价目表缓存时长。测试传 0 以关闭缓存 */
  readonly priceCacheMs?: number;
}

export class CreditsService {
  private readonly deps: CreditsServiceDeps;
  private cached: { readonly book: PriceBook | null; readonly at: number } | null = null;
  private seedWarned = false;

  constructor(deps: CreditsServiceDeps) {
    this.deps = deps;
  }

  /**
   * 当前发布的价目表。`null` = 一版都没发布。
   *
   * 缓存 60 秒而不是每次查库：每个生成请求都要它，而它每天变不了一次。
   * 缓存**也缓存 null** —— 否则「没发布价目表」这个状态会让每个请求
   * 都打一次库，恰好是最不该额外加压的时候。
   */
  async priceBook(): Promise<PriceBook | null> {
    const ttl = this.deps.priceCacheMs ?? PRICE_BOOK_CACHE_MS;
    const nowMs = this.deps.now().getTime();
    const cached = this.cached;
    if (cached !== null && nowMs - cached.at < ttl) return cached.book;

    const book = await this.deps.wallet.publishedPrices();
    this.cached = { book, at: nowMs };

    if (book === null) {
      this.deps.logger.warn(
        { stage: 'billing' },
        '没有已发布的价目表，本次起的生成与导出不计费（见 docs/用户货币与计费.md）',
      );
    } else if (!this.seedWarned && isSeedPriceBook(book)) {
      /*
       * 只打一次：这是启动期配置提醒，不是每分钟一条的运行时告警。
       * 带着占位价上线的表现不是报错，是**收错钱** —— 而收错钱要到对账
       * 时才发现，所以它必须在日志里留下痕迹。
       */
      this.seedWarned = true;
      this.deps.logger.warn(
        { stage: 'billing', price_version: book.version },
        '当前价目表是迁移 0013 种下的占位版本，上线前需按真实供应商成本重定',
      );
    }
    return book;
  }

  balance(userId: string): Promise<WalletBalance> {
    return this.deps.wallet.balance(userId);
  }

  history(input: {
    readonly userId: string;
    readonly limit: number;
    readonly before?: string;
  }): Promise<readonly LedgerEntry[]> {
    return this.deps.wallet.history(input);
  }

  cnyText(credits: number): string {
    return creditsToCnyText(credits, this.deps.config);
  }

  /** 一次生成的报价。`totalDays` 取标准化后的天数 */
  async quote(totalDays: number): Promise<CreditQuote> {
    const book = await this.priceBook();
    if (book === null) {
      return {
        priceVersion: null,
        typicalCr: 0,
        ceilingCr: 0,
        holdCr: 0,
        typicalCny: this.cnyText(0),
        ceilingCny: this.cnyText(0),
        unpriced: [],
      };
    }

    const estimate = estimateJobCost({
      totalDays,
      model: SKU_FALLBACK_MODEL,
      book,
      limits: this.deps.limits,
    });

    return {
      priceVersion: book.version,
      typicalCr: estimate.typical.totalCr,
      ceilingCr: estimate.ceiling.totalCr,
      holdCr: holdAmount(estimate.typical.totalCr, this.deps.config),
      typicalCny: this.cnyText(estimate.typical.totalCr),
      ceilingCny: this.cnyText(estimate.ceiling.totalCr),
      unpriced: estimate.typical.unpriced,
    };
  }

  /**
   * 生成前的余额预检。
   *
   * 它**不是**闸门 —— 闸门是 `reserve` 里那条带谓词的 UPDATE。这一步只是
   * 为了让「余额不够」这个绝大多数情形在**建任务行之前**就返回 402：
   * 反过来（只靠 reserve）的话每次余额不足都会留下一行 QUEUED 任务与一个
   * 被占用的幂等键，用户充值后用同一份表单重试会拿到那个死任务。
   */
  async checkJob(input: {
    readonly userId: string;
    readonly totalDays: number;
  }): Promise<JobCreditCheck> {
    const quote = await this.quote(input.totalDays);
    if (quote.priceVersion === null) return { kind: 'free', reason: 'NO_PRICE_BOOK' };
    if (quote.holdCr <= 0) return { kind: 'free', reason: 'ZERO_COST' };

    const balance = await this.balance(input.userId);
    if (balance.balanceCr < quote.holdCr) {
      return { kind: 'insufficient', requiredCr: quote.holdCr, balanceCr: balance.balanceCr };
    }
    return {
      kind: 'chargeable',
      holdCr: quote.holdCr,
      priceVersion: quote.priceVersion,
      quote,
    };
  }

  /** 原子预留。这一步才是真正的闸门 */
  async reserve(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly holdCr: number;
    readonly priceVersion: number;
  }): Promise<JobReserveOutcome> {
    const result = await this.deps.wallet.reserve({
      userId: input.userId,
      jobId: input.jobId,
      amountCr: input.holdCr,
      priceVersion: input.priceVersion,
      expiresAt: new Date(this.deps.now().getTime() + HOLD_TTL_MS),
    });

    if (result.ok) return { kind: 'reserved', holdId: result.holdId };
    if (result.reason === 'ALREADY_HELD') return { kind: 'already_held', holdId: result.holdId };
    return { kind: 'insufficient', requiredCr: input.holdCr, balanceCr: result.balanceCr };
  }

  /**
   * 导出：一次原子扣减，不做预留/结算往返。
   *
   * 导出成本是几秒 Chromium CPU + 存储，量级比生成小三个数量级，且**与内容
   * 无关** —— 定价固定，因此没有「估多估少」的问题，两阶段没有意义。
   *
   * 幂等键复用导出自己的幂等键，因此同一份导出重复请求只扣一次。
   */
  async chargeExport(input: {
    readonly userId: string;
    readonly exportId: string;
    readonly format: 'PNG' | 'PDF';
    readonly exportIdempotencyKey: string;
  }): Promise<ExportChargeOutcome> {
    const book = await this.priceBook();
    if (book === null) return { kind: 'free' };

    const priced = estimateExportCost(input.format, book);
    if (priced.totalCr <= 0) {
      if (priced.unpriced.length > 0) {
        this.deps.logger.warn(
          { stage: 'billing', sku: priced.unpriced.join(',') },
          '导出的价目缺失，本次导出不计费',
        );
      }
      return { kind: 'free' };
    }

    const charged = await this.deps.wallet.charge({
      userId: input.userId,
      amountCr: priced.totalCr,
      idempotencyKey: `export:${input.exportIdempotencyKey}`,
      refType: 'EXPORT',
      refId: input.exportId,
      priceVersion: book.version,
      metadata: { lines: priced.lines },
    });

    if (!charged.ok) {
      return { kind: 'insufficient', requiredCr: priced.totalCr, balanceCr: charged.balanceCr };
    }
    return { kind: 'charged', amountCr: priced.totalCr };
  }

  /** 导出任务没能建起来时把刚扣的退回去 */
  async refundExport(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly exportId: string;
    readonly exportIdempotencyKey: string;
  }): Promise<void> {
    await this.deps.wallet.refund({
      userId: input.userId,
      amountCr: input.amountCr,
      idempotencyKey: `refund:export:${input.exportIdempotencyKey}`,
      refType: 'EXPORT',
      refId: input.exportId,
    });
  }
}
