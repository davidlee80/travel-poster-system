import { InMemoryCreditWalletRepository, samplePriceBook } from '@tps/db';
import { createSilentLogger } from '@tps/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { createExportBilling, type ExportBilling } from './billing.js';

/**
 * 导出失败的退款（C-4b）。
 *
 * 最要紧的一条是**退的数**：导出的扣费发生在 API 收到请求那一刻，而渲染
 * 可能在几秒后失败。现算一遍（按当前价目）在调价窗口内会退错数 ——
 * 少退是我们赖账，多退是可以被反复触发的漏洞。
 */

const EXPORT_ID = 'export-1';
const USER = 'user-1';

describe('createExportBilling', () => {
  let wallet: InMemoryCreditWalletRepository;
  let billing: ExportBilling;

  beforeEach(() => {
    wallet = new InMemoryCreditWalletRepository();
    wallet.seed(USER, 1_000);
    billing = createExportBilling({ wallet, logger: createSilentLogger() });
  });

  async function charge(amountCr: number, priceVersion = 7): Promise<void> {
    const result = await wallet.charge({
      userId: USER,
      amountCr,
      idempotencyKey: `export:key-${amountCr}`,
      refType: 'EXPORT',
      refId: EXPORT_ID,
      priceVersion,
    });
    expect(result.ok).toBe(true);
  }

  it('退回当时实际扣的那个数', async () => {
    await charge(50);
    expect((await wallet.balance(USER)).balanceCr).toBe(950);

    await billing.refundFailed(EXPORT_ID);

    expect((await wallet.balance(USER)).balanceCr).toBe(1_000);
    const kinds = (await wallet.history({ userId: USER, limit: 10 })).map((entry) => entry.kind);
    expect(kinds).toContain('REFUND');
  });

  it('调价之后退的仍然是原价，而不是新价', async () => {
    /*
     * 这条是整个模块存在的理由。用「当前价目现算」的实现会在这里退 500 ——
     * 而用户当时被扣的是 50。
     */
    await charge(50, 7);

    /* 运营把 export.png 从 50 调到 500 并发布成版本 8，此刻这次导出渲染失败 */
    wallet.priceBook = samplePriceBook({
      version: 8,
      items: { 'export.png': { sku: 'export.png', unit: 'PER_ITEM', priceCr: 500 } },
    });
    await billing.refundFailed(EXPORT_ID);

    expect((await wallet.balance(USER)).balanceCr).toBe(1_000);
    const refund = (await wallet.history({ userId: USER, limit: 10 })).find(
      (entry) => entry.kind === 'REFUND',
    );
    expect(refund?.amountCr).toBe(50);
  });

  it('重复调用只退一次', async () => {
    /* 队列重投、人工重放都会让它跑第二次 */
    await charge(50);
    await billing.refundFailed(EXPORT_ID);
    await billing.refundFailed(EXPORT_ID);

    expect((await wallet.balance(USER)).balanceCr).toBe(1_000);
    const refunds = (await wallet.history({ userId: USER, limit: 10 })).filter(
      (entry) => entry.kind === 'REFUND',
    );
    expect(refunds).toHaveLength(1);
  });

  it('没扣过费时什么都不做（计费当时关着、或那一项没有价目）', async () => {
    await billing.refundFailed(EXPORT_ID);

    expect((await wallet.balance(USER)).balanceCr).toBe(1_000);
    expect(await wallet.history({ userId: USER, limit: 10 })).toHaveLength(0);
  });

  it('只退这一次导出的那笔，不会退到别的导出上', async () => {
    await charge(50);
    await wallet.charge({
      userId: USER,
      amountCr: 80,
      idempotencyKey: 'export:other',
      refType: 'EXPORT',
      refId: 'export-2',
      priceVersion: 7,
    });

    await billing.refundFailed(EXPORT_ID);

    /* 1000 - 50 - 80 + 50 = 920 */
    expect((await wallet.balance(USER)).balanceCr).toBe(920);
  });

  it('退款失败不抛错 —— 导出的结局已经写死了', async () => {
    /*
     * `exports` 行此刻已经是 FAILED，用户看到的是一次明确的失败。
     * 抛错只会让 BullMQ 再消费一次，而那一次因为状态已非 QUEUED 会直接跳过
     * —— 什么也修不了。
     */
    await charge(50);
    wallet.refund = () => Promise.reject(new Error('数据库抖了一下'));

    await expect(billing.refundFailed(EXPORT_ID)).resolves.toBeUndefined();
  });
});
