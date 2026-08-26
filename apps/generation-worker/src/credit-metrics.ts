import { FIXED_SKUS, MODEL_SKU_PREFIXES } from '@tps/billing';
import { createCounter } from '@tps/observability';

/**
 * CR 计费的指标（C-7，21.3 的补充项）。
 *
 * ## 为什么必须有这两条
 *
 * 到 C-6 为止，坏账、兜底价命中、结算金额**全都只在日志里**。而这三件事的
 * 共同点是：出问题时没有任何东西会失败 ——
 *
 * ```text
 * 坏账     用户照样拿到计划，任务照样 COMPLETED，只是钱我们出了
 * 兜底价   那个模型照一个偏贵的价收，用户不会来问，运营也不知道自己漏配了
 * 结算     金额算错（少收）时一切正常，直到某天对账
 * ```
 *
 * 日志能查，但**查的前提是先怀疑**。指标让它们出现在图上。
 *
 * ## 为什么这两条属于 generation-worker 而不是 api
 *
 * 结算与坏账只发生在 worker（api 只做预留，那时还不知道花了多少）；
 * 兜底价命中也只在 worker —— api 报价统一按兜底 SKU `:*` 算，
 * 那是**精确命中**而不是回落（见 CreditsService 的说明）。
 *
 * api 侧的闸门决策另有一个 `travel_credit_gate_total`。
 */

/**
 * 结算流向的 CR 金额。
 *
 * `direction` 三个取值各回答一个问题：
 *
 * ```text
 * charged    收了多少（rate 即收入速率）
 * refunded   退了多少（预留多退 + 任务失败全退）
 * write_off  我们自己吃掉多少 —— 这一条是坏账告警的数据源
 * ```
 *
 * 用一个 counter 带标签而不是三个 counter：三者恒同时出现在结算那一刻，
 * 分开会让「这一笔的三个数」在查询时要 join 三个指标名。
 *
 * **单位是 CR 而不是次数。** 「发生了 10 次坏账」不说明任何事 ——
 * 10 次 1 CR 与 10 次 10000 CR 是完全不同的两件事，而告警要判的是后者。
 */
export const creditSettledCrTotal = createCounter({
  name: 'travel_credit_settled_cr_total',
  help: 'CR 结算金额（按流向：收取 / 退回 / 坏账）',
  labelNames: ['direction'],
});

/**
 * 没有登记单价的 SKU 命中次数。
 *
 * 两种情形都记在这里，因为处置完全相同（去把价格配上）：
 *   - 命中兜底价 `:*` —— 按一个偏贵的价收了，用户不受影响；
 *   - 连兜底都没有 —— **没收钱**。
 *
 * ## 标签是 `domain` 而不是完整 SKU
 *
 * 完整 SKU 形如 `llm.in:<model>`，而 model 那一段是**供应商回给我们的**
 * （`LlmResult.model`，故障转移下是真正出活的那个候选）。有些供应商会返回
 * 带日期的版本名，那个集合会随时间慢慢长 —— 而 21.3 的标签白名单只收
 * 「取值集合由代码封闭」的东西。
 *
 * `domain` 取 `:` 之前那一段，落在 `FIXED_SKUS` ∪ `MODEL_SKU_PREFIXES` ∪
 * `other` 里，十个取值封顶。**具体是哪个模型在日志里**
 * （`billing.ts` 打了 `sku` 字段）—— 告警要回答的是「有没有漏配」，
 * 而「漏配了哪一个」是随后一次 grep 的事。
 */
export const creditUnpricedTotal = createCounter({
  name: 'travel_credit_unpriced_total',
  help: '没有登记单价的 SKU 命中次数（走兜底价或被跳过），按 SKU 域',
  labelNames: ['domain'],
});

/** 已知的域。`other` 兜住将来新增而这里忘了更新的 SKU —— 它让基数封顶 */
const KNOWN_DOMAINS: ReadonlySet<string> = new Set<string>([...FIXED_SKUS, ...MODEL_SKU_PREFIXES]);

/**
 * `llm.in:gpt-x` → `llm.in`；`export.png` → `export.png`。
 *
 * 未知的一律归到 `other`：不归并的话，一个拼错的 SKU 就能凭空长出一条序列，
 * 而这条指标的全部意义是「有没有漏配」，多一条序列答不了更多东西。
 */
export function skuDomain(sku: string): string {
  const colon = sku.indexOf(':');
  const domain = colon < 0 ? sku : sku.slice(0, colon);
  return KNOWN_DOMAINS.has(domain) ? domain : 'other';
}
