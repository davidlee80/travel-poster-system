import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadCreditConfig, holdAmount } from './credits.js';
import { estimateJobCost } from './estimate.js';
import { DEFAULT_JOB_LIMITS } from './estimate.js';
import {
  DEV_PRICE_VERSION,
  SKU_FALLBACK_MODEL,
  type BillingUnit,
  type PriceBook,
} from './price-book.js';

/**
 * 迁移 0014 的开发期定价是否**真的能跑通**。
 *
 * ## 为什么这一组要读 SQL 而不是抄一份数字
 *
 * 那九个数只存在于迁移文件里（迁移只前向、带校验和，不可改）。在测试里
 * 抄一份的话，两边会漂移 —— 而漂移的方向恰好是最坏的：**测试说能跑通，
 * 库里那一版跑不通**。因此这里解析 SQL 的 `VALUES` 块。
 *
 * ## 它钉住的是什么
 *
 * 0013 的占位价与注册赠送额（9900 CR）不兼容：占位价下一次 14 天行程要冻
 * 10578 CR，也就是刚注册的用户点「生成 14 天」直接拿到 402。那不是缺陷，
 * 而是「两个互不相干的占位数凑在一起」的必然结果。
 *
 * 0014 存在的全部理由就是给出一组**核对过**的数，判据只有一条：
 *
 * > **连 14 天的最坏上界都要落在注册赠送额之内。**
 *
 * 只保证「典型值不超」是不够的 —— 那会让「重生成两次」这条路径变成一个
 * 只在特定条件下出现的 402，而它恰恰最难复现。
 */

const SQL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../infrastructure/migrations/0014_dev_prices.sql',
);

/** 0013 已经登记了单位，0014 只改价格 —— 因此单位在这里按 SKU 名推 */
function unitOf(sku: string): BillingUnit {
  if (sku.includes(':')) return 'PER_MILLION_TOKENS';
  return sku === 'plan.base_fee' ? 'PER_JOB' : 'PER_ITEM';
}

/**
 * 从迁移的 `VALUES` 块里读出九项定价。
 *
 * 只认 `('<sku>', <数字>` 这一种形态（`::BIGINT` 后缀可选），因此把 `DO $$`
 * 里那份校验清单也一并匹配上了 —— 用 Map 去重后仍是九项，
 * 而两份不一致时那份多出来的条目会让下面的「九项」断言直接红。
 */
function devPriceBook(): PriceBook {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const items: Record<string, { sku: string; unit: BillingUnit; priceCr: number }> = {};

  for (const match of sql.matchAll(/\('([a-z._:*]+)',\s*(\d+)/g)) {
    const sku = match[1]!;
    const priceCr = Number(match[2]);
    const existing = items[sku];
    if (existing !== undefined && existing.priceCr !== priceCr) {
      throw new Error(`0014 里 ${sku} 出现了两个不同的价格：${existing.priceCr} 与 ${priceCr}`);
    }
    items[sku] = { sku, unit: unitOf(sku), priceCr };
  }

  return { version: DEV_PRICE_VERSION, publishedAt: '2026-01-01T00:00:00.000Z', items };
}

describe('迁移 0014 的开发期定价', () => {
  const book = devPriceBook();
  const config = loadCreditConfig();

  it('九项一项不少，且都是正数', () => {
    /*
     * 少一项的表现是那个 SKU 仍按 0013 的占位价计费 —— 没有任何迹象。
     * 价格为 0 的表现更隐蔽：那一项完全免费，而告警看不到（0 不是缺价目）。
     */
    expect(Object.keys(book.items).sort()).toEqual([
      'embedding.in:*',
      'export.pdf',
      'export.png',
      'image.ai_generate',
      'image.search',
      'llm.in:*',
      'llm.out:*',
      'plan.base_fee',
      'render.page',
    ]);
    for (const item of Object.values(book.items)) {
      expect(item.priceCr, item.sku).toBeGreaterThan(0);
    }
  });

  it('连 14 天的最坏上界都落在注册赠送额之内', () => {
    /*
     * **这是 0014 存在的理由。** 不成立的话，一个刚注册的用户在某些天数 +
     * 重生成组合下会拿到 402，而那是「新用户第一次使用就被拒」——
     * 最贵的一种失败。
     */
    for (let days = 1; days <= 14; days += 1) {
      const quote = estimateJobCost({
        totalDays: days,
        model: SKU_FALLBACK_MODEL,
        book,
        limits: DEFAULT_JOB_LIMITS,
      });
      expect(
        quote.ceiling.totalCr,
        `${days} 天的最坏上界 ${quote.ceiling.totalCr} CR 超过赠送额 ${config.signupGrantCr} CR`,
      ).toBeLessThanOrEqual(config.signupGrantCr);
    }
  });

  it('赠送额至少够买三次 14 天行程（留出重试与导出的余量）', () => {
    /*
     * 上界不超只保证「不会被拒」。而一个刚注册的用户如果只够生成一次，
     * 他试错一次就没了 —— 开发期尤其需要能反复跑。
     */
    const quote = estimateJobCost({
      totalDays: 14,
      model: SKU_FALLBACK_MODEL,
      book,
      limits: DEFAULT_JOB_LIMITS,
    });
    const hold = holdAmount(quote.typical.totalCr, config);
    expect(Math.floor(config.signupGrantCr / hold)).toBeGreaterThanOrEqual(3);
  });

  it('每一项都真的进了报价（没有哪一项白配）', () => {
    /*
     * 反向检查：一个 SKU 配了价却没有任何调用方会命中它，说明打点漏了。
     * 判据是「把它的价格调成 0，报价必须变小」。
     */
    const quoteWith = (items: PriceBook['items']): number =>
      estimateJobCost({
        totalDays: 14,
        model: SKU_FALLBACK_MODEL,
        book: { ...book, items },
        limits: DEFAULT_JOB_LIMITS,
      }).ceiling.totalCr;

    const full = quoteWith(book.items);
    /* 导出那两项不进生成报价 —— 它们由 estimateExportCost 单独算 */
    const inJobQuote = Object.keys(book.items).filter((sku) => !sku.startsWith('export.'));

    for (const sku of inJobQuote) {
      const zeroed = {
        ...book.items,
        [sku]: { ...book.items[sku]!, priceCr: 0 },
      };
      expect(quoteWith(zeroed), `${sku} 配了价但报价里没有它`).toBeLessThan(full);
    }
  });
});
