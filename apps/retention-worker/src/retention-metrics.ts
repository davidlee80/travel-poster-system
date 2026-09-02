import { createCounter, createGauge } from '@tps/observability';

/**
 * 保留期清理的指标（TP-4-24，设计稿 21.3、15.1）。
 *
 * 15.1 要求「删除前发出 `travel_anon_purge_total` 指标」。这条指标的用途
 * 不是运营看板，而是**合规证据**：匿名数据的保留承诺是对用户的承诺，
 * 而「清理任务到底有没有在跑」只能靠它回答 —— 一个悄悄挂掉的定时任务
 * 不会有任何其他症状（磁盘慢慢变大，而那要几个月才明显）。
 */
export const anonPurgeTotal = createCounter({
  name: 'travel_anon_purge_total',
  help: '到期匿名用户的清理结局（15.1）',
  labelNames: ['outcome'],
});

/**
 * `plan_knowledge` 行数（21.3）。
 *
 * Gauge 而不是 Counter：它要回答「知识库累积到多少了」，
 * 而 Counter 只能回答「一共转存过多少次」（进程重启即归零，
 * 且无法反映因故被删除的行）。
 *
 * 这个数字同时是 TP-4-22/23 的健康信号：它应当**单调增长**。
 * 长期不动说明清理任务没在跑，或者到期用户的计划都没有向量
 * （那意味着嵌入服务一直在失败）。
 */
export const knowledgeRows = createGauge({
  name: 'travel_knowledge_rows',
  help: 'plan_knowledge 行数（15.1 的知识转存累积量）',
});

/**
 * 过期 CR 预留的回收结局。
 *
 * `outcome` 取 `expired`（真的退了一笔）与 `failed`（那一轮报错）。
 *
 * ## 它恒为 0 有两种相反的解释
 *
 * 「没有预留泄漏」与「清理器根本没在跑」在这条曲线上长得一模一样，
 * 而后者正是这个功能之前的状态 —— 它被文档承诺了却从未存在。
 * 因此告警必须用 `absent()` 盯「指标在不在」，而不是盯它的值；
 * 同理，清理器每转一圈都要把 `expired` 那一维至少初始化为 0，
 * 否则序列在第一笔泄漏发生前根本不存在。
 */
export const creditHoldExpiredTotal = createCounter({
  name: 'travel_credit_hold_expired_total',
  help: '过期 CR 预留的回收结局（未结算的预留会永久冻住用户余额）',
  labelNames: ['outcome'],
});
