import type { PriceBook, PricedLine } from '@tps/billing';
import type {
  CreditWalletRepository,
  LedgerEntry,
  LedgerKind,
  ReserveResult,
  SettleResult,
  WalletBalance,
} from '@tps/db';

/**
 * 内存钱包（测试用），形态照 `FakeUsersRepository`。
 *
 * ## 它刻意**不**复刻 SQL 的原子性
 *
 * 「并发下不超发」靠的是 `UPDATE ... WHERE balance_cr >= $n` 的单语句
 * 原子性，而那条性质只能在真库上验证 —— `credit-wallet.integration.test.ts`
 * 的 26 项就是为此存在的。在这里用 JS 重写一遍，测到的只是我对「原子」
 * 这个词的理解。
 *
 * 因此这个假实现的用途只有一个：让**端点层**的测试能覆盖 HTTP 契约 ——
 * 402 的时机、`details` 的数值、幂等命中不扣费、取消刚建的任务。
 * 那些分支与 SQL 无关，却是用户唯一能看到的部分。
 */
export class FakeCreditWalletRepository implements CreditWalletRepository {
  private readonly wallets = new Map<string, { balanceCr: number; heldCr: number }>();
  private readonly ledger: LedgerEntry[] = [];
  private readonly keys = new Set<string>();
  private readonly holds = new Map<
    string,
    { holdId: string; userId: string; amountCr: number; priceVersion: number; status: string }
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
  }): boolean {
    if (this.keys.has(input.idempotencyKey)) return false;
    this.keys.add(input.idempotencyKey);
    this.sequence += 1;
    this.ledger.push({
      entryId: `entry-${this.sequence}`,
      kind: input.kind,
      amountCr: input.amountCr,
      balanceAfterCr: this.wallet(input.userId).balanceCr,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      priceVersion: input.priceVersion ?? null,
      /* 递增时刻：翻页游标按时间倒序，同一毫秒的多条会让分页断言不稳定 */
      createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, this.sequence)).toISOString(),
      metadata: {},
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

  history(input: {
    readonly userId: string;
    readonly limit: number;
    readonly before?: string;
  }): Promise<readonly LedgerEntry[]> {
    const rows = [...this.ledger]
      .reverse()
      .filter((entry) => input.before === undefined || entry.createdAt < input.before)
      .slice(0, input.limit);
    return Promise.resolve(rows);
  }

  credit(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly kind: 'TOPUP' | 'GRANT' | 'ADJUST';
    readonly idempotencyKey: string;
  }): Promise<{ readonly balanceCr: number; readonly replayed: boolean }> {
    const wallet = this.wallet(input.userId);
    if (this.keys.has(input.idempotencyKey)) {
      return Promise.resolve({ balanceCr: wallet.balanceCr, replayed: true });
    }
    wallet.balanceCr += input.amountCr;
    this.append({ ...input });
    return Promise.resolve({ balanceCr: wallet.balanceCr, replayed: false });
  }

  reserve(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly amountCr: number;
    readonly priceVersion: number;
  }): Promise<ReserveResult> {
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
    });
    return Promise.resolve({ ok: true, holdId, balanceCr: wallet.balanceCr });
  }

  settle(input: { readonly jobId: string; readonly actualCr: number }): Promise<SettleResult> {
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
    });
    return Promise.resolve({
      chargedCr: fromHold + fromBalance,
      refundedCr,
      writeOffCr: overage - fromBalance,
      replayed: false,
    });
  }

  releaseFailed(input: {
    readonly jobId: string;
    readonly burnedCr: number;
    readonly lines: readonly PricedLine[];
  }): Promise<{ readonly refundedCr: number; readonly replayed: boolean }> {
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
    return Promise.resolve({ refundedCr: hold.amountCr, replayed: false });
  }

  charge(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly idempotencyKey: string;
    readonly refType: string;
    readonly refId: string;
    readonly priceVersion: number;
  }): Promise<{ readonly ok: boolean; readonly balanceCr: number }> {
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

  refund(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly idempotencyKey: string;
    readonly refType: string;
    readonly refId: string;
  }): Promise<{ readonly balanceCr: number; readonly replayed: boolean }> {
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
}

/** 端点测试用的最小价目表：只登记会被走到的那几项 */
export function fakePriceBook(overrides: Partial<PriceBook> = {}): PriceBook {
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
