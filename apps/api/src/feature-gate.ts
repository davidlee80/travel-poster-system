import { createCounter } from '@tps/observability';
import type { FeatureFlags } from '@tps/shared';

/**
 * 灰度开关的共享部分（TP-5-10）。
 *
 * 放在 routes 之外：两个端点（13.1 生成、13.5 导出）都要用，
 * 而把它放进其中一个再由另一个 import 会让「导出依赖生成的路由模块」——
 * 那是一条没有理由的依赖边。
 */

/**
 * 未装配开关时的缺省。
 *
 * 全开而不是全关：未配置开关的部署（本地开发、P2～P4 时期的测试、
 * 以及任何不走 Helm 的运行方式）不该因此拒绝服务。
 * 反过来默认全关的话，忘记配开关的表现是「整个产品 503」——
 * 而那种故障在灰度机制引入之前是不存在的，排查时没人会想到去看开关。
 */
export const ALL_FEATURES_ON: FeatureFlags = {
  generationEnabled: true,
  exportEnabled: true,
  generationRolloutPercent: 100,
  /*
   * P7：这一项**不**跟着「全开」—— 名字里的 ALL_ON 指的是灰度开关，
   * 而匿名入口是产品已决定关闭的功能，不属于「未配置就该照旧」那一类。
   *
   * 让它在这里为 true 的后果很具体：任何用这个常量兜底的部署（本地开发、
   * 不走 Helm 的运行方式）都会重新开放匿名注册，而那与 loadFeatureFlags
   * 的默认值相反 —— 两个「默认」不一致是最难查的一类配置问题。
   */
  anonymousEnabled: false,
};

/**
 * 灰度拦截计数（TP-5-10）。
 *
 * 这个指标是放量期间**唯一**能回答「有多少用户被挡住了」的东西。
 * 没有它的话，放量 30% 与「功能挂了」在监控上的区别只有「503 的绝对数量」，
 * 而那个数量同时受流量波动影响。
 *
 * `reason_code` 区分 `disabled`（全局关闭，是运维动作）与 `not_in_rollout`
 * （不在这批放量里，是预期行为）—— 合成一个的话，放量期间的正常拒绝
 * 会和一次误操作关闭混在同一条曲线上。
 */
export const featureGateTotal = createCounter({
  name: 'travel_feature_gate_total',
  help: '被灰度开关拦下的请求（按功能与原因）',
  labelNames: ['event', 'reason_code'],
});
