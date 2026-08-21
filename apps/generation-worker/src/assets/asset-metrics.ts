import { FAST_BUCKETS, createCounter, createHistogram } from '@tps/observability';
import { SCORE_ACCEPT_IMMEDIATELY, SCORE_MINIMUM } from '@tps/assets';

/**
 * 素材解析的指标（TP-3-09 的「命中率与分数分布报告」，设计稿 21.3）。
 *
 * 报告不是一次性产物 —— 命中率会随素材库增长而变化，一份跑一次的报告
 * 在灌库之后立刻过期。因此做成指标：Prometheus 里按 `role` 与 `strategy`
 * 就能读出命中率，按分数直方图能读出分布。
 *
 * 标签只用有界小集合（`role` 4 个、`strategy` 7 个、`outcome` 4 个）。
 * `slot_id` 与 `entity_name` 都在 @tps/observability 的禁用名单里 ——
 * 它们属于日志维度。
 */

/**
 * 每个槽位一次解析结局。
 *
 * `strategy` 用 8.1 的枚举值小写；未命中任何来源时为 `none`。
 * 命中率 = `sum by (strategy)` / `sum` —— 这就是 TP-3-09 要的那份报告。
 */
export const assetResolutionTotal = createCounter({
  name: 'travel_asset_resolution_total',
  help: '素材解析结局（按角色、策略、状态）',
  labelNames: ['role', 'strategy', 'outcome'],
});

/**
 * 分数分布。
 *
 * 桶边界压着十章的两个阈值（0.65 可用、0.80 立即采用）布置：
 * 分布集中在 0.65 以下说明素材库覆盖不足（该补素材），
 * 集中在 0.80 以上说明检索工作良好（可以考虑收紧阈值省下 AI 调用）。
 * 用等距桶的话，这两个判断都读不出来。
 */
export const assetMatchScore = createHistogram({
  name: 'travel_asset_match_score',
  help: '素材匹配分数分布（10.1 的 final_score）',
  labelNames: ['role'],
  buckets: [0.2, 0.4, 0.5, 0.6, SCORE_MINIMUM, 0.7, 0.75, SCORE_ACCEPT_IMMEDIATELY, 0.9, 1],
});

/** 21.2：单槽位素材检索 < 800 毫秒。桶边界含 0.8 秒 */
export const assetResolutionDuration = createHistogram({
  name: 'travel_asset_resolution_duration_seconds',
  help: '单槽位素材解析耗时（10.2 的 800 毫秒上限）',
  labelNames: ['role', 'strategy'],
  buckets: [...FAST_BUCKETS],
});

/**
 * 授权图源搜索结局（TP-6-03/06，设计稿 9.6）。
 *
 * 21.3 的指标表里没有这一项 —— V1.7 新增搜索层时需求侧只写了配额与熔断，
 * 没有补指标。补它的理由与 P5 发现的六个指标缺口同一条：**熔断与配额的
 * 效果不可观测就等于没有**。`travel_asset_resolution_total{strategy}` 能看出
 * 有多少槽位走了 `licensed_source_match`，但看不出：
 *
 * ```text
 * skipped        配额/熔断挡掉了多少次（9.6 的三条限制到底有没有生效）
 * timeout        5 秒超时占比（决定要不要下调超时或换图源）
 * rejected       候选被入库门禁丢弃的比例（license 缺失率是选图源的依据）
 * deduplicated   指纹命中率（R-47 的去重收益，也是「搜索是否在重复劳动」）
 * ```
 *
 * 没有 `user_type`：9.6 的搜索额度匿名与注册同额，加这个标签只会把
 * 基数翻倍而没有任何查询会按它分组（与 `travel_ai_image_total` 相反 ——
 * 那里 TP-4-17 的验收断言就是按 `user_type` 表达的）。
 */
export const assetSearchTotal = createCounter({
  name: 'travel_asset_search_total',
  help: '授权图源搜索结局（按角色与结局）',
  labelNames: ['role', 'outcome'],
});

/**
 * AI 图片生成量（21.3 的 `travel_ai_image_total`，TP-4-17 的验证依据）。
 *
 * `user_type` 是 21.3 的 R-13 通用维度，这里是它最重要的用途：
 * 21.4 规定匿名的 AI Hero 额度为 0，而验证方式就是
 * `travel_ai_image_total{user_type="ANONYMOUS"}` 恒为 0（`outcome="generated"`）。
 *
 * `outcome` 的取值：
 * ```text
 * generated      真的调了模型并落库
 * deduplicated   同键并发命中他人产物（13.8 的锁生效，没花钱）
 * skipped        额度耗尽或全局熔断（21.4，没花钱）
 * timeout        20 秒超时（21.2 措施二）
 * rejected       生成物未通过 11.2 后处理（**花了钱**）
 * failed         其余失败
 * ```
 * 把 `skipped` 与 `failed` 分开是必要的：前者是设计行为（成本控制生效），
 * 后者是故障。合成一个的话，「熔断打开」与「供应商挂了」在图上没有区别。
 */
export const aiImageTotal = createCounter({
  name: 'travel_ai_image_total',
  help: 'AI 图片生成结局（按结局、角色、身份类型）',
  labelNames: ['outcome', 'role', 'user_type'],
});

/**
 * 候选模型故障转移的结局（多模型 failover 计划的任务 6）。
 *
 * ## 为什么必须有它
 *
 * 故障转移的作用就是**把主模型的故障掩盖成「慢了一点」**。这正是它的价值，
 * 也正是它的危险：主模型完全挂掉时，`travel_ai_image_total{outcome="generated"}`
 * 一切正常、成功率一切正常，只有 P95 悄悄涨了一截 —— 而涨了多少会被
 * 「本来就有波动」解释掉。`position > 0` 是唯一能把「主模型有问题」
 * 从「今天有点慢」里分出来的信号。
 *
 * `position` 的取值是 `0` / `1` / `2` / `none`（全失败，没有胜出者）。
 * 做成有界字符串而不是直接放位次数字：候选数由运营配置，无上界的话标签基数
 * 也无上界（21.3 禁止无界标签）。超过 2 的位次归到 `2`，因为「第 3 个之后
 * 才成功」与「第 3 个成功」需要的处置是同一个。
 *
 * `kind` 区分图像与文本：两者的候选数与超时完全不同（1～2 个 40 秒 vs
 * 3 个 30 秒），混在一起的话任何按位次的分位数都没有意义。
 *
 * **每条链都记一次**，包括主模型直接胜出。少了那些样本，「备选被用上的
 * 占比」就没有分母 —— 而告警要的正是那个比例。单候选路径不进这个计数器：
 * 装饰器在只有一个候选时原样返回底层客户端，那条路径上不存在「故障转移」。
 */
export const aiFailoverTotal = createCounter({
  name: 'travel_ai_failover_total',
  help: '候选模型故障转移结局（按类别、胜出位次、结局）',
  labelNames: ['kind', 'position', 'outcome'],
});

/**
 * 候选数被时延预算截断的次数（多模型 failover 计划的任务 6）。
 *
 * 配置搬进数据库之后就没有「启动即校验」了：运营可以在系统运行时把
 * `max_candidates` 改成 10，而 `10 × 40 秒` 会突破任务上限。读取处的处置是
 * **截断而不是拒绝**（拒绝会让一次配置失误变成用户拿不到计划），
 * 而截断必须可见 —— 静默截断会让运营以为配置生效了，然后花几天调查
 * 「为什么候选数调上去成功率没变」。
 *
 * 这个计数器就是那件事的唯一信号。它有增长即「配置超出了时延预算」。
 */
export const aiPoolClampedTotal = createCounter({
  name: 'travel_ai_pool_clamped_total',
  help: '候选池的配置候选数被时延预算截断的次数',
  labelNames: ['kind'],
});

/** 把任意位次映射到有界标签值。见 `aiFailoverTotal` 的注释 */
export function failoverPositionLabel(position: number): string {
  if (position < 0) return 'none';
  return position >= 2 ? '2' : String(position);
}

/** 21.2：全部素材解析（14 天）P95 < 25 秒 */
export const assetBatchDuration = createHistogram({
  name: 'travel_asset_batch_duration_seconds',
  help: '一个计划版本的全部素材解析耗时',
  labelNames: ['outcome'],
  buckets: [1, 2, 5, 10, 15, 20, 25, 40, 60, 90],
});
