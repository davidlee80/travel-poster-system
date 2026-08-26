import type { Pool, PoolClient } from 'pg';

import type { BillingUnit, PriceBook, PriceItem, PricedLine } from '@tps/billing';

/**
 * CR 钱包与流水（迁移 0013）。
 *
 * ## 这一层的全部职责是「不出错地动钱」
 *
 * 定价、估算、SKU 都在 `@tps/billing`（纯函数）。这里只做四件事：
 * 原子预留、幂等结算、退款、授予。每一件都必须满足两条：
 *
 *   1. **并发下不超发** —— 两个请求同时预留，余额只够一次时恰好一个成功
 *   2. **重复执行不重复扣** —— 任务重投、worker 接管都会让结算跑第二次
 *
 * 第 1 条靠 `UPDATE ... WHERE balance_cr >= $n`（单语句，天然原子）；
 * 第 2 条靠 `credit_ledger.idempotency_key` 的唯一约束。两者都在数据库层，
 * 不依赖应用层「记得先查一次」—— 那种写法在并发下必然有窗口。
 *
 * ## 钱包行是懒创建的
 *
 * 迁移 0013 之前注册的用户没有钱包行，而给存量用户批量建行是一次
 * 全表写入（且之后每个新用户还要记得建）。因此每个写入口都先
 * `INSERT ... ON CONFLICT DO NOTHING` —— 幂等、无锁、不需要回填迁移。
 */

// ── 类型 ────────────────────────────────────────────────────

export interface WalletBalance {
  readonly balanceCr: number;
  readonly heldCr: number;
}

export type LedgerKind = 'TOPUP' | 'GRANT' | 'SPEND' | 'REFUND' | 'WRITE_OFF' | 'ADJUST';

export interface LedgerEntry {
  readonly entryId: string;
  readonly kind: LedgerKind;
  readonly amountCr: number;
  readonly balanceAfterCr: number;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly priceVersion: number | null;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type ReserveResult =
  | { readonly ok: true; readonly holdId: string; readonly balanceCr: number }
  /** 余额不足。带上当前余额，让 402 能告诉用户还差多少 */
  | { readonly ok: false; readonly reason: 'INSUFFICIENT'; readonly balanceCr: number }
  /** 这个任务已经预留过了。幂等重放，不再扣一次 */
  | { readonly ok: false; readonly reason: 'ALREADY_HELD'; readonly holdId: string };

export interface SettleResult {
  /** 实际扣掉的 CR（正数） */
  readonly chargedCr: number;
  /** 退回余额的 CR */
  readonly refundedCr: number;
  /**
   * 超出预留又超出余额、由我们承担的部分。
   *
   * 非 0 意味着估算不准到了「用户余额兜不住」的程度，应当告警 ——
   * 它直接是我们的损失。
   */
  readonly writeOffCr: number;
  /** 幂等重放（这个任务已经结算过）时为 true，上面三个数是原来那次的 */
  readonly replayed: boolean;
}

export interface CreditHold {
  readonly holdId: string;
  readonly userId: string;
  readonly amountCr: number;
  /** 预留时锁定的价目版本。**结算必须按它算钱**，理由见 `pricesForVersion` */
  readonly priceVersion: number;
  readonly status: 'ACTIVE' | 'SETTLED' | 'RELEASED' | 'EXPIRED';
}

export interface CreditSpend {
  readonly userId: string;
  /** 实际扣掉的 CR，**正数**（流水里它是负的，方向由 kind 表达） */
  readonly chargedCr: number;
  readonly priceVersion: number | null;
}

export interface CreditWalletRepository {
  balance(userId: string): Promise<WalletBalance>;
  history(input: {
    readonly userId: string;
    readonly limit: number;
    readonly before?: string;
  }): Promise<readonly LedgerEntry[]>;

  /** 进账。`kind` 只允许 TOPUP / GRANT / ADJUST */
  credit(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly kind: 'TOPUP' | 'GRANT' | 'ADJUST';
    readonly idempotencyKey: string;
    readonly refType?: string;
    readonly refId?: string;
    readonly paymentRef?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly balanceCr: number; readonly replayed: boolean }>;

  /** 生成任务的预留 */
  reserve(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly amountCr: number;
    readonly priceVersion: number;
    readonly expiresAt: Date;
  }): Promise<ReserveResult>;

  /** 任务成功：按真实用量结算，多退、少补（不足由我们承担） */
  settle(input: {
    readonly jobId: string;
    readonly actualCr: number;
    readonly lines: readonly PricedLine[];
    readonly unpriced: readonly string[];
  }): Promise<SettleResult>;

  /** 任务失败：预留全额退，另记一条坏账 */
  releaseFailed(input: {
    readonly jobId: string;
    /** 我们实际烧掉的成本，只记账不扣用户 */
    readonly burnedCr: number;
    readonly lines: readonly PricedLine[];
  }): Promise<{ readonly refundedCr: number; readonly replayed: boolean }>;

  /** 导出：定价固定，一次原子扣减 */
  charge(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly idempotencyKey: string;
    readonly refType: string;
    readonly refId: string;
    readonly priceVersion: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly ok: boolean; readonly balanceCr: number }>;

  /** 导出任务失败时退回 */
  refund(input: {
    readonly userId: string;
    readonly amountCr: number;
    readonly idempotencyKey: string;
    readonly refType: string;
    readonly refId: string;
  }): Promise<{ readonly balanceCr: number; readonly replayed: boolean }>;

  /** 当前发布的价目表。`null` = 一版都没发布 */
  publishedPrices(): Promise<PriceBook | null>;

  /** 这个任务的预留。`null` = 没预留过（0013 之前入队，或计费当时关着） */
  findHold(jobId: string): Promise<CreditHold | null>;

  /**
   * 按业务对象回查那一笔消费。`null` = 没扣过费。
   *
   * 存在的理由只有一个：**导出失败时要退回「当时实际扣的那个数」**。
   * 现算一遍（`estimateExportCost` × 当前价目）在调价窗口内会退错数，
   * 而退错数比不退更糟 —— 少退是我们赖账，多退是可以被反复触发的漏洞。
   *
   * `credit_ledger_ref_idx (ref_type, ref_id)` 正是为这类回查建的。
   */
  findSpend(input: {
    readonly refType: string;
    readonly refId: string;
  }): Promise<CreditSpend | null>;

  /**
   * 指定版本的价目表，**不看它是否仍是发布版**。
   *
   * 结算必须用 `credit_holds.price_version` 那一版，而不是当前发布版：
   * 运营在任务在途时调价，用当前版结算会让用户按他提交时看不到的价格被扣。
   * 「已提交的任务不受调价影响」这条承诺就落在这个方法上。
   */
  pricesForVersion(version: number): Promise<PriceBook | null>;
}

// ── 实现 ────────────────────────────────────────────────────

interface WalletRow {
  readonly balance_cr: string;
  readonly held_cr: string;
}

interface LedgerRow {
  readonly entry_id: string;
  readonly kind: LedgerKind;
  readonly amount_cr: string;
  readonly balance_after_cr: string;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly price_version: string | null;
  readonly created_at: Date;
  readonly metadata: Record<string, unknown>;
}

/**
 * `BIGINT` 在 node-postgres 里回来是字符串。
 *
 * 不配置全局类型解析器（`pg.types.setTypeParser`）：那会改掉整个进程里
 * 所有 BIGINT 列的行为，包括别的仓储读的那些。就地转换的代价是每处都要记得，
 * 而这个函数让「记得」变成一次 import。
 *
 * CR 的量级（1 元 = 1000 CR）下 `Number.MAX_SAFE_INTEGER` 能表示 9 万亿元，
 * 因此转成 number 是安全的。
 */
function big(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** 每个写入口都先确保钱包行存在。幂等、无锁 */
async function ensureWallet(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO credit_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

interface LedgerInput {
  readonly userId: string;
  readonly kind: LedgerKind;
  readonly amountCr: number;
  readonly balanceAfterCr: number;
  readonly idempotencyKey: string;
  readonly refType?: string | undefined;
  readonly refId?: string | undefined;
  readonly priceVersion?: number | undefined;
  readonly paymentRef?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * 写一条流水。**返回 false 表示这个幂等键已经存在**（即本次是重放）。
 *
 * `ON CONFLICT DO NOTHING` + `RETURNING` 的行数就是判据 —— 不需要先 SELECT
 * 再 INSERT，那两步之间在并发下有窗口，而窗口里两个事务会各写一条。
 */
async function appendLedger(client: PoolClient, input: LedgerInput): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO credit_ledger (
       entry_id, user_id, kind, amount_cr, balance_after_cr,
       ref_type, ref_id, price_version, payment_ref, metadata, idempotency_key)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING entry_id`,
    [
      input.userId,
      input.kind,
      input.amountCr,
      input.balanceAfterCr,
      input.refType ?? null,
      input.refId ?? null,
      input.priceVersion ?? null,
      input.paymentRef ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.idempotencyKey,
    ],
  );
  return result.rowCount === 1;
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createCreditWalletRepository(pool: Pool): CreditWalletRepository {
  return {
    async balance(userId) {
      const result = await pool.query<WalletRow>(
        `SELECT balance_cr, held_cr FROM credit_wallets WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      /* 没有钱包行 = 从没进过账，等价于 0。不在读路径上建行（那会让 GET 变成写） */
      if (row === undefined) return { balanceCr: 0, heldCr: 0 };
      return { balanceCr: big(row.balance_cr), heldCr: big(row.held_cr) };
    },

    async history({ userId, limit, before }) {
      /*
       * 游标用 `created_at` 而不是 offset：流水会持续追加，
       * offset 分页在翻页期间插入新行时会漏掉或重复条目。
       */
      const result = await pool.query<LedgerRow>(
        `SELECT entry_id, kind, amount_cr, balance_after_cr, ref_type, ref_id,
                price_version, created_at, metadata
         FROM credit_ledger
         WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
         ORDER BY created_at DESC, entry_id DESC
         LIMIT $3`,
        [userId, before ?? null, limit],
      );
      return result.rows.map((row) => ({
        entryId: row.entry_id,
        kind: row.kind,
        amountCr: big(row.amount_cr),
        balanceAfterCr: big(row.balance_after_cr),
        refType: row.ref_type,
        refId: row.ref_id,
        priceVersion: row.price_version === null ? null : big(row.price_version),
        createdAt: row.created_at.toISOString(),
        metadata: row.metadata,
      }));
    },

    async credit(input) {
      if (input.amountCr <= 0) throw new Error(`进账金额必须为正，实际 ${input.amountCr}`);

      return inTransaction(pool, async (client) => {
        await ensureWallet(client, input.userId);
        /*
         * 先加钱再写流水，因为流水要记 `balance_after_cr`。
         * 若幂等键已存在则整个事务回滚 —— 加的钱一起撤销。
         */
        const updated = await client.query<WalletRow>(
          `UPDATE credit_wallets SET balance_cr = balance_cr + $2
           WHERE user_id = $1 RETURNING balance_cr, held_cr`,
          [input.userId, input.amountCr],
        );
        const balanceCr = big(updated.rows[0]?.balance_cr ?? '0');

        const fresh = await appendLedger(client, {
          userId: input.userId,
          kind: input.kind,
          amountCr: input.amountCr,
          balanceAfterCr: balanceCr,
          idempotencyKey: input.idempotencyKey,
          refType: input.refType,
          refId: input.refId,
          paymentRef: input.paymentRef,
          metadata: input.metadata,
        });

        if (!fresh) {
          /*
           * 重放：把刚加的钱撤掉，返回撤销后的余额。
           *
           * 用「加了再撤」而不是「先查幂等键再决定加不加」：后者要多一次
           * 往返，且查询与写入之间的窗口里两个并发重放会都通过检查。
           * 这里的撤销在同一个事务内，对外不可见。
           */
          const reverted = await client.query<WalletRow>(
            `UPDATE credit_wallets SET balance_cr = balance_cr - $2
             WHERE user_id = $1 RETURNING balance_cr, held_cr`,
            [input.userId, input.amountCr],
          );
          return { balanceCr: big(reverted.rows[0]?.balance_cr ?? '0'), replayed: true };
        }

        return { balanceCr, replayed: false };
      });
    },

    async reserve(input) {
      if (input.amountCr <= 0) throw new Error(`预留金额必须为正，实际 ${input.amountCr}`);

      return inTransaction(pool, async (client): Promise<ReserveResult> => {
        /* 同一任务重复提交（队列重投、幂等命中之外的竞态）不再扣第二次 */
        const existing = await client.query<{ hold_id: string }>(
          `SELECT hold_id FROM credit_holds WHERE job_id = $1`,
          [input.jobId],
        );
        const held = existing.rows[0];
        if (held !== undefined) {
          return { ok: false, reason: 'ALREADY_HELD', holdId: held.hold_id };
        }

        await ensureWallet(client, input.userId);

        /*
         * **不超发的关键就是这一条语句。**
         *
         * 谓词与更新在同一条 UPDATE 里，因此「检查余额」与「扣减余额」之间
         * 不存在窗口。写成 SELECT + 比较 + UPDATE 的话，两个并发请求会都
         * 读到足够的余额然后各扣一次 —— 而那正是超发。
         */
        const moved = await client.query<WalletRow>(
          `UPDATE credit_wallets
           SET balance_cr = balance_cr - $2, held_cr = held_cr + $2
           WHERE user_id = $1 AND balance_cr >= $2
           RETURNING balance_cr, held_cr`,
          [input.userId, input.amountCr],
        );

        if (moved.rowCount === 0) {
          const current = await client.query<WalletRow>(
            `SELECT balance_cr, held_cr FROM credit_wallets WHERE user_id = $1`,
            [input.userId],
          );
          return {
            ok: false,
            reason: 'INSUFFICIENT',
            balanceCr: big(current.rows[0]?.balance_cr ?? '0'),
          };
        }

        const created = await client.query<{ hold_id: string }>(
          `INSERT INTO credit_holds (hold_id, user_id, job_id, amount_cr, price_version, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
           RETURNING hold_id`,
          [input.userId, input.jobId, input.amountCr, input.priceVersion, input.expiresAt],
        );

        /*
         * 预留**不写流水**：钱还在用户账上，只是从可用挪到了冻结。
         * 写一条 SPEND 会让「求和 = 余额」这条自校验失效，
         * 也会让用户在流水里看到一笔尚未发生的消费。
         */
        return {
          ok: true,
          holdId: created.rows[0]?.hold_id ?? '',
          balanceCr: big(moved.rows[0]?.balance_cr ?? '0'),
        };
      });
    },

    async settle(input) {
      return inTransaction(pool, async (client): Promise<SettleResult> => {
        /*
         * `FOR UPDATE` 锁住这笔预留：两个并发结算（重投 + 原任务）会串行，
         * 第二个看到的是已经 SETTLED 的状态，走重放分支。
         */
        const holdRow = await client.query<{
          hold_id: string;
          user_id: string;
          amount_cr: string;
          price_version: string;
          status: string;
        }>(
          `SELECT hold_id, user_id, amount_cr, price_version, status
           FROM credit_holds WHERE job_id = $1 FOR UPDATE`,
          [input.jobId],
        );
        const hold = holdRow.rows[0];
        if (hold === undefined) {
          /*
           * 没有预留却要结算。可能是 0013 之前入队的任务，也可能是预留被
           * 过期清理掉了。**不扣费**并原样返回 —— 凭空扣一笔用户看不懂的钱
           * 比少收一笔严重得多。
           */
          return { chargedCr: 0, refundedCr: 0, writeOffCr: 0, replayed: true };
        }

        const key = `job:${input.jobId}`;
        if (hold.status !== 'ACTIVE') {
          /* 已结算过。返回原来那次的金额，从流水里读回来 */
          const prior = await client.query<{
            amount_cr: string;
            metadata: Record<string, unknown>;
          }>(`SELECT amount_cr, metadata FROM credit_ledger WHERE idempotency_key = $1`, [key]);
          const row = prior.rows[0];
          const meta = (row?.metadata ?? {}) as { refunded_cr?: number; write_off_cr?: number };
          return {
            chargedCr: Math.abs(big(row?.amount_cr ?? '0')),
            refundedCr: meta.refunded_cr ?? 0,
            writeOffCr: meta.write_off_cr ?? 0,
            replayed: true,
          };
        }

        const holdCr = big(hold.amount_cr);
        const actual = Math.max(0, Math.round(input.actualCr));

        /*
         * 三种情形：
         *
         *   actual <= hold   从冻结扣 actual，差额退回可用
         *   actual >  hold   冻结全扣，超出部分从可用继续扣
         *   可用也不够       扣到 0，剩下的记 write_off 由我们承担
         *
         * 第三种是「预留取典型值」这个决定的代价，见 docs/用户货币与计费.md。
         * 让我们承担而不是把余额扣成负数：那一列有 `>= 0` 的 CHECK，
         * 事务会失败，而失败的结算会让任务卡在终态之前 ——
         * 用户的计划已经生成好了却永远看不到。
         */
        const fromHold = Math.min(actual, holdCr);
        const refundedCr = holdCr - fromHold;
        const overage = actual - fromHold;

        const wallet = await client.query<WalletRow>(
          `SELECT balance_cr FROM credit_wallets WHERE user_id = $1 FOR UPDATE`,
          [hold.user_id],
        );
        const available = big(wallet.rows[0]?.balance_cr ?? '0');
        const fromBalance = Math.min(overage, available);
        const writeOffCr = overage - fromBalance;

        const updated = await client.query<WalletRow>(
          `UPDATE credit_wallets
           SET held_cr = held_cr - $2, balance_cr = balance_cr + $3 - $4
           WHERE user_id = $1
           RETURNING balance_cr, held_cr`,
          [hold.user_id, holdCr, refundedCr, fromBalance],
        );
        const balanceAfter = big(updated.rows[0]?.balance_cr ?? '0');

        const chargedCr = fromHold + fromBalance;
        const priceVersion = big(hold.price_version);

        const fresh = await appendLedger(client, {
          userId: hold.user_id,
          kind: 'SPEND',
          amountCr: -chargedCr,
          balanceAfterCr: balanceAfter,
          idempotencyKey: key,
          refType: 'JOB',
          refId: input.jobId,
          priceVersion,
          metadata: {
            lines: input.lines,
            unpriced: input.unpriced,
            hold_cr: holdCr,
            refunded_cr: refundedCr,
            write_off_cr: writeOffCr,
          },
        });
        if (!fresh) {
          /*
           * 幂等键已存在而 hold 还是 ACTIVE —— 只有「上一次事务写了流水却
           * 没提交 hold 状态」才可能，而那两步在同一事务里。走到这里说明
           * 有人绕过了这个方法写流水，回滚比继续更安全。
           */
          throw new Error(`结算流水 ${key} 已存在但预留仍为 ACTIVE，数据不一致`);
        }

        /* 坏账单独一条，方向恒 0（见迁移 0013 的 CHECK） */
        if (writeOffCr > 0) {
          await appendLedger(client, {
            userId: hold.user_id,
            kind: 'WRITE_OFF',
            amountCr: 0,
            balanceAfterCr: balanceAfter,
            idempotencyKey: `writeoff:${input.jobId}`,
            refType: 'JOB',
            refId: input.jobId,
            priceVersion,
            metadata: { burned_cr: writeOffCr, reason: 'SETTLE_OVER_BALANCE' },
          });
        }

        await client.query(
          `UPDATE credit_holds SET status = 'SETTLED', settled_at = NOW() WHERE hold_id = $1`,
          [hold.hold_id],
        );

        return { chargedCr, refundedCr, writeOffCr, replayed: false };
      });
    },

    async releaseFailed(input) {
      return inTransaction(pool, async (client) => {
        const holdRow = await client.query<{
          hold_id: string;
          user_id: string;
          amount_cr: string;
          price_version: string;
          status: string;
        }>(
          `SELECT hold_id, user_id, amount_cr, price_version, status
           FROM credit_holds WHERE job_id = $1 FOR UPDATE`,
          [input.jobId],
        );
        const hold = holdRow.rows[0];
        if (hold === undefined) return { refundedCr: 0, replayed: true };
        if (hold.status !== 'ACTIVE') return { refundedCr: 0, replayed: true };

        const holdCr = big(hold.amount_cr);
        const updated = await client.query<WalletRow>(
          `UPDATE credit_wallets
           SET held_cr = held_cr - $2, balance_cr = balance_cr + $2
           WHERE user_id = $1 RETURNING balance_cr, held_cr`,
          [hold.user_id, holdCr],
        );
        const balanceAfter = big(updated.rows[0]?.balance_cr ?? '0');

        await appendLedger(client, {
          userId: hold.user_id,
          kind: 'REFUND',
          amountCr: holdCr,
          balanceAfterCr: balanceAfter,
          idempotencyKey: `refund:${input.jobId}`,
          refType: 'JOB',
          refId: input.jobId,
          priceVersion: big(hold.price_version),
          metadata: { reason: 'JOB_FAILED' },
        });

        /*
         * 坏账：我们已经付给供应商但不向用户收的钱。
         *
         * 记它而不是让失败静默无成本：一次上游故障会让大量任务失败，
         * 而每次失败都真的烧了钱。没有这条记录，「昨晚烧了多少」查不出来。
         */
        if (input.burnedCr > 0) {
          await appendLedger(client, {
            userId: hold.user_id,
            kind: 'WRITE_OFF',
            amountCr: 0,
            balanceAfterCr: balanceAfter,
            idempotencyKey: `writeoff:${input.jobId}`,
            refType: 'JOB',
            refId: input.jobId,
            priceVersion: big(hold.price_version),
            metadata: {
              burned_cr: input.burnedCr,
              lines: input.lines,
              reason: 'JOB_FAILED',
            },
          });
        }

        await client.query(
          `UPDATE credit_holds SET status = 'RELEASED', settled_at = NOW() WHERE hold_id = $1`,
          [hold.hold_id],
        );

        return { refundedCr: holdCr, replayed: false };
      });
    },

    async charge(input) {
      if (input.amountCr < 0) throw new Error(`扣费金额不能为负，实际 ${input.amountCr}`);

      return inTransaction(pool, async (client) => {
        await ensureWallet(client, input.userId);

        /* 与 reserve 同一手法：谓词与扣减在一条语句里 */
        const moved = await client.query<WalletRow>(
          `UPDATE credit_wallets SET balance_cr = balance_cr - $2
           WHERE user_id = $1 AND balance_cr >= $2
           RETURNING balance_cr`,
          [input.userId, input.amountCr],
        );

        if (moved.rowCount === 0) {
          const current = await client.query<WalletRow>(
            `SELECT balance_cr FROM credit_wallets WHERE user_id = $1`,
            [input.userId],
          );
          return { ok: false, balanceCr: big(current.rows[0]?.balance_cr ?? '0') };
        }

        const balanceCr = big(moved.rows[0]?.balance_cr ?? '0');
        const fresh = await appendLedger(client, {
          userId: input.userId,
          kind: 'SPEND',
          amountCr: -input.amountCr,
          balanceAfterCr: balanceCr,
          idempotencyKey: input.idempotencyKey,
          refType: input.refType,
          refId: input.refId,
          priceVersion: input.priceVersion,
          metadata: input.metadata,
        });

        if (!fresh) {
          /* 重放：把刚扣的退回去，理由同 `credit` */
          const reverted = await client.query<WalletRow>(
            `UPDATE credit_wallets SET balance_cr = balance_cr + $2
             WHERE user_id = $1 RETURNING balance_cr`,
            [input.userId, input.amountCr],
          );
          return { ok: true, balanceCr: big(reverted.rows[0]?.balance_cr ?? '0') };
        }

        return { ok: true, balanceCr };
      });
    },

    async refund(input) {
      return inTransaction(pool, async (client) => {
        await ensureWallet(client, input.userId);
        const updated = await client.query<WalletRow>(
          `UPDATE credit_wallets SET balance_cr = balance_cr + $2
           WHERE user_id = $1 RETURNING balance_cr`,
          [input.userId, input.amountCr],
        );
        const balanceCr = big(updated.rows[0]?.balance_cr ?? '0');

        const fresh = await appendLedger(client, {
          userId: input.userId,
          kind: 'REFUND',
          amountCr: input.amountCr,
          balanceAfterCr: balanceCr,
          idempotencyKey: input.idempotencyKey,
          refType: input.refType,
          refId: input.refId,
        });

        if (!fresh) {
          const reverted = await client.query<WalletRow>(
            `UPDATE credit_wallets SET balance_cr = balance_cr - $2
             WHERE user_id = $1 RETURNING balance_cr`,
            [input.userId, input.amountCr],
          );
          return { balanceCr: big(reverted.rows[0]?.balance_cr ?? '0'), replayed: true };
        }

        return { balanceCr, replayed: false };
      });
    },

    async publishedPrices() {
      const result = await pool.query<PriceRow>(
        `SELECT version, published_at, sku, unit, price_cr
         FROM credit_prices_current
         ORDER BY sku`,
      );
      return toPriceBook(result.rows);
    },

    async findHold(jobId) {
      const result = await pool.query<{
        hold_id: string;
        user_id: string;
        amount_cr: string;
        price_version: string;
        status: CreditHold['status'];
      }>(
        `SELECT hold_id, user_id, amount_cr, price_version, status
         FROM credit_holds WHERE job_id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        holdId: row.hold_id,
        userId: row.user_id,
        amountCr: big(row.amount_cr),
        priceVersion: big(row.price_version),
        status: row.status,
      };
    },

    async findSpend({ refType, refId }) {
      const result = await pool.query<{
        user_id: string;
        amount_cr: string;
        price_version: string | null;
      }>(
        `SELECT user_id, amount_cr, price_version
         FROM credit_ledger
         WHERE ref_type = $1 AND ref_id = $2 AND kind = 'SPEND'
         ORDER BY created_at DESC
         LIMIT 1`,
        [refType, refId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        userId: row.user_id,
        /* 流水里是负数，调用方要的是「退多少」 */
        chargedCr: Math.abs(big(row.amount_cr)),
        priceVersion: row.price_version === null ? null : big(row.price_version),
      };
    },

    async pricesForVersion(version) {
      /*
       * 直接查两张表而不是 `credit_prices_current` 视图：那个视图只含发布版，
       * 而这里要的恰恰是「可能已经被归档的那一版」。
       */
      const result = await pool.query<PriceRow>(
        `SELECT v.version, COALESCE(v.published_at, v.created_at) AS published_at,
                i.sku, i.unit, i.price_cr
         FROM credit_price_versions v
         JOIN credit_price_items i ON i.version_id = v.id
         WHERE v.version = $1
         ORDER BY i.sku`,
        [version],
      );
      return toPriceBook(result.rows);
    },
  };
}

interface PriceRow {
  readonly version: string;
  readonly published_at: Date;
  readonly sku: string;
  readonly unit: string;
  readonly price_cr: string;
}

function toPriceBook(rows: readonly PriceRow[]): PriceBook | null {
  const first = rows[0];
  if (first === undefined) return null;

  const items: Record<string, PriceItem> = {};
  for (const row of rows) {
    items[row.sku] = {
      sku: row.sku,
      unit: row.unit as BillingUnit,
      priceCr: big(row.price_cr),
    };
  }
  return {
    version: big(first.version),
    publishedAt: first.published_at.toISOString(),
    items,
  };
}
