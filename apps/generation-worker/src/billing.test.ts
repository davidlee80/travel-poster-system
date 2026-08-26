import { EMPTY_USAGE, type UsageSnapshot } from '@tps/billing';
import { InMemoryCreditWalletRepository, samplePriceBook } from '@tps/db';
import { createSilentLogger } from '@tps/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { createJobBilling, type JobBilling } from './billing.js';

/**
 * 生成任务的 CR 结算（C-4）。
 *
 * 钱包的原子性与幂等在 `@tps/db` 的集成测试里（真库）。这里测的是**口径**：
 * 按哪一版价目算、服务费收不收、没有预留时收不收。三者都属于「算错了不会
 * 报错，只会收错钱」的那一类。
 */

const JOB = 'job-1';
const USER = 'user-1';

/** 一次典型任务的用量：两次模型调用 + 1 张 AI 图 + 2 次图搜 + 6 页 */
const USAGE: UsageSnapshot = {
  llmInputTokens: { 'gpt-x': 20_000 },
  llmOutputTokens: { 'gpt-x': 8_000 },
  embeddingTokens: {},
  aiImages: 1,
  imageSearches: 2,
  renderPages: 6,
};

describe('createJobBilling', () => {
  let wallet: InMemoryCreditWalletRepository;
  let billing: JobBilling;

  beforeEach(() => {
    wallet = new InMemoryCreditWalletRepository();
    wallet.priceBook = samplePriceBook();
    billing = createJobBilling({
      wallet,
      logger: createSilentLogger(),
      /* 缓存关掉：这一组用例要改价目表并立刻看到效果 */
      priceCacheMs: 0,
    });
  });

  async function reserve(amountCr: number, priceVersion = 7): Promise<void> {
    wallet.seed(USER, 100_000);
    const result = await wallet.reserve({
      userId: USER,
      jobId: JOB,
      amountCr,
      priceVersion,
      expiresAt: new Date('2026-04-01T12:00:00Z'),
    });
    expect(result.ok).toBe(true);
  }

  it('成功结算：按用量扣，差额退回，冻结归零', async () => {
    await reserve(5_000);
    await billing.settle({ jobId: JOB, usage: USAGE });

    /*
     * 100 (base_fee) + 300 (llm.in 20K × 15000/M) + 480 (llm.out 8K × 60000/M)
     * + 200 (1 张 AI 图) + 20 (2 次图搜) + 120 (6 页) = 1220
     */
    const spend = (await wallet.history({ userId: USER, limit: 10 })).find(
      (entry) => entry.kind === 'SPEND',
    );
    expect(spend?.amountCr).toBe(-1_220);
    expect(await wallet.balance(USER)).toEqual({ balanceCr: 100_000 - 1_220, heldCr: 0 });
  });

  it('结算收服务费，坏账不收 —— 服务费是收入项，不是烧掉的成本', async () => {
    await reserve(5_000);
    const priced = await billing.priceOf({ jobId: JOB, usage: EMPTY_USAGE });
    /* 空用量下差额就是 `plan.base_fee` */
    expect(priced?.totalCr).toBe(0);

    await billing.settle({ jobId: JOB, usage: EMPTY_USAGE });
    const spend = (await wallet.history({ userId: USER, limit: 10 })).find(
      (entry) => entry.kind === 'SPEND',
    );
    expect(spend?.amountCr).toBe(-100);
  });

  it('失败释放：预留全额退，坏账按不含服务费的成本记', async () => {
    await reserve(5_000);
    await billing.release({ jobId: JOB, usage: USAGE });

    /* 用户一分钱没花 */
    expect(await wallet.balance(USER)).toEqual({ balanceCr: 100_000, heldCr: 0 });
    const entries = await wallet.history({ userId: USER, limit: 10 });
    expect(entries.find((entry) => entry.kind === 'REFUND')?.amountCr).toBe(5_000);
    expect(entries.some((entry) => entry.kind === 'WRITE_OFF')).toBe(true);
  });

  it('按预留锁定的价目版本算钱，不按当前发布版', async () => {
    /*
     * 「已提交的任务不受调价影响」这条承诺就落在这里。用当前版结算的话，
     * 运营在任务在途时调价会让用户按他提交时看不到的价格被扣 ——
     * 而他不会来提工单，只会觉得这个产品贵。
     */
    await reserve(5_000, 7);
    /* 运营在任务在途时发布了版本 9，版本 7 已经查不到 */
    wallet.priceBook = samplePriceBook({ version: 9 });

    await billing.settle({ jobId: JOB, usage: USAGE });

    /*
     * 算不出钱就按 0 结，**但预留照常释放**。
     *
     * 只是「不结算」的话预留会一直挂着，钱冻到两小时后过期 ——
     * 而根因只是一张查不到的价目表。少收一笔远好于把钱卡住。
     */
    const spend = (await wallet.history({ userId: USER, limit: 10 })).find(
      (entry) => entry.kind === 'SPEND',
    );
    expect(spend?.amountCr).toBe(0);
    expect(await wallet.balance(USER)).toEqual({ balanceCr: 100_000, heldCr: 0 });
  });

  it('价目版本查不到时，失败释放照样把钱退回去', async () => {
    await reserve(5_000, 7);
    wallet.priceBook = null;

    await billing.release({ jobId: JOB, usage: USAGE });

    expect(await wallet.balance(USER)).toEqual({ balanceCr: 100_000, heldCr: 0 });
    /* 坏账按 0 → 不写 WRITE_OFF（那一条恒 0，写了也读不出金额） */
    const kinds = (await wallet.history({ userId: USER, limit: 10 })).map((entry) => entry.kind);
    expect(kinds).toContain('REFUND');
    expect(kinds).not.toContain('WRITE_OFF');
  });

  it('没有预留时不结算（0013 之前入队、或当时计费还关着）', async () => {
    wallet.seed(USER, 100_000);
    await billing.settle({ jobId: JOB, usage: USAGE });

    expect(await wallet.balance(USER)).toEqual({ balanceCr: 100_000, heldCr: 0 });
    expect(await wallet.history({ userId: USER, limit: 10 })).toHaveLength(0);
  });

  it('缺价目的 SKU 不收费但不影响其余项', async () => {
    /* 只登记服务费，其余 SKU 全缺 */
    wallet.priceBook = samplePriceBook({
      items: { 'plan.base_fee': { sku: 'plan.base_fee', unit: 'PER_JOB', priceCr: 100 } },
    });
    await reserve(5_000);

    await billing.settle({ jobId: JOB, usage: USAGE });
    const spend = (await wallet.history({ userId: USER, limit: 10 })).find(
      (entry) => entry.kind === 'SPEND',
    );
    expect(spend?.amountCr).toBe(-100);
  });

  it('重复结算不重复扣（任务重投必然走到这里）', async () => {
    await reserve(5_000);
    await billing.settle({ jobId: JOB, usage: USAGE });
    await billing.settle({ jobId: JOB, usage: USAGE });

    const spends = (await wallet.history({ userId: USER, limit: 10 })).filter(
      (entry) => entry.kind === 'SPEND',
    );
    expect(spends).toHaveLength(1);
  });
});
