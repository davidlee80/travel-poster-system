import {
  amountFor,
  modelSku,
  priceOf,
  type PriceBook,
  type ModelSkuPrefix,
} from './price-book.js';

/**
 * 一次任务的真实用量，以及它到 CR 的换算。
 *
 * ## 为什么按模型聚合，而不是逐次调用留一条
 *
 * 一个 14 天的任务会发出「分段数 × (1 + 重生成次数)」次调用，故障转移还可能
 * 让每次落在不同模型上。逐次留存的价值只在排查，而排查已经有
 * `travel_llm_tokens_total{model,purpose,direction}` 指标与结构化日志。
 * 结算只需要「每个模型各用了多少 token」——聚合让流水里的 `metadata`
 * 保持在几十字节而不是几 KB。
 *
 * ## 失败的调用不计费
 *
 * 打点挂在 `recordLlmCall` 判定 `outcome === 'succeeded'` 之后。
 * 这沿用 `ai-budget.ts` 已有的那条假设：「供应商侧的失败请求多数不计费」。
 * 假设错了的代价是我们少收一点；反过来（把失败也收）会让一次上游故障
 * 变成用户账单上的一笔莫名支出。
 */

export interface UsageSnapshot {
  /** model → token 数。分输入与输出，因为两者单价不同 */
  readonly llmInputTokens: Readonly<Record<string, number>>;
  readonly llmOutputTokens: Readonly<Record<string, number>>;
  readonly embeddingTokens: Readonly<Record<string, number>>;
  readonly aiImages: number;
  readonly imageSearches: number;
  readonly renderPages: number;
}

export const EMPTY_USAGE: UsageSnapshot = {
  llmInputTokens: {},
  llmOutputTokens: {},
  embeddingTokens: {},
  aiImages: 0,
  imageSearches: 0,
  renderPages: 0,
};

/**
 * 可变累加器，每个任务一个实例。
 *
 * 与 `AiBudget` / `SearchBudget` 同一形态（每任务实例、进程内、不落库）——
 * 那两个类的注释里写明了共享实例的后果是「第 2 个任务开始计数从没被重置过」，
 * 同一个坑在这里的表现是「用户被收了别人的钱」。
 */
export class UsageMeter {
  private readonly llmIn = new Map<string, number>();
  private readonly llmOut = new Map<string, number>();
  private readonly embedding = new Map<string, number>();
  private aiImages = 0;
  private imageSearches = 0;
  private renderPages = 0;

  private static bump(target: Map<string, number>, key: string, amount: number): void {
    if (amount <= 0) return;
    target.set(key, (target.get(key) ?? 0) + amount);
  }

  addLlm(model: string, inputTokens: number, outputTokens: number): void {
    UsageMeter.bump(this.llmIn, model, inputTokens);
    UsageMeter.bump(this.llmOut, model, outputTokens);
  }

  addEmbedding(model: string, tokens: number): void {
    UsageMeter.bump(this.embedding, model, tokens);
  }

  addAiImages(count = 1): void {
    if (count > 0) this.aiImages += count;
  }

  addImageSearches(count = 1): void {
    if (count > 0) this.imageSearches += count;
  }

  addRenderPages(count: number): void {
    if (count > 0) this.renderPages += count;
  }

  snapshot(): UsageSnapshot {
    return {
      llmInputTokens: Object.fromEntries(this.llmIn),
      llmOutputTokens: Object.fromEntries(this.llmOut),
      embeddingTokens: Object.fromEntries(this.embedding),
      aiImages: this.aiImages,
      imageSearches: this.imageSearches,
      renderPages: this.renderPages,
    };
  }
}

// ── 定价 ────────────────────────────────────────────────────

export interface PricedLine {
  readonly sku: string;
  readonly quantity: number;
  readonly amountCr: number;
}

export interface PricedUsage {
  readonly totalCr: number;
  readonly lines: readonly PricedLine[];
  /**
   * 没有登记单价、走了兜底或被跳过的 SKU。
   *
   * 调用方据此打 `travel_credit_unpriced_total`。返回而不是在这里打点：
   * 这一层是纯函数，而纯函数才能在单测里覆盖「缺价目」这种分支 ——
   * 那正是最容易在生产上第一次被发现的分支。
   */
  readonly unpriced: readonly string[];
}

interface Accumulator {
  readonly lines: PricedLine[];
  readonly unpriced: string[];
  total: number;
}

function charge(acc: Accumulator, book: PriceBook, sku: string, quantity: number): void {
  if (quantity <= 0) return;

  const lookup = priceOf(book, sku);
  if (lookup === null) {
    /*
     * 连兜底都没有：**不收费**，但记进 `unpriced`。
     *
     * 抛错是另一种选择，而它的后果更糟：结算发生在任务终态，抛错会让任务
     * 卡在 SAVING_PLAN 之后、COMPLETED 之前 —— 用户的计划已经生成好了，
     * 却因为一条价目缺失而永远看不到。少收一笔钱远好于弄丢一份产物。
     */
    acc.unpriced.push(sku);
    return;
  }

  if (lookup.missing !== null) acc.unpriced.push(lookup.missing);

  const amountCr = amountFor(lookup.item, quantity);
  acc.lines.push({ sku, quantity, amountCr });
  acc.total += amountCr;
}

function chargeByModel(
  acc: Accumulator,
  book: PriceBook,
  prefix: ModelSkuPrefix,
  tokensByModel: Readonly<Record<string, number>>,
): void {
  /* 按模型名排序，让同一份用量恒产出同一份流水 —— 便于比对与快照测试 */
  for (const model of Object.keys(tokensByModel).sort()) {
    charge(acc, book, modelSku(prefix, model), tokensByModel[model] ?? 0);
  }
}

/**
 * 用量 → 应扣 CR。
 *
 * `includeBaseFee` 让导出路径复用这个函数而不带上「每任务服务费」——
 * 导出不是一个生成任务，收一次 `plan.base_fee` 会让用户为同一份计划
 * 反复付服务费。
 */
export function priceUsage(
  usage: UsageSnapshot,
  book: PriceBook,
  options: { readonly includeBaseFee?: boolean } = {},
): PricedUsage {
  const acc: Accumulator = { lines: [], unpriced: [], total: 0 };

  if (options.includeBaseFee === true) charge(acc, book, 'plan.base_fee', 1);

  chargeByModel(acc, book, 'llm.in', usage.llmInputTokens);
  chargeByModel(acc, book, 'llm.out', usage.llmOutputTokens);
  chargeByModel(acc, book, 'embedding.in', usage.embeddingTokens);
  charge(acc, book, 'image.ai_generate', usage.aiImages);
  charge(acc, book, 'image.search', usage.imageSearches);
  charge(acc, book, 'render.page', usage.renderPages);

  return {
    totalCr: acc.total,
    lines: acc.lines,
    /* 去重：同一个未登记模型会在 in / out 两处各命中一次 */
    unpriced: [...new Set(acc.unpriced)],
  };
}
