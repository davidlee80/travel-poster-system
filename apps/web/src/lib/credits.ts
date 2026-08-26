import type { CreditQuoteResponse, LedgerEntryView } from '@/lib/api-client';

/**
 * CR 在界面上的呈现（C-6）。
 *
 * 纯函数，不碰网络也不碰 React —— 这一层装的全是「用户会读到的那句话」，
 * 而那句话错了没有任何断言会红（金额显示成 0、把「还差多少」算反），
 * 因此它必须能被单测覆盖。
 *
 * ## 产品口径：用户只看 CR，不看次数
 *
 * 次数配额仍然存在（防滥用，见 docs/用户货币与计费.md 第一节），
 * 但它不再作为产品概念展示。装配了计费的部署里，账号面板显示的是 CR；
 * 没装配时退回原来的两个次数 —— 那时 CR 这个概念对用户根本不存在。
 */

/**
 * 流水种类的中文。
 *
 * `WRITE_OFF` 也在表里，但界面**不显示它那一行**（见 `visibleEntries`）：
 * 它记的是我们烧掉的成本，金额恒为 0，对用户是一行读不懂的噪声。
 */
export const LEDGER_KIND_LABEL: Readonly<Record<string, string>> = {
  TOPUP: '充值',
  GRANT: '赠送',
  SPEND: '消费',
  REFUND: '退回',
  WRITE_OFF: '成本记账',
  ADJUST: '调整',
};

export function ledgerKindLabel(kind: string): string {
  /* 未知 kind 原样显示：新增一种流水时界面不该显示「undefined」 */
  return LEDGER_KIND_LABEL[kind] ?? kind;
}

/**
 * 过滤掉不该展示给用户的流水。
 *
 * 只有 `WRITE_OFF`：它是我们自己的成本记账（金额恒 0，真实数字在
 * `metadata` 里而那不下发）。留着的表现是用户在消费明细里看到几行
 * 「成本记账 0」，而他既看不懂也无从判断那是不是错账。
 *
 * 隐藏它不打断「余额自校验」那条链 —— 恒 0 的行不改变任何余额，
 * 那正是迁移 0013 把它约束成 0 的理由之一。
 */
export function visibleEntries(entries: readonly LedgerEntryView[]): readonly LedgerEntryView[] {
  return entries.filter((entry) => entry.kind !== 'WRITE_OFF');
}

/** 带符号的金额文本。方向靠符号本身表达，不靠颜色 */
export function signedCr(amountCr: number): string {
  return `${amountCr > 0 ? '+' : ''}${amountCr} CR`;
}

/** 一笔流水的时间，本地时区、到分钟 */
export function entryTime(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return createdAt;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

export type CreditHintKind = 'hidden' | 'ok' | 'insufficient';

export interface CreditHintView {
  readonly kind: CreditHintKind;
  /** 主句。`kind === 'hidden'` 时为空串 */
  readonly text: string;
  /** 副句（上界与余额）。可能为空串 */
  readonly detail: string;
  /** 还差多少 CR。够的时候是 0 */
  readonly shortfallCr: number;
}

const HIDDEN: CreditHintView = { kind: 'hidden', text: '', detail: '', shortfallCr: 0 };

/**
 * 生成按钮旁那句话。
 *
 * ## 「够不够」用服务端给的 `sufficient`，不自己比
 *
 * 响应里同时有 `hold_cr` 与 `balance_cr`，看起来自己比一下更直接。但那会
 * 造出第二套判断，而两套分叉时的表现是**「按钮说够、提交被拒」**——
 * 用户看到的只有一个 402。`shortfall` 只用于**措辞**（还差多少），
 * 不参与「能不能点」。
 *
 * ## 不计费时什么都不显示
 *
 * `price_version === null` 意味着一版价目表都没发布，这一次生成不收费
 * （见服务端的降级表）。那是我们的配置状态，不是用户要知道的事 ——
 * 显示「本次免费」会让人以为这是一个优惠活动，下次收费时就成了背信。
 */
export function creditHint(quote: CreditQuoteResponse | null): CreditHintView {
  if (quote === null || quote.price_version === null || quote.hold_cr <= 0) return HIDDEN;

  const shortfallCr = Math.max(0, quote.hold_cr - quote.balance_cr);

  if (!quote.sufficient) {
    return {
      kind: 'insufficient',
      text: `余额不足：本次约需 ${quote.hold_cr} CR，还差 ${shortfallCr} CR`,
      detail: `当前余额 ${quote.balance_cr} CR`,
      shortfallCr,
    };
  }

  return {
    kind: 'ok',
    text: `本次预计消耗 ${quote.typical_cr} CR（约 ${quote.typical_cny} 元）`,
    /*
     * 上界一并给出：用户在点之前就知道波动范围。只给「预计」的话，
     * 一次落在上界附近的生成会让他觉得被多扣了钱。
     */
    detail: `最多 ${quote.ceiling_cr} CR，当前余额 ${quote.balance_cr} CR`,
    shortfallCr: 0,
  };
}
