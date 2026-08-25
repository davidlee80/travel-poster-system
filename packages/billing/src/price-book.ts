/**
 * 价目表：从「供应商用量」到 CR 的兑换关系。
 *
 * 这就是需求里那个「大模型 token 与我们自己的货币的兑换关系」——
 * 它不是一个全局系数，而是**每个计费项一个单价**，因为不同模型的
 * 输入/输出单价能差一个数量级，而 AI 图与 token 根本不是同一个量纲。
 *
 * ## 为什么价目表在数据库里而不在 env
 *
 * 调价是运营操作，且必须可回放：某份计划是**按哪一版价格**结算的，
 * 三个月后对账时要能答得出来。env 改一次就丢失了历史，而
 * `credit_ledger.price_version` 指回具体版本才让这个问题有答案。
 * 形态照 `planner_config_*`（迁移 0010～0012）：版本化 + 单一发布版 + clone/publish。
 *
 * ## 毛利倍率不在代码里
 *
 * `price_cr` 是**售价**，运营定它的时候已经把供应商成本与毛利算进去了。
 * 代码里再乘一个 `markup` 会造出第二个真相源 —— 而两处不一致时，
 * 「我们到底按什么价卖」这个问题没有答案。
 */

/** 计费单位。决定 `price_cr` 怎么乘用量 */
export const BILLING_UNITS = ['PER_MILLION_TOKENS', 'PER_ITEM', 'PER_JOB'] as const;
export type BillingUnit = (typeof BILLING_UNITS)[number];

/**
 * 与模型无关的固定 SKU。
 *
 * 写成字面量元组而不是自由字符串：这几项在代码里有明确的打点位置，
 * 拼错一个的表现是「那一项永远按兜底价 0 计费」，也就是静默免费。
 */
export const FIXED_SKUS = [
  'plan.base_fee',
  'image.ai_generate',
  'image.search',
  'render.page',
  'export.png',
  'export.pdf',
] as const;
export type FixedSku = (typeof FIXED_SKUS)[number];

/**
 * 按模型分档的 SKU 前缀。实际 SKU 是 `<前缀>:<model>`。
 *
 * 不把模型名做成枚举：`model_pools` 允许运营随时加模型（迁移 0009 的整个用意），
 * 而枚举意味着加一个模型要发一次版。
 */
export const MODEL_SKU_PREFIXES = ['llm.in', 'llm.out', 'embedding.in'] as const;
export type ModelSkuPrefix = (typeof MODEL_SKU_PREFIXES)[number];

/** 未登记模型时的兜底变体。见 `priceOf` */
export const SKU_FALLBACK_MODEL = '*';

/**
 * 迁移 0013 种下的那一版价目表的版本号。
 *
 * 那一版的价格**全是占位值**，是为了让系统在没有运营配置时也能跑通，
 * 而不是真实定价。用「版本号等于 1」当判据而不是匹配 `note` 里的「占位」字样：
 * 后者一改文案就失效，而运营发布版本 2 时这条告警自然消失。
 *
 * `isSeedPriceBook` 的调用方（api / worker 启动时）应打一条 warn 日志与指标 ——
 * 带着占位价上线的表现不是报错，是收错钱，而收错钱要到对账时才发现。
 */
export const SEED_PRICE_VERSION = 1;

export function isSeedPriceBook(book: PriceBook): boolean {
  return book.version === SEED_PRICE_VERSION;
}

export function modelSku(prefix: ModelSkuPrefix, model: string): string {
  return `${prefix}:${model}`;
}

export interface PriceItem {
  readonly sku: string;
  readonly unit: BillingUnit;
  readonly priceCr: number;
}

export interface PriceBook {
  readonly version: number;
  readonly publishedAt: string;
  readonly items: Readonly<Record<string, PriceItem>>;
}

/**
 * 取一个 SKU 的单价，未登记的模型回落到 `*`。
 *
 * ## 为什么必须有兜底，而兜底又必须可观测
 *
 * 运营往模型池里加一个模型、忘了登记价格，这件事一定会发生 ——
 * 那两件事在不同的表、由不同的命令完成。此时：
 *
 *   没有兜底        → 结算抛错 → 任务卡在终态之前 → 用户的计划生成不出来
 *   兜底按 0        → 那个模型的调用**完全免费**，而没有任何人会发现
 *   兜底按 `*` 价   → 按一个保守（偏贵）的价收，同时打一条指标
 *
 * 只有第三条既不影响用户，又能被发现。`missing` 是给调用方打指标用的 ——
 * 返回它而不是在这里打点，是为了让这个模块保持纯函数（可单测、无副作用）。
 */
export interface PriceLookup {
  readonly item: PriceItem;
  /** 命中了兜底价时是原本要找的那个 SKU；正常命中时为 null */
  readonly missing: string | null;
}

export function priceOf(book: PriceBook, sku: string): PriceLookup | null {
  const exact = book.items[sku];
  if (exact !== undefined) return { item: exact, missing: null };

  /* 只有 `<前缀>:<model>` 形态有兜底；固定 SKU 没有「变体」的概念 */
  const colon = sku.lastIndexOf(':');
  if (colon <= 0) return null;

  const fallback = book.items[`${sku.slice(0, colon)}:${SKU_FALLBACK_MODEL}`];
  return fallback === undefined ? null : { item: fallback, missing: sku };
}

/**
 * 用量 × 单价 → CR。
 *
 * 向**上**取整。理由与 `cnyToCredits` 的向下取整相反，而两者是同一条原则：
 * 舍入永远朝「不亏」的方向。单次调用因此最多多收 1 CR（0.001 元），
 * 而向下取整会让一个 500 token 的短调用恒为 0 CR —— 于是把一次生成拆成
 * 很多次短调用就能免费。
 */
export function amountFor(item: PriceItem, quantity: number): number {
  if (quantity <= 0) return 0;
  switch (item.unit) {
    case 'PER_MILLION_TOKENS':
      return Math.ceil((quantity * item.priceCr) / 1_000_000);
    case 'PER_ITEM':
      return Math.ceil(quantity * item.priceCr);
    case 'PER_JOB':
      /* 每任务一次，用量只有 0 或 1；给 3 也只收一份 */
      return item.priceCr;
    default: {
      const exhaustive: never = item.unit;
      return exhaustive;
    }
  }
}
