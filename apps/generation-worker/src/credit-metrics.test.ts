import { FIXED_SKUS, MODEL_SKU_PREFIXES } from '@tps/billing';
import { describe, expect, it } from 'vitest';

import { skuDomain } from './credit-metrics.js';

/**
 * `travel_credit_unpriced_total` 的标签归并（C-7）。
 *
 * 这个函数的全部职责是**让基数封顶**。它错了的后果不是「数字不对」，
 * 而是 Prometheus 长出一条按模型名（供应商回给我们的，含版本日期）
 * 无限增长的序列 —— 而高基数标签打爆 Prometheus 是不可逆的生产事故
 * （内存暴涨 → 抓取超时 → 监控盲区，恰好在最需要监控的时候）。
 */

describe('skuDomain', () => {
  it('模型 SKU 归并到前缀 —— 模型名不进标签', () => {
    expect(skuDomain('llm.in:gpt-x')).toBe('llm.in');
    expect(skuDomain('llm.out:claude-3-5-sonnet-20241022')).toBe('llm.out');
    expect(skuDomain('embedding.in:text-embedding-3')).toBe('embedding.in');
    /* 兜底变体也归并：`:*` 与具体模型对这条指标是同一件事 */
    expect(skuDomain('llm.in:*')).toBe('llm.in');
  });

  it('固定 SKU 原样保留（它们本身就是封闭集合）', () => {
    for (const sku of FIXED_SKUS) {
      expect(skuDomain(sku)).toBe(sku);
    }
  });

  it('未知的一律归到 other', () => {
    /*
     * 不归并的话，一个拼错的 SKU 就能凭空长出一条序列。
     * 而这条指标的全部意义是「有没有漏配」，多一条序列答不了更多东西。
     */
    expect(skuDomain('something.new:x')).toBe('other');
    expect(skuDomain('typo.base_fee')).toBe('other');
    expect(skuDomain('')).toBe('other');
  });

  it('取值集合封顶在「固定 SKU + 模型前缀 + other」', () => {
    /*
     * 这条断言钉住的是**基数上界**本身。将来加一个 SKU 域时它不会红
     * （新域会落到 other），但删掉归并逻辑会 —— 而那正是要拦的那次改动。
     */
    const possible = new Set([...FIXED_SKUS, ...MODEL_SKU_PREFIXES, 'other']);
    const samples = ['llm.in:a', 'llm.out:b', 'embedding.in:c', ...FIXED_SKUS, 'garbage', 'a:b:c'];
    for (const sample of samples) {
      expect(possible.has(skuDomain(sample)), `${sample} → ${skuDomain(sample)}`).toBe(true);
    }
    expect(possible.size).toBe(10);
  });
});
