import { describe, expect, it } from 'vitest';

import {
  assertCreditConfig,
  cnyToCredits,
  creditsToCnyText,
  holdAmount,
  type CreditConfig,
} from './credits.js';
import {
  amountFor,
  modelSku,
  priceOf,
  SKU_FALLBACK_MODEL,
  type PriceBook,
  type PriceItem,
} from './price-book.js';
import { DEFAULT_JOB_LIMITS, estimateExportCost, estimateJobCost } from './estimate.js';
import { UsageMeter, priceUsage } from './usage.js';

/**
 * 货币系统的算术与定价。
 *
 * 这一层全是纯函数，因此边界能被穷尽覆盖 —— 而边界正是钱最容易出问题的地方：
 * 舍入方向、缺价目、未登记模型、上界估算。
 */

const CONFIG: CreditConfig = { crPerCny: 1_000, signupGrantCr: 9_900, holdBufferPercent: 120 };

function item(sku: string, unit: PriceItem['unit'], priceCr: number): PriceItem {
  return { sku, unit, priceCr };
}

/** 一份最小可用价目表。数值取整便于手算 */
const BOOK: PriceBook = {
  version: 1,
  publishedAt: '2026-08-25T00:00:00.000Z',
  items: Object.fromEntries(
    [
      item('plan.base_fee', 'PER_JOB', 100),
      item('llm.in:gpt-x', 'PER_MILLION_TOKENS', 10_000),
      item('llm.out:gpt-x', 'PER_MILLION_TOKENS', 30_000),
      item(`llm.in:${SKU_FALLBACK_MODEL}`, 'PER_MILLION_TOKENS', 20_000),
      item(`llm.out:${SKU_FALLBACK_MODEL}`, 'PER_MILLION_TOKENS', 60_000),
      item('embedding.in:*', 'PER_MILLION_TOKENS', 200),
      item('image.ai_generate', 'PER_ITEM', 300),
      item('image.search', 'PER_ITEM', 20),
      item('render.page', 'PER_ITEM', 5),
      item('export.png', 'PER_ITEM', 30),
      item('export.pdf', 'PER_ITEM', 50),
    ].map((entry) => [entry.sku, entry]),
  ),
};

describe('人民币与 CR 的兑换', () => {
  it('9.9 元 = 9900 CR', () => {
    expect(cnyToCredits(9.9, CONFIG)).toBe(9_900);
  });

  it('非整数结果向下取整 —— 非整数余额会让后续整数运算失去前提', () => {
    expect(cnyToCredits(0.0009, CONFIG)).toBe(0);
    expect(cnyToCredits(1.0004, CONFIG)).toBe(1_000);
  });

  it('CR 转人民币只用于展示，返回字符串', () => {
    expect(creditsToCnyText(9_900, CONFIG)).toBe('9.90');
    /* 返回字符串而不是数字：拿 9.9 去做加法正是本模块要避免的事 */
    expect(typeof creditsToCnyText(1, CONFIG)).toBe('string');
  });

  it('预留额按 buffer 放大并向上取整', () => {
    expect(holdAmount(1_000, CONFIG)).toBe(1_200);
    expect(holdAmount(1, CONFIG)).toBe(2);
    expect(holdAmount(0, CONFIG)).toBe(0);
  });
});

describe('货币配置的不变式', () => {
  it('buffer 低于 100 被拒 —— 那等于让结算超出预留', () => {
    expect(() => assertCreditConfig({ ...CONFIG, holdBufferPercent: 99 })).toThrow(
      /CREDIT_HOLD_BUFFER_PERCENT/,
    );
  });

  it('兑换比率必须为正', () => {
    expect(() => assertCreditConfig({ ...CONFIG, crPerCny: 0 })).toThrow(/CREDIT_CR_PER_CNY/);
  });

  it('赠送额度可以为 0（不赠送），但不能为负', () => {
    expect(() => assertCreditConfig({ ...CONFIG, signupGrantCr: 0 })).not.toThrow();
    expect(() => assertCreditConfig({ ...CONFIG, signupGrantCr: -1 })).toThrow(/GRANT/);
  });
});

describe('单价查找与兜底', () => {
  it('登记过的模型走自己的价', () => {
    const hit = priceOf(BOOK, modelSku('llm.in', 'gpt-x'));
    expect(hit?.item.priceCr).toBe(10_000);
    expect(hit?.missing).toBeNull();
  });

  it('未登记的模型走兜底价，并报出原本要找的 SKU', () => {
    /*
     * 这是运营往模型池里加模型、忘了登记价格的情形 —— 那两件事在不同的表、
     * 由不同的命令完成，所以一定会发生。
     */
    const hit = priceOf(BOOK, modelSku('llm.in', 'brand-new-model'));
    expect(hit?.item.priceCr).toBe(20_000);
    expect(hit?.missing).toBe('llm.in:brand-new-model');
  });

  it('固定 SKU 没有兜底 —— 它没有「变体」这个概念', () => {
    expect(priceOf(BOOK, 'render.page')?.missing).toBeNull();
    expect(priceOf(BOOK, 'nonexistent.thing')).toBeNull();
  });
});

describe('用量 × 单价', () => {
  it('token 按每百万计，向上取整', () => {
    const price = item('llm.in:x', 'PER_MILLION_TOKENS', 10_000);
    expect(amountFor(price, 1_000_000)).toBe(10_000);
    expect(amountFor(price, 20_000)).toBe(200);
    /*
     * 向上取整：向下会让一个 50 token 的调用恒为 0 CR，
     * 于是把一次生成拆成很多次短调用就能免费。
     */
    expect(amountFor(price, 1)).toBe(1);
    expect(amountFor(price, 0)).toBe(0);
  });

  it('每任务项与用量无关，给多少都收一份', () => {
    const price = item('plan.base_fee', 'PER_JOB', 100);
    expect(amountFor(price, 1)).toBe(100);
    expect(amountFor(price, 5)).toBe(100);
    expect(amountFor(price, 0)).toBe(0);
  });
});

describe('累加器', () => {
  it('同一模型的多次调用累加，输入输出分开', () => {
    const meter = new UsageMeter();
    meter.addLlm('gpt-x', 1_000, 500);
    meter.addLlm('gpt-x', 2_000, 800);
    meter.addLlm('gpt-y', 300, 100);
    const usage = meter.snapshot();
    expect(usage.llmInputTokens).toEqual({ 'gpt-x': 3_000, 'gpt-y': 300 });
    expect(usage.llmOutputTokens).toEqual({ 'gpt-x': 1_300, 'gpt-y': 100 });
  });

  it('非正数不计入 —— 失败调用的 token 可能是 0 或缺失', () => {
    const meter = new UsageMeter();
    meter.addLlm('gpt-x', 0, 0);
    meter.addAiImages(0);
    meter.addImageSearches(-1);
    expect(meter.snapshot()).toMatchObject({
      llmInputTokens: {},
      aiImages: 0,
      imageSearches: 0,
    });
  });
});

describe('结算定价', () => {
  it('逐项计费并合计', () => {
    const meter = new UsageMeter();
    meter.addLlm('gpt-x', 20_000, 8_000);
    meter.addAiImages(2);
    meter.addImageSearches(3);
    meter.addRenderPages(4);
    const priced = priceUsage(meter.snapshot(), BOOK, { includeBaseFee: true });

    /* 100 + ceil(20000×10000/1e6)=200 + ceil(8000×30000/1e6)=240 + 600 + 60 + 20 */
    expect(priced.totalCr).toBe(100 + 200 + 240 + 600 + 60 + 20);
    expect(priced.unpriced).toEqual([]);
  });

  it('不带服务费时导出路径可复用 —— 否则同一份计划会反复付服务费', () => {
    const meter = new UsageMeter();
    meter.addRenderPages(1);
    expect(priceUsage(meter.snapshot(), BOOK, {}).totalCr).toBe(5);
  });

  it('未登记的模型按兜底价收，并把它报进 unpriced（去重）', () => {
    const meter = new UsageMeter();
    meter.addLlm('mystery', 1_000_000, 1_000_000);
    const priced = priceUsage(meter.snapshot(), BOOK, {});
    expect(priced.totalCr).toBe(20_000 + 60_000);
    /* in / out 各命中一次兜底，去重后只报一个模型 */
    expect(priced.unpriced).toEqual(['llm.in:mystery', 'llm.out:mystery']);
  });

  it('连兜底都没有时不收费但报出来 —— 弄丢产物比少收一笔严重得多', () => {
    const thin: PriceBook = { ...BOOK, items: { 'render.page': item('render.page', 'PER_ITEM', 5) } };
    const meter = new UsageMeter();
    meter.addLlm('gpt-x', 1_000, 1_000);
    meter.addRenderPages(2);
    const priced = priceUsage(meter.snapshot(), thin, {});
    expect(priced.totalCr).toBe(10);
    expect(priced.unpriced).toEqual(['llm.in:gpt-x', 'llm.out:gpt-x']);
  });
});

describe('生成前的估算', () => {
  it('天数越多估得越贵', () => {
    const quote = (totalDays: number): number =>
      estimateJobCost({ totalDays, model: 'gpt-x', book: BOOK, limits: DEFAULT_JOB_LIMITS })
        .totalCr;
    expect(quote(3)).toBeLessThan(quote(7));
    expect(quote(7)).toBeLessThan(quote(14));
  });

  it('超过 7 天分段，因此 8 天明显贵于 7 天', () => {
    /*
     * `MAX_DAYS_PER_SEGMENT = 7`：8 天要分两段，输出 token 上限翻倍。
     * 这条断言盯的是估算真的用了分段逻辑，而不是简单地按天数线性缩放。
     */
    const seven = estimateJobCost({
      totalDays: 7,
      model: 'gpt-x',
      book: BOOK,
      limits: DEFAULT_JOB_LIMITS,
    }).totalCr;
    const eight = estimateJobCost({
      totalDays: 8,
      model: 'gpt-x',
      book: BOOK,
      limits: DEFAULT_JOB_LIMITS,
    }).totalCr;
    expect(eight).toBeGreaterThan(seven * 1.5);
  });

  it('估算含全部四类成本，一项都不漏', () => {
    const skus = estimateJobCost({
      totalDays: 5,
      model: 'gpt-x',
      book: BOOK,
      limits: DEFAULT_JOB_LIMITS,
    }).lines.map((line) => line.sku);
    expect(skus).toEqual([
      'plan.base_fee',
      'llm.in:gpt-x',
      'llm.out:gpt-x',
      'embedding.in:gpt-x',
      'image.ai_generate',
      'image.search',
      'render.page',
    ]);
  });

  it('估算是上界：真实用量的结算金额不会超过它', () => {
    /*
     * 这是整套设计能不处理「扣成负数」那条分支的前提。构造一份**顶到各处硬上限**
     * 的真实用量，它的结算金额必须 <= 估算金额。
     */
    const totalDays = 5;
    const estimate = estimateJobCost({
      totalDays,
      model: 'gpt-x',
      book: BOOK,
      limits: DEFAULT_JOB_LIMITS,
    });

    const meter = new UsageMeter();
    /* 分段数 × (1 + 重生成) 次调用，每次输出都顶到分档上限 */
    const attempts = Math.ceil(totalDays / 7) * (1 + DEFAULT_JOB_LIMITS.maxRegenerations);
    for (let i = 0; i < attempts; i += 1) {
      meter.addLlm('gpt-x', totalDays * DEFAULT_JOB_LIMITS.estInputTokensPerDay, 16_384);
    }
    meter.addEmbedding('gpt-x', 1_000);
    meter.addAiImages(DEFAULT_JOB_LIMITS.maxAiImagesPerJob);
    meter.addImageSearches(DEFAULT_JOB_LIMITS.maxImageSearchesPerJob);
    meter.addRenderPages(1 + totalDays);

    const actual = priceUsage(meter.snapshot(), BOOK, { includeBaseFee: true });
    expect(actual.totalCr).toBeLessThanOrEqual(estimate.totalCr);
  });
});

describe('导出报价', () => {
  it('按格式取固定价', () => {
    expect(estimateExportCost('PNG', BOOK).totalCr).toBe(30);
    expect(estimateExportCost('PDF', BOOK).totalCr).toBe(50);
  });

  it('缺价目时不收费但报出来', () => {
    const thin: PriceBook = { ...BOOK, items: {} };
    const priced = estimateExportCost('PDF', thin);
    expect(priced.totalCr).toBe(0);
    expect(priced.unpriced).toEqual(['export.pdf']);
  });
});
