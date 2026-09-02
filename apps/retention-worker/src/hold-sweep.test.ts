import { InMemoryCreditWalletRepository } from '@tps/db';
import { createSilentLogger } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import { HOLD_SWEEP_BATCH_SIZE, runHoldSweep } from './hold-sweep.js';

/**
 * 过期 CR 预留的回收。
 *
 * 这个功能之前**完全不存在**：迁移 0013 建了 `EXPIRED` 状态与
 * `credit_holds_active_expiry_idx`，`docs/用户货币与计费.md` 与四处代码注释
 * 都写着「由 `expires_at`（2 小时）兜住」，而没有任何代码读过那一列。
 *
 * 因此这里的每条断言都对应一个**曾经真实存在的后果**：
 *   - 不回收 → 用户可用余额永久减少；
 *   - 回收了但没改状态 → 下一轮再退一次，用户白得钱；
 *   - 回收了未过期的 → 正在跑的任务结算时找不到预留，那次生成免费。
 */

const USER = 'user-1';
const HOUR = 60 * 60 * 1_000;

/** `2 小时前就该过期`的预留，以及一个还没到期的 */
async function seed(): Promise<{
  wallet: InMemoryCreditWalletRepository;
  now: Date;
}> {
  const wallet = new InMemoryCreditWalletRepository();
  const now = new Date('2026-09-02T12:00:00Z');

  await wallet.credit({
    userId: USER,
    amountCr: 10_000,
    kind: 'GRANT',
    idempotencyKey: 'grant-1',
  });

  // 已过期 1 小时
  await wallet.reserve({
    userId: USER,
    jobId: 'job-expired',
    amountCr: 300,
    priceVersion: 1,
    expiresAt: new Date(now.getTime() - HOUR),
  });
  // 还有 1 小时才到期
  await wallet.reserve({
    userId: USER,
    jobId: 'job-active',
    amountCr: 500,
    priceVersion: 1,
    expiresAt: new Date(now.getTime() + HOUR),
  });

  return { wallet, now };
}

describe('过期预留回收', () => {
  it('把过期预留退回可用余额，未到期的不动', async () => {
    const { wallet, now } = await seed();

    /* 预留后：可用 10000 - 300 - 500 = 9200，冻结 800 */
    expect(await wallet.balance(USER)).toEqual({ balanceCr: 9_200, heldCr: 800 });

    const result = await runHoldSweep({
      wallet,
      logger: createSilentLogger(),
      now: () => now,
    });

    expect(result).toEqual({ expired: 1, refundedCr: 300 });
    /*
     * 只有 300 回来。500 那笔仍然冻着 —— 误回收它的后果是那个任务
     * 结算时找不到预留，于是那次生成完全免费。
     */
    expect(await wallet.balance(USER)).toEqual({ balanceCr: 9_500, heldCr: 500 });
  });

  it('回收后状态转 EXPIRED，第二轮不会重复退款', async () => {
    const { wallet, now } = await seed();

    await runHoldSweep({ wallet, logger: createSilentLogger(), now: () => now });
    const afterFirst = await wallet.balance(USER);

    /*
     * 再跑一轮。不改状态的话这里会再退 300 —— 而那是凭空生钱，
     * 且让「流水求和 = 余额」这条自校验失效。
     */
    const second = await runHoldSweep({ wallet, logger: createSilentLogger(), now: () => now });

    expect(second).toEqual({ expired: 0, refundedCr: 0 });
    expect(await wallet.balance(USER)).toEqual(afterFirst);
  });

  it('回收写一条 REFUND 流水，并标明原因是 HOLD_EXPIRED', async () => {
    const { wallet, now } = await seed();
    await runHoldSweep({ wallet, logger: createSilentLogger(), now: () => now });

    const entries = await wallet.history({ userId: USER, limit: 10 });
    const refund = entries.find((entry) => entry.kind === 'REFUND');

    expect(refund?.amountCr).toBe(300);
    expect(refund?.refId).toBe('job-expired');
    /*
     * `reason` 区分三种退款：任务失败（JOB_FAILED）、用户取消、预留过期。
     * 没有它的话，「为什么这笔钱退了」在客诉时无法回答 ——
     * 而过期退款意味着那次生成没经过正常结算，值得查因。
     */
    expect(refund?.metadata).toMatchObject({ reason: 'HOLD_EXPIRED' });
  });

  it('过期后又结算的任务不会被扣第二次', async () => {
    const { wallet, now } = await seed();
    await runHoldSweep({ wallet, logger: createSilentLogger(), now: () => now });
    const afterSweep = await wallet.balance(USER);

    /*
     * Worker 迟到的结算。`settle` 见到状态不是 ACTIVE 就走重放分支 ——
     * 这条断言守的是「回收与结算竞争」的安全性：代价是那次生成免费，
     * 而那正是 HOLD_TTL_MS 取 2 小时（远大于任务 300 秒上限）的理由。
     */
    const settled = await wallet.settle({
      jobId: 'job-expired',
      actualCr: 280,
      lines: [],
      unpriced: [],
    });

    expect(settled.replayed).toBe(true);
    expect(settled.chargedCr).toBe(0);
    expect(await wallet.balance(USER)).toEqual(afterSweep);
  });

  it('受 limit 约束，按到期时间升序（最旧的先清）', async () => {
    const wallet = new InMemoryCreditWalletRepository();
    const now = new Date('2026-09-02T12:00:00Z');
    await wallet.credit({
      userId: USER,
      amountCr: 10_000,
      kind: 'GRANT',
      idempotencyKey: 'grant-1',
    });

    /* 三笔都过期，到期时间递增 */
    for (const [index, hoursAgo] of [3, 2, 1].entries()) {
      await wallet.reserve({
        userId: USER,
        jobId: `job-${index}`,
        amountCr: 100,
        priceVersion: 1,
        expiresAt: new Date(now.getTime() - hoursAgo * HOUR),
      });
    }

    const result = await runHoldSweep({
      wallet,
      logger: createSilentLogger(),
      batchSize: 2,
      now: () => now,
    });

    expect(result.expired).toBe(2);
    /* 最旧的两笔（3 小时前、2 小时前）先清，剩 1 笔留到下一轮 */
    expect(await wallet.balance(USER)).toEqual({ balanceCr: 9_900, heldCr: 100 });
  });

  it('没有过期预留时安静返回，不抛错', async () => {
    const wallet = new InMemoryCreditWalletRepository();
    const result = await runHoldSweep({ wallet, logger: createSilentLogger() });
    expect(result).toEqual({ expired: 0, refundedCr: 0 });
  });

  it('overdueSeconds 反映已过期多久（用于判断周期是否太稀）', async () => {
    const wallet = new InMemoryCreditWalletRepository();
    const now = new Date('2026-09-02T12:00:00Z');
    await wallet.credit({
      userId: USER,
      amountCr: 1_000,
      kind: 'GRANT',
      idempotencyKey: 'grant-1',
    });
    await wallet.reserve({
      userId: USER,
      jobId: 'job-1',
      amountCr: 100,
      priceVersion: 1,
      expiresAt: new Date(now.getTime() - 90 * 60 * 1_000),
    });

    const outcomes = await wallet.expireHolds({ limit: 10, now });
    expect(outcomes[0]?.overdueSeconds).toBe(90 * 60);
  });

  it('默认批量是 200', () => {
    // 改动它会影响一轮时长，而停机要 await 当前这一轮
    expect(HOLD_SWEEP_BATCH_SIZE).toBe(200);
  });
});
