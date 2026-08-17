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

/** 21.2：全部素材解析（14 天）P95 < 25 秒 */
export const assetBatchDuration = createHistogram({
  name: 'travel_asset_batch_duration_seconds',
  help: '一个计划版本的全部素材解析耗时',
  labelNames: ['outcome'],
  buckets: [1, 2, 5, 10, 15, 20, 25, 40, 60, 90],
});
