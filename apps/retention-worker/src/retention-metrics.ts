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
