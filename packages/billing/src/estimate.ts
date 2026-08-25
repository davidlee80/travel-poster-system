import { MAX_DAYS_PER_SEGMENT, maxTokensForDays } from '@tps/llm';
import { optionalInt } from '@tps/shared';

import type { PriceBook } from './price-book.js';
import { priceUsage, type PricedUsage, type UsageSnapshot } from './usage.js';

/**
 * 生成前的估算。产出**两个**数：预留用的典型值，与展示用的最坏上界。
 *
 * ## 为什么不能拿上界当预留额
 *
 * 上界含「最多 2 次重生成」这条路径，而它是 2～2.7 倍于典型值的
 * （实测：5 天 2475 → 5041 CR，14 天 8815 → 23971 CR）。拿它当预留额的后果是
 * **用户的余额必须够覆盖一个几乎不会发生的最坏情况** —— 9.9 元连一次 14 天
 * 行程都买不了，而那一次的实际花费大约 8.8 元。产品形态直接失效。
 *
 * 因此：
 *
 *   预留 = 典型值（0 次重生成）× `holdBufferPercent`
 *   结算超出预留时，从余额继续扣；余额不足则扣到 0，差额记 `WRITE_OFF` 由我们承担
 *
 * 让我们承担而不是让用户欠账或让任务失败：超出预留是**我们估算不准**，
 * 而另两种做法一个要向用户解释他看不懂的负余额、一个要丢掉已经生成好的计划。
 * 恶意用户拿最低余额反复触发高成本任务这条路，由保留下来的次数配额挡住
 * （每分钟 3 次 + 日/月上限）—— 这正是那两层不删掉的价值。
 *
 * ## 上界仍然有用
 *
 * 报价端点两个数都返回，前端显示「预计 ~2.5 元，最多 5.0 元」——
 * 用户在点之前就知道波动范围。余额连上界都不够时可以提前提示，
 * 而不是等到结算才发现要吃坏账。
 *
 * ## 各处硬上限
 *
 * ```text
 * AI 图      ≤ 3 张/任务          ai-budget.ts 的 MAX_AI_IMAGES_PER_JOB
 * 图搜       ≤ 8 次/任务          search-budget.ts
 * LLM 分段   = ⌈天数 / 7⌉         prompt.ts 的 MAX_DAYS_PER_SEGMENT
 * 重生成     ≤ 2 次               3.2.2，落库时有 CHECK 约束兜着
 * 渲染页     = 1 + 天数           完整版 1 页 + 每日各 1 页
 * ```
 *
 * 输出 token 用分档上限（`MAX_TOKENS_TIERS`，有硬上限）；输入 token 没有硬上限
 * —— 提示词长度取决于约束条数与检索到的参考数量，两者都随用户答卷变化 ——
 * 因此用「每天多少 token」的经验值乘天数，env 可调。
 */

export interface JobLimits {
  readonly maxAiImagesPerJob: number;
  readonly maxImageSearchesPerJob: number;
  readonly maxRegenerations: number;
  readonly estInputTokensPerDay: number;
}

/**
 * 默认值与 worker 里那几个常量一一对应。
 *
 * **它们必须相等**，由 `apps/generation-worker` 的测试断言 —— 那里是唯一
 * 同时能 import 到两边的地方。不相等的后果：估得比实际上限低，预留不足，
 * 结算把余额扣成负数，事务失败，任务卡住。
 *
 * 为什么不直接 import worker 的常量：那是一个 app，包不能依赖 app。
 * 把常量搬进包是另一种解法，但那要动 `ai-budget.ts` 与 `search-budget.ts`
 * 的公开面，而它们正被别的在途改动碰着。
 */
export const DEFAULT_JOB_LIMITS: JobLimits = {
  maxAiImagesPerJob: 3,
  maxImageSearchesPerJob: 8,
  maxRegenerations: 2,
  estInputTokensPerDay: 3_000,
};

export function loadJobLimits(): JobLimits {
  return {
    maxAiImagesPerJob: optionalInt(
      'CREDIT_EST_MAX_AI_IMAGES',
      DEFAULT_JOB_LIMITS.maxAiImagesPerJob,
    ),
    maxImageSearchesPerJob: optionalInt(
      'CREDIT_EST_MAX_IMAGE_SEARCHES',
      DEFAULT_JOB_LIMITS.maxImageSearchesPerJob,
    ),
    maxRegenerations: optionalInt(
      'CREDIT_EST_MAX_REGENERATIONS',
      DEFAULT_JOB_LIMITS.maxRegenerations,
    ),
    estInputTokensPerDay: optionalInt(
      'CREDIT_EST_INPUT_TOKENS_PER_DAY',
      DEFAULT_JOB_LIMITS.estInputTokensPerDay,
    ),
  };
}

/**
 * 一次生成任务的最坏用量。
 *
 * `model` 参数是**将要用的首选模型**。故障转移可能落到别的模型上，而池里
 * 后面的候选通常更便宜（运营配池的常见做法是「贵而好的放前面」）——
 * 因此按首选模型估算是偏保守的一侧。真要遇到「后面的候选更贵」，
 * `holdBufferPercent` 兜住。
 */
export function estimateUsage(
  totalDays: number,
  model: string,
  limits: JobLimits,
): UsageSnapshot {
  const segments = Math.max(1, Math.ceil(totalDays / MAX_DAYS_PER_SEGMENT));
  /*
   * `1 + maxRegenerations`：一次成功 + 最多两次重生成。重生成重跑的是整份
   * 计划（不是单段），因此乘在分段数之外。
   */
  const attempts = segments * (1 + limits.maxRegenerations);

  return {
    llmInputTokens: { [model]: attempts * totalDays * limits.estInputTokensPerDay },
    llmOutputTokens: { [model]: attempts * maxTokensForDays(totalDays) },
    /* 嵌入只在落库前算一次，且文本是脱敏投影（几百 token 量级） */
    embeddingTokens: { [model]: 1_000 },
    aiImages: limits.maxAiImagesPerJob,
    imageSearches: limits.maxImageSearchesPerJob,
    /* 完整版 1 页 + 每日各 1 页 */
    renderPages: 1 + totalDays,
  };
}

export interface JobEstimate extends PricedUsage {
  readonly usage: UsageSnapshot;
}

export interface JobQuote {
  /** 预留基数：典型用量（0 次重生成）的定价 */
  readonly typical: JobEstimate;
  /** 最坏上界：含最多重生成。只用于展示与提前警告，**不进预留** */
  readonly ceiling: JobEstimate;
}

function priced(
  totalDays: number,
  model: string,
  book: PriceBook,
  limits: JobLimits,
): JobEstimate {
  const usage = estimateUsage(totalDays, model, limits);
  return { usage, ...priceUsage(usage, book, { includeBaseFee: true }) };
}

/**
 * 生成任务的报价。`/credits/quote` 与生成端点的预留都用它。
 *
 * 预留取 `typical.totalCr`（再经 `holdAmount` 放大），展示取两者。
 */
export function estimateJobCost(input: {
  readonly totalDays: number;
  readonly model: string;
  readonly book: PriceBook;
  readonly limits: JobLimits;
}): JobQuote {
  const { totalDays, model, book, limits } = input;
  return {
    /*
     * 典型 = 同一套上界逻辑，只把重生成次数按 0 算。
     *
     * 复用而不是另写一份「典型用量」函数：两份估算会各自演化，而它们必须
     * 逐项对应（少算一项的表现是预留恒少那一项的钱，长期就是一笔坏账）。
     */
    typical: priced(totalDays, model, book, { ...limits, maxRegenerations: 0 }),
    ceiling: priced(totalDays, model, book, limits),
  };
}

/**
 * 导出的报价。
 *
 * 定价固定且与内容无关（几秒 Chromium CPU + 存储），因此没有用量估算这一步 ——
 * 直接查那一个 SKU。这也是导出走「请求时一次原子扣减」而不是预留/结算往返的理由。
 *
 * 缺价目时返回 0 并记进 `unpriced`，与 `priceUsage` 同一取舍：
 * 少收一笔远好于让用户导不出已经生成好的计划。
 */
export function estimateExportCost(format: 'PNG' | 'PDF', book: PriceBook): PricedUsage {
  const sku = format === 'PDF' ? 'export.pdf' : 'export.png';
  const item = book.items[sku];
  if (item === undefined) return { totalCr: 0, lines: [], unpriced: [sku] };
  return {
    totalCr: item.priceCr,
    lines: [{ sku, quantity: 1, amountCr: item.priceCr }],
    unpriced: [],
  };
}
