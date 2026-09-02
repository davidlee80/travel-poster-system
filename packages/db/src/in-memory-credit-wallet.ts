import type { PriceBook } from '@tps/billing';

import type {
  CreditHold,
  CreditSpend,
  CreditWalletRepository,
  ExpiredHoldOutcome,
  LedgerEntry,
  LedgerKind,
  ReserveResult,
  SettleResult,
  WalletBalance,
} from './credit-wallet.js';

/**
 * 内存钱包，形态照 `InMemoryPlanQueue` / `InMemoryCounterStore`
 * —— 在途实现与它的内存版住在同一个包里，这样接口加一个方法时两边一起报错。
 *
 * ## 它刻意**不**复刻 SQL 的原子性
 *
 * 「并发下不超发」靠的是 `UPDATE ... WHERE balance_cr >= $n` 的单语句
 * 原子性，而那条性质只能在真库上验证 —— `credit-wallet.integration.test.ts`
 * 的 26 项就是为此存在的。在这里用 JS 重写一遍，测到的只是我对「原子」
 * 这个词的理解。
 *
 * 因此它的用途是让**调用方**的测试能覆盖自己那一层的契约：
 * API 侧的 402 时机与 `details` 数值、Worker 侧的结算口径与失败退款。
 * 那些分支与 SQL 无关，却是用户唯一能看到的部分。
 */
export class InMemoryCreditWalletRepository implements CreditWalletRepository {
  private readonly wallets = new Map<string, { balanceCr: number; heldCr: number }>();
  private readonly ledger: LedgerEntry[] = [];
  /**
   * 流水行 → 所属用户。
   *
   * `LedgerEntry` 里没有 `user_id`（读路径已经按用户过滤，返回它是多余的），
   * 而 `findSpend` 恰恰要回答「这笔钱是谁的」—— 那是它唯一的用途：
   * 导出失败时退给当时被扣的那个人。
   */
  private readonly entryOwner = new Map<string, string>();
  private readonly keys = new Set<string>();
  private readonly holds = new Map<
    string,
    {
      holdId: string;
      userId: string;
      amountCr: number;
      priceVersion: number;
      status: string;
      /** 过期清理靠它判定（与真实实现的 `credit_holds.expires_at` 对应） */
      expiresAt: Date;
    }
  >();
  private sequence = 0;

  /** `null` = 一版价目表都没发布，供「不计费」那条分支使用 */
  priceBook: PriceBook | null = null;

  private wallet(userId: string): { balanceCr: number; heldCr: number } {
    const existing = this.wallets.get(userId);
    if (existing !== undefined) return existing;
    const fresh = { balanceCr: 0, heldCr: 0 };
    this.wallets.set(userId, fresh);
    return fresh;
  }

  private append(input: {
    userId: string;
    kind: LedgerKind;
    amountCr: number;
    idempotencyKey: string;
    refType?: string;
    refId?: string;
    priceVersion?: number;
    metadata?: Readonly<Record<string, unknown>>;
  }): boolean {
    if (this.keys.has(input.idempotencyKey)) return false;
    this.keys.add(input.idempotencyKey);
    this.sequence += 1;
    this.entryOwner.set(`entry-${this.sequence}`, input.userId);
    this.ledger.push({
      entryId: `entry-${this.sequence}`,
      kind: input.kind,
      /*
       * `+ 0` 把 `-0` 归一成 `0`。BIGINT 列里没有负零，而 JS 里
       * `Object.is(-0, 0)` 为 false —— 少了这一下，「结算金额为 0」这类断言
       * 会在内存版上红、在真库上绿，而红的原因与被测行为毫无关系。
       */
      amountCr: input.amountCr + 0,
      balanceAfterCr: this.wallet(input.userId).balanceCr,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      priceVersion: input.priceVersion ?? null,
      /* 递增时刻：翻页游标按时间倒序，同一毫秒的多条会让分页断言不稳定 */
      createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, this.sequence)).toISOString(),
      /* 逐项明细要留住：调用方（Worker 的结算）靠它证明按哪个模型计的价 */
      metadata: input.metadata ?? {},
    });
    return true;
  }

  /** 测试直接给钱，不经过流水的幂等判定 */
  seed(userId: string, balanceCr: number): void {
    this.wallets.set(userId, { balanceCr, heldCr: 0 });
  }

  entries(): readonly LedgerEntry[] {
    return this.ledger;
  }

  balance(userId: string): Promise<WalletBalance> {
    const wallet = this.wallets.get(userId);
    return Promise.resolve({
      balanceCr: wallet?.balanceCr ?? 0,
      heldCr: wallet?.heldCr ?? 0,
    });
  }

  history(
    input: Parameters<CreditWalletRepository['history']>[0],
  ): Promise<readonly LedgerEntry[]> {
    const rows = [...this.ledger]
      .reverse()
      .filter((entry) => input.before === undefined || entry.createdAt < input.before)
      .slice(0, input.limit);
    return Promise.resolve(rows);
  }

  credit(
    input: Parameters<CreditWalletRepository['credit']>[0],
  ): Promise<{ readonly balanceCr: number; readonly replayed: boolean }> {
    const wallet = this.wallet(input.userId);
    if (this.keys.has(input.idempotencyKey)) {
      return Promise.resolve({ balanceCr: wallet.balanceCr, replayed: true });
    }
    wallet.balanceCr += input.amountCr;
    this.append({ ...input });
    return Promise.resolve({ balanceCr: wallet.balanceCr, replayed: false });
  }

  reserve(input: Parameters<CreditWalletRepository['reserve']>[0]): Promise<ReserveResult> {
    const held = this.holds.get(input.jobId);
    if (held !== undefined) {
      return Promise.resolve({ ok: false, reason: 'ALREADY_HELD', holdId: held.holdId });
    }
    const wallet = this.wallet(input.userId);
    if (wallet.balanceCr < input.amountCr) {
      return Promise.resolve({ ok: false, reason: 'INSUFFICIENT', balanceCr: wallet.balanceCr });
    }
    wallet.balanceCr -= input.amountCr;
    wallet.heldCr += input.amountCr;
    this.sequence += 1;
    const holdId = `hold-${this.sequence}`;
    this.holds.set(input.jobId, {
      holdId,
      userId: input.userId,
      amountCr: input.amountCr,
      priceVersion: input.priceVersion,
      status: 'ACTIVE',
      expiresAt: input.expiresAt,
    });
    return Promise.resolve({ ok: true, holdId, balanceCr: wallet.balanceCr });
  }

  settle(input: Parameters<CreditWalletRepository['settle']>[0]): Promise<SettleResult> {
    const hold = this.holds.get(input.jobId);
    if (hold === undefined || hold.status !== 'ACTIVE') {
      return Promise.resolve({ chargedCr: 0, refundedCr: 0, writeOffCr: 0, replayed: true });
    }
    hold.status = 'SETTLED';
    const wallet = this.wallet(hold.userId);
    const fromHold = Math.min(input.actualCr, hold.amountCr);
    const refundedCr = hold.amountCr - fromHold;
    const overage = input.actualCr - fromHold;
    const fromBalance = Math.min(overage, wallet.balanceCr);
    wallet.heldCr -= hold.amountCr;
    wallet.balanceCr += refundedCr - fromBalance;
    this.append({
      userId: hold.userId,
      kind: 'SPEND',
      amountCr: -(fromHold + fromBalance),
      idempotencyKey: `job:${input.jobId}`,
      refType: 'JOB',
      refId: input.jobId,
      priceVersion: hold.priceVersion,
      metadata: { lines: input.lines, unpriced: input.unpriced },
    });
    if (overage - fromBalance > 0) {
      this.append({
        userId: hold.userId,
        kind: 'WRITE_OFF',
        amountCr: 0,
        idempotencyKey: `writeoff:${input.jobId}`,
        refType: 'JOB',
        refId: input.jobId,
        priceVersion: hold.priceVersion,
      });
    }
    return Promise.resolve({
      chargedCr: fromHold + fromBalance,
      refundedCr,
      writeOffCr: overage - fromBalance,
      replayed: false,
    });
  }

  releaseFailed(
    input: Parameters<CreditWalletRepository['releaseFailed']>[0],
  ): Promise<{ readonly refundedCr: number; readonly replayed: boolean }> {
    const hold = this.holds.get(input.jobId);
    if (hold === undefined || hold.status !== 'ACTIVE') {
      return Promise.resolve({ refundedCr: 0, replayed: true });
    }
    hold.status = 'RELEASED';
    const wallet = this.wallet(hold.userId);
    wallet.heldCr -= hold.amountCr;
    wallet.balanceCr += hold.amountCr;
    this.append({
      userId: hold.userId,
      kind: 'REFUND',
      amountCr: hold.amountCr,
      idempotencyKey: `refund:${input.jobId}`,
      refType: 'JOB',
      refId: input.jobId,
    });
    /* 与真实实现一致：坏账单独一条，金额恒 0（金额本身在 metadata 里） */
    if (input.burnedCr > 0) {
      this.append({
        userId: hold.userId,
        kind: 'WRITE_OFF',
        amountCr: 0,
        idempotencyKey: `writeoff:${input.jobId}`,
        refType: 'JOB',
        refId: input.jobId,
      });
    }
    return Promise.resolve({ refundedCr: hold.amountCr, replayed: false });
  }

  expireHolds(
    input: Parameters<CreditWalletRepository['expireHolds']>[0],
  ): Promise<readonly ExpiredHoldOutcome[]> {
    const cutoff = input.now ?? new Date();
    const outcomes: ExpiredHoldOutcome[] = [];

    /* 与真实实现一致：按到期时间升序（最旧的先清），并受 limit 约束 */
    const expired = [...this.holds.entries()]
      .filter(([, hold]) => hold.status === 'ACTIVE' && hold.expiresAt < cutoff)
      .sort((a, b) => a[1].expiresAt.getTime() - b[1].expiresAt.getTime())
      .slice(0, input.limit);

    for (const [jobId, hold] of expired) {
      hold.status = 'EXPIRED';
      const wallet = this.wallet(hold.userId);
      wallet.heldCr -= hold.amountCr;
      wallet.balanceCr += hold.amountCr;
      /* 键与真实实现同形：`expire:<hold_id>`，不与 `refund:<job_id>` 撞 */
      this.append({
        userId: hold.userId,
        kind: 'REFUND',
        amountCr: hold.amountCr,
        idempotencyKey: `expire:${hold.holdId}`,
        refType: 'JOB',
        refId: jobId,
        priceVersion: hold.priceVersion,
        metadata: { reason: 'HOLD_EXPIRED' },
      });
      outcomes.push({
        holdId: hold.holdId,
        userId: hold.userId,
        jobId,
        refundedCr: hold.amountCr,
        overdueSeconds: Math.max(
          0,
          Math.round((cutoff.getTime() - hold.expiresAt.getTime()) / 1000),
        ),
      });
    }

    return Promise.resolve(outcomes);
  }

  charge(
    input: Parameters<CreditWalletRepository['charge']>[0],
  ): Promise<{ readonly ok: boolean; readonly balanceCr: number }> {
    const wallet = this.wallet(input.userId);
    if (this.keys.has(input.idempotencyKey)) {
      return Promise.resolve({ ok: true, balanceCr: wallet.balanceCr });
    }
    if (wallet.balanceCr < input.amountCr) {
      return Promise.resolve({ ok: false, balanceCr: wallet.balanceCr });
    }
    wallet.balanceCr -= input.amountCr;
    this.append({ ...input, kind: 'SPEND', amountCr: -input.amountCr });
    return Promise.resolve({ ok: true, balanceCr: wallet.balanceCr });
  }

  refund(
    input: Parameters<CreditWalletRepository['refund']>[0],
  ): Promise<{ readonly balanceCr: number; readonly replayed: boolean }> {
    const wallet = this.wallet(input.userId);
    if (this.keys.has(input.idempotencyKey)) {
      return Promise.resolve({ balanceCr: wallet.balanceCr, replayed: true });
    }
    wallet.balanceCr += input.amountCr;
    this.append({ ...input, kind: 'REFUND' });
    return Promise.resolve({ balanceCr: wallet.balanceCr, replayed: false });
  }

  publishedPrices(): Promise<PriceBook | null> {
    return Promise.resolve(this.priceBook);
  }

  findHold(jobId: string): Promise<CreditHold | null> {
    const hold = this.holds.get(jobId);
    if (hold === undefined) return Promise.resolve(null);
    return Promise.resolve({
      holdId: hold.holdId,
      userId: hold.userId,
      amountCr: hold.amountCr,
      priceVersion: hold.priceVersion,
      status: hold.status as CreditHold['status'],
    });
  }

  /**
   * 按版本取价目表。
   *
   * 内存版只装得下 `priceBook` 一版，因此这里按版本号比对而不是真的存多版：
   * 被测的行为是「结算用预留锁定的那一版」，而版本号对不上时返回 null
   * 恰好覆盖了「那一版查不到 → 不计费」这条降级分支。
   */
  findSpend(input: {
    readonly refType: string;
    readonly refId: string;
  }): Promise<CreditSpend | null> {
    /* 倒序找最后一笔，与真实实现的 `ORDER BY created_at DESC LIMIT 1` 一致 */
    const row = [...this.ledger]
      .reverse()
      .find(
        (entry) =>
          entry.kind === 'SPEND' && entry.refType === input.refType && entry.refId === input.refId,
      );
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({
      userId: this.entryOwner.get(row.entryId) ?? '',
      chargedCr: Math.abs(row.amountCr),
      priceVersion: row.priceVersion,
    });
  }

  pricesForVersion(version: number): Promise<PriceBook | null> {
    const book = this.priceBook;
    return Promise.resolve(book !== null && book.version === version ? book : null);
  }
}

/**
 * 测试用的最小价目表：只登记会被走到的那几项。
 *
 * **数字是示意值，不是迁移 0013 的种子价。** 用另一套数让测试里的断言
 * （比如「PDF 扣 80」）不会因为运营调价而变红 —— 那些断言测的是
 * 「按格式取对应 SKU」，不是「PDF 值多少钱」。
 */
export function samplePriceBook(overrides: Partial<PriceBook> = {}): PriceBook {
  return {
    version: 7,
    publishedAt: '2026-04-01T00:00:00.000Z',
    items: {
      'plan.base_fee': { sku: 'plan.base_fee', unit: 'PER_JOB', priceCr: 100 },
      'llm.in:*': { sku: 'llm.in:*', unit: 'PER_MILLION_TOKENS', priceCr: 15_000 },
      'llm.out:*': { sku: 'llm.out:*', unit: 'PER_MILLION_TOKENS', priceCr: 60_000 },
      'embedding.in:*': { sku: 'embedding.in:*', unit: 'PER_MILLION_TOKENS', priceCr: 1_000 },
      'image.ai_generate': { sku: 'image.ai_generate', unit: 'PER_ITEM', priceCr: 200 },
      'image.search': { sku: 'image.search', unit: 'PER_ITEM', priceCr: 10 },
      'render.page': { sku: 'render.page', unit: 'PER_ITEM', priceCr: 20 },
      'export.png': { sku: 'export.png', unit: 'PER_ITEM', priceCr: 50 },
      'export.pdf': { sku: 'export.pdf', unit: 'PER_ITEM', priceCr: 80 },
    },
    ...overrides,
  };
}
