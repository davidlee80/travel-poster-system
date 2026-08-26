import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createCreditWalletRepository, type CreditWalletRepository } from './credit-wallet.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createPool } from './pool.js';
import { createUsersRepository, type UsersRepository } from './users.js';

/**
 * 钱包与流水（集成，迁移 0013）。
 *
 * ## 为什么这一组必须连真库
 *
 * 被测的两条性质**全在数据库层**，假实现测不到：
 *
 *   不超发    靠 `UPDATE ... WHERE balance_cr >= $n` 的单语句原子性
 *   不重扣    靠 `credit_ledger.idempotency_key` 的唯一约束
 *
 * 用内存假实现重写一遍这两条，测到的只是我对「原子」这个词的理解，
 * 而不是 Postgres 的行为。而这是钱 —— 超发一次是用户白拿，
 * 重扣一次是用户白付，两者都不会有人来提工单。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

describeIntegration('CR 钱包（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let wallet: CreditWalletRepository;
  let users: UsersRepository;
  let userId: string;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      /* 并发用例要同时开多条连接，池子给够 */
      maxConnections: 10,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    wallet = createCreditWalletRepository(pool);
    users = createUsersRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    /* 先删依赖方：流水与预留都 FK 到 users，钱包也是 */
    await pool.query('DELETE FROM credit_ledger');
    await pool.query('DELETE FROM credit_holds');
    await pool.query('DELETE FROM credit_wallets');
    await pool.query('DELETE FROM users');

    const row = await users.createRegistered({
      email: `wallet-${Date.now()}@example.invalid`,
      passwordHash: 'x'.repeat(60),
      displayName: '钱包测试',
      dailyQuota: 5,
      monthlyQuota: 20,
    });
    userId = row.id;
  });

  /** 直接读库，绕过仓储 —— 断言不该依赖被测代码的读路径 */
  async function raw(): Promise<{ balance: number; held: number }> {
    const result = await pool.query<{ balance_cr: string; held_cr: string }>(
      `SELECT balance_cr, held_cr FROM credit_wallets WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return {
      balance: Number(row?.balance_cr ?? '0'),
      held: Number(row?.held_cr ?? '0'),
    };
  }

  async function grant(amountCr: number, key = `grant-${Math.random()}`): Promise<void> {
    await wallet.credit({ userId, amountCr, kind: 'GRANT', idempotencyKey: key });
  }

  const future = (): Date => new Date(Date.now() + 3_600_000);

  describe('钱包懒创建', () => {
    it('没有钱包行时读余额为 0，且不建行', async () => {
      /*
       * 读路径不该写库 —— 否则一次 GET /credits/wallet 会在从库上失败，
       * 也会让「有多少活跃钱包」这个统计把只看过一眼的人算进去。
       */
      expect(await wallet.balance(userId)).toEqual({ balanceCr: 0, heldCr: 0 });
      const rows = await pool.query('SELECT 1 FROM credit_wallets WHERE user_id = $1', [userId]);
      expect(rows.rowCount).toBe(0);
    });

    it('第一次进账时建行', async () => {
      await grant(1_000);
      expect(await wallet.balance(userId)).toEqual({ balanceCr: 1_000, heldCr: 0 });
    });
  });

  describe('进账的幂等', () => {
    it('同一幂等键重复进账只加一次', async () => {
      await grant(1_000, 'signup:same');
      const second = await wallet.credit({
        userId,
        amountCr: 1_000,
        kind: 'GRANT',
        idempotencyKey: 'signup:same',
      });
      expect(second.replayed).toBe(true);
      expect(second.balanceCr).toBe(1_000);
      expect((await raw()).balance).toBe(1_000);

      const entries = await wallet.history({ userId, limit: 10 });
      expect(entries).toHaveLength(1);
    });

    it('并发的同键进账也只加一次', async () => {
      /*
       * 「先查幂等键再决定加不加」这种写法在这里会失守：两个事务都查不到，
       * 然后各加一次。唯一约束 + 同事务内撤销是唯一可靠的做法。
       */
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          wallet.credit({
            userId,
            amountCr: 500,
            kind: 'GRANT',
            idempotencyKey: 'signup:race',
          }),
        ),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect((await raw()).balance).toBe(500);
    });
  });

  describe('预留不超发', () => {
    it('余额够时从可用挪到冻结，总额守恒', async () => {
      await grant(1_000);
      const result = await wallet.reserve({
        userId,
        jobId: crypto.randomUUID(),
        amountCr: 600,
        priceVersion: 1,
        expiresAt: future(),
      });
      expect(result.ok).toBe(true);
      expect(await raw()).toEqual({ balance: 400, held: 600 });
    });

    it('余额不足时拒绝，且一分钱不动', async () => {
      await grant(100);
      const result = await wallet.reserve({
        userId,
        jobId: crypto.randomUUID(),
        amountCr: 600,
        priceVersion: 1,
        expiresAt: future(),
      });
      expect(result).toMatchObject({ ok: false, reason: 'INSUFFICIENT', balanceCr: 100 });
      expect(await raw()).toEqual({ balance: 100, held: 0 });
    });

    it('并发预留：余额只够一次时恰好一个成功', async () => {
      /*
       * **这是整个仓储层最重要的一条断言。**
       *
       * 余额 1000、每笔预留 600 —— 只够一笔。五路并发下必须恰好一个成功，
       * 且 `balance + held` 恒等于 1000（钱不会凭空多也不会凭空少）。
       */
      await grant(1_000);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          wallet.reserve({
            userId,
            jobId: crypto.randomUUID(),
            amountCr: 600,
            priceVersion: 1,
            expiresAt: future(),
          }),
        ),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const after = await raw();
      expect(after).toEqual({ balance: 400, held: 600 });
      expect(after.balance + after.held).toBe(1_000);
    });

    it('同一 job_id 重复预留返回 ALREADY_HELD，不扣第二次', async () => {
      await grant(2_000);
      const jobId = crypto.randomUUID();
      const first = await wallet.reserve({
        userId,
        jobId,
        amountCr: 600,
        priceVersion: 1,
        expiresAt: future(),
      });
      const second = await wallet.reserve({
        userId,
        jobId,
        amountCr: 600,
        priceVersion: 1,
        expiresAt: future(),
      });

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, reason: 'ALREADY_HELD' });
      expect(await raw()).toEqual({ balance: 1_400, held: 600 });
    });

    it('预留不写流水 —— 钱还在用户账上，只是挪了位置', async () => {
      await grant(1_000, 'g1');
      await wallet.reserve({
        userId,
        jobId: crypto.randomUUID(),
        amountCr: 600,
        priceVersion: 1,
        expiresAt: future(),
      });
      const entries = await wallet.history({ userId, limit: 10 });
      expect(entries.map((e) => e.kind)).toEqual(['GRANT']);
    });
  });

  describe('结算', () => {
    async function reserved(amountCr: number): Promise<string> {
      const jobId = crypto.randomUUID();
      const result = await wallet.reserve({
        userId,
        jobId,
        amountCr,
        priceVersion: 1,
        expiresAt: future(),
      });
      expect(result.ok).toBe(true);
      return jobId;
    }

    it('实际小于预留：扣实际，差额退回可用', async () => {
      await grant(1_000);
      const jobId = await reserved(600);

      const settled = await wallet.settle({ jobId, actualCr: 250, lines: [], unpriced: [] });
      expect(settled).toMatchObject({ chargedCr: 250, refundedCr: 350, writeOffCr: 0 });
      /* 1000 - 600（预留）+ 350（退回） = 750 */
      expect(await raw()).toEqual({ balance: 750, held: 0 });
    });

    it('实际超出预留：从可用继续扣', async () => {
      await grant(1_000);
      const jobId = await reserved(600);

      const settled = await wallet.settle({ jobId, actualCr: 800, lines: [], unpriced: [] });
      expect(settled).toMatchObject({ chargedCr: 800, refundedCr: 0, writeOffCr: 0 });
      expect(await raw()).toEqual({ balance: 200, held: 0 });
    });

    it('超出预留又超出可用：扣到 0，差额记坏账', async () => {
      /*
       * 「预留取典型值」这个决定的代价就在这条分支上。让我们承担而不是把
       * 余额扣成负数：那一列有 `>= 0` 的 CHECK，事务会失败，
       * 而失败的结算让任务卡在终态之前 —— 计划生成好了却永远看不到。
       */
      await grant(700);
      const jobId = await reserved(600);
      /* 冻结 600、可用 100，实际要 900 → 扣 700，坏账 200 */

      const settled = await wallet.settle({ jobId, actualCr: 900, lines: [], unpriced: [] });
      expect(settled).toMatchObject({ chargedCr: 700, refundedCr: 0, writeOffCr: 200 });
      expect(await raw()).toEqual({ balance: 0, held: 0 });

      const kinds = (await wallet.history({ userId, limit: 10 })).map((e) => e.kind);
      expect(kinds).toContain('WRITE_OFF');
    });

    it('重复结算不重复扣 —— 任务重投必然走到这里', async () => {
      await grant(1_000);
      const jobId = await reserved(600);

      const first = await wallet.settle({ jobId, actualCr: 250, lines: [], unpriced: [] });
      const second = await wallet.settle({ jobId, actualCr: 250, lines: [], unpriced: [] });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.chargedCr).toBe(250);
      expect(await raw()).toEqual({ balance: 750, held: 0 });
      expect(
        (await wallet.history({ userId, limit: 10 })).filter((e) => e.kind === 'SPEND'),
      ).toHaveLength(1);
    });

    it('并发结算只有一条生效', async () => {
      await grant(1_000);
      const jobId = await reserved(600);

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          wallet.settle({ jobId, actualCr: 250, lines: [], unpriced: [] }),
        ),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await raw()).toEqual({ balance: 750, held: 0 });
    });

    it('没有预留时不扣费 —— 凭空扣一笔用户看不懂的钱更严重', async () => {
      await grant(1_000);
      const settled = await wallet.settle({
        jobId: crypto.randomUUID(),
        actualCr: 500,
        lines: [],
        unpriced: [],
      });
      expect(settled).toMatchObject({ chargedCr: 0, replayed: true });
      expect(await raw()).toEqual({ balance: 1_000, held: 0 });
    });

    it('流水里带逐项明细与 price_version', async () => {
      await grant(1_000);
      const jobId = await reserved(600);
      await wallet.settle({
        jobId,
        actualCr: 250,
        lines: [{ sku: 'llm.out:gpt-x', quantity: 8_000, amountCr: 240 }],
        unpriced: ['llm.in:mystery'],
      });

      const spend = (await wallet.history({ userId, limit: 10 })).find((e) => e.kind === 'SPEND');
      expect(spend?.priceVersion).toBe(1);
      expect(spend?.metadata).toMatchObject({
        unpriced: ['llm.in:mystery'],
        hold_cr: 600,
        refunded_cr: 350,
      });
    });
  });

  describe('任务失败：全额退 + 记坏账', () => {
    it('预留全额回到可用，另记一条 WRITE_OFF', async () => {
      await grant(1_000);
      const jobId = crypto.randomUUID();
      await wallet.reserve({ userId, jobId, amountCr: 600, priceVersion: 1, expiresAt: future() });

      const released = await wallet.releaseFailed({ jobId, burnedCr: 180, lines: [] });
      expect(released).toMatchObject({ refundedCr: 600, replayed: false });
      /* 用户一分钱没花 */
      expect(await raw()).toEqual({ balance: 1_000, held: 0 });

      const entries = await wallet.history({ userId, limit: 10 });
      const writeOff = entries.find((e) => e.kind === 'WRITE_OFF');
      expect(writeOff?.amountCr).toBe(0);
      expect(writeOff?.metadata).toMatchObject({ burned_cr: 180, reason: 'JOB_FAILED' });
    });

    it('重复释放不重复退', async () => {
      await grant(1_000);
      const jobId = crypto.randomUUID();
      await wallet.reserve({ userId, jobId, amountCr: 600, priceVersion: 1, expiresAt: future() });

      await wallet.releaseFailed({ jobId, burnedCr: 100, lines: [] });
      const again = await wallet.releaseFailed({ jobId, burnedCr: 100, lines: [] });
      expect(again.replayed).toBe(true);
      expect(await raw()).toEqual({ balance: 1_000, held: 0 });
    });

    it('已结算的任务不能再被释放', async () => {
      await grant(1_000);
      const jobId = crypto.randomUUID();
      await wallet.reserve({ userId, jobId, amountCr: 600, priceVersion: 1, expiresAt: future() });
      await wallet.settle({ jobId, actualCr: 300, lines: [], unpriced: [] });

      const released = await wallet.releaseFailed({ jobId, burnedCr: 300, lines: [] });
      expect(released.replayed).toBe(true);
      /* 1000 - 300 = 700，没有因为「又退了一次」变成 1300 */
      expect(await raw()).toEqual({ balance: 700, held: 0 });
    });
  });

  describe('导出：直接扣与退回', () => {
    it('余额够时扣掉', async () => {
      await grant(100);
      const result = await wallet.charge({
        userId,
        amountCr: 50,
        idempotencyKey: 'export:abc',
        refType: 'EXPORT',
        refId: 'abc',
        priceVersion: 1,
      });
      expect(result).toEqual({ ok: true, balanceCr: 50 });
    });

    it('余额不足时拒绝且不动钱', async () => {
      await grant(10);
      const result = await wallet.charge({
        userId,
        amountCr: 50,
        idempotencyKey: 'export:abc',
        refType: 'EXPORT',
        refId: 'abc',
        priceVersion: 1,
      });
      expect(result).toEqual({ ok: false, balanceCr: 10 });
      expect((await raw()).balance).toBe(10);
    });

    it('同一幂等键重复扣只扣一次', async () => {
      await grant(100);
      const key = 'export:same';
      for (let i = 0; i < 3; i += 1) {
        await wallet.charge({
          userId,
          amountCr: 20,
          idempotencyKey: key,
          refType: 'EXPORT',
          refId: 'same',
          priceVersion: 1,
        });
      }
      expect((await raw()).balance).toBe(80);
    });

    it('退回也是幂等的', async () => {
      await grant(100);
      await wallet.charge({
        userId,
        amountCr: 20,
        idempotencyKey: 'export:x',
        refType: 'EXPORT',
        refId: 'x',
        priceVersion: 1,
      });
      await wallet.refund({
        userId,
        amountCr: 20,
        idempotencyKey: 'refund:export:x',
        refType: 'EXPORT',
        refId: 'x',
      });
      const again = await wallet.refund({
        userId,
        amountCr: 20,
        idempotencyKey: 'refund:export:x',
        refType: 'EXPORT',
        refId: 'x',
      });
      expect(again.replayed).toBe(true);
      expect((await raw()).balance).toBe(100);
    });
  });

  describe('流水自校验与分页', () => {
    it('每一行的 balance_after 与上一行加本次金额吻合', async () => {
      /*
       * 这条性质让流水能对账：任何一行的 after 都必须等于「上一行 after +
       * 本次 amount」。WRITE_OFF 恒 0，因此它不打断这条链 ——
       * 那正是迁移 0013 把它约束成 0 的理由。
       */
      await grant(1_000, 'a');
      await grant(500, 'b');
      const jobId = crypto.randomUUID();
      await wallet.reserve({ userId, jobId, amountCr: 600, priceVersion: 1, expiresAt: future() });
      await wallet.settle({ jobId, actualCr: 400, lines: [], unpriced: [] });

      const entries = [...(await wallet.history({ userId, limit: 50 }))].reverse();
      let running = 0;
      for (const entry of entries) {
        running += entry.amountCr;
        expect(entry.balanceAfterCr, `${entry.kind} 的 balance_after 与累加值不符`).toBe(running);
      }
      expect(running).toBe((await raw()).balance);
    });

    it('按时间倒序翻页', async () => {
      for (let i = 0; i < 5; i += 1) await grant(100, `p${i}`);
      const firstPage = await wallet.history({ userId, limit: 2 });
      expect(firstPage).toHaveLength(2);

      const cursor = firstPage[1]?.createdAt;
      const secondPage = await wallet.history({
        userId,
        limit: 2,
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      expect(secondPage).toHaveLength(2);
      /* 两页不重叠 */
      const ids = new Set([...firstPage, ...secondPage].map((e) => e.entryId));
      expect(ids.size).toBe(4);
    });
  });

  describe('预留回查（C-4）', () => {
    it('读到金额、锁定的价目版本与状态', async () => {
      await grant(2_000);
      const jobId = crypto.randomUUID();
      await wallet.reserve({ userId, jobId, amountCr: 600, priceVersion: 1, expiresAt: future() });

      const hold = await wallet.findHold(jobId);
      expect(hold).toMatchObject({ amountCr: 600, priceVersion: 1, status: 'ACTIVE' });
      expect(hold?.userId).toBe(userId);
    });

    it('结算后状态变 SETTLED（结算幂等的判据）', async () => {
      await grant(2_000);
      const jobId = crypto.randomUUID();
      await wallet.reserve({ userId, jobId, amountCr: 600, priceVersion: 1, expiresAt: future() });
      await wallet.settle({ jobId, actualCr: 300, lines: [], unpriced: [] });

      expect((await wallet.findHold(jobId))?.status).toBe('SETTLED');
    });

    it('没预留过的任务返回 null（0013 之前入队的任务走这条）', async () => {
      expect(await wallet.findHold(crypto.randomUUID())).toBeNull();
    });
  });

  describe('按版本取价目（C-4）', () => {
    it('取得到尚未发布的草稿版 —— 结算要的正是「可能已不是发布版」的那一版', async () => {
      /*
       * 这条断言是「已提交的任务不受调价影响」那句承诺的落点：
       * `credit_prices_current` 视图只含发布版，而结算要按预留锁定的版本算钱。
       * 用视图实现的话，运营一发布新版，在途任务全部按新价结算。
       */
      await pool.query(`SELECT clone_credit_prices(1, 2, '测试用草稿')`);
      await pool.query(
        `UPDATE credit_price_items i SET price_cr = 12345
         FROM credit_price_versions v
         WHERE i.version_id = v.id AND v.version = 2 AND i.sku = 'llm.out:*'`,
      );

      const draft = await wallet.pricesForVersion(2);
      expect(draft?.version).toBe(2);
      expect(draft?.items['llm.out:*']?.priceCr).toBe(12_345);

      /* 发布版仍是 1，且它的价格没被改动 */
      const published = await wallet.publishedPrices();
      expect(published?.version).toBe(1);
      expect(published?.items['llm.out:*']?.priceCr).toBe(60_000);

      await pool.query(`DELETE FROM credit_price_versions WHERE version = 2`);
    });

    it('不存在的版本返回 null（调用方据此不计费）', async () => {
      expect(await wallet.pricesForVersion(9_999)).toBeNull();
    });
  });

  describe('价目表', () => {
    it('读到迁移 0013 种下的版本 1', async () => {
      const book = await wallet.publishedPrices();
      expect(book?.version).toBe(1);
      expect(book?.items['llm.out:*']).toMatchObject({
        unit: 'PER_MILLION_TOKENS',
        priceCr: 60_000,
      });
      /* 九个种子项一个不少 */
      expect(Object.keys(book?.items ?? {})).toHaveLength(9);
    });
  });
});
