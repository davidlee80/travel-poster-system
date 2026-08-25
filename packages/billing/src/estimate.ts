import { MAX_DAYS_PER_SEGMENT, maxTokensForDays } from '@tps/llm';
import { optionalInt } from '@tps/shared';

import type { PriceBook } from './price-book.js';
import { priceUsage, type PricedUsage, type UsageSnapshot } from './usage.js';

/**
 * 生成前的估算：**最坏情况上界**，用来判断余额够不够。
 *
 * ## 为什么可以取上界，而不是「平均值 × 系数」
 *
 * 这套系统的成本本来就是有界的，四处硬上限：
 *
 * ```text
 * AI 图      ≤ 3 张/任务          ai-budget.ts 的 MAX_AI_IMAGES_PER_JOB
 * 图搜       ≤ 8 次/任务          search-budget.ts
 * LLM 分段   = ⌈天数 / 7⌉         prompt.ts 的 MAX_DAYS_PER_SEGMENT
 * 重生成     ≤ 2 次               3.2.2，落库时有 CHECK 约束兜着
 * 渲染页     = 1 + 天数           完整版 1 页 + 每日各 1 页
 * ```
 *
 * 取上界的价值：**结算金额一定不超过预留额**，于是不需要处理「扣成负数」
 * 这条分支 —— 而余额有 `>= 0` 的 CHECK，那条分支会让结算事务失败、
 * 任务卡在终态之前，用户的计划生成好了却看不到。
 *
 * ## 输出 token 用分档上限，输入 token 用每天经验值
 *
 * 输出有硬上限（`max_tokens` 按天数分档，`prompt.ts` 的 `MAX_TOKENS_TIERS`），
 * 直接用它。输入没有硬上限 —— 提示词长度取决于约束条数与检索到的参考数量，
 * 而两者都随用户答卷变化。因此输入用「每天多少 token」的经验值乘天数，
 * 放在 env 里可调（`CREDIT_EST_INPUT_TOKENS_PER_DAY`）。
 *
 * 估不准的方向是有意的：宁可预留多了（结算时退还），不可预留少了。
 * 这也是 `holdBufferPercent` 存在的理由。
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

/** 生成任务的报价。`/credits/quote` 与生成端点的预留都用它 */
export function estimateJobCost(input: {
  readonly totalDays: number;
  readonly model: string;
  readonly book: PriceBook;
  readonly limits: JobLimits;
}): JobEstimate {
  const usage = estimateUsage(input.totalDays, input.model, input.limits);
  return { usage, ...priceUsage(usage, input.book, { includeBaseFee: true }) };
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
