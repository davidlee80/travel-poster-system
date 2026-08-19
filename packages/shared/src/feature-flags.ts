import { createHash } from 'node:crypto';

import { optionalBool, optionalInt } from './config.js';

/**
 * 功能开关与百分比放量（TP-5-10）。
 *
 * ## 为什么放量判定必须是稳定哈希，不能是随机数
 *
 * 放量 30% 时用 `Math.random() < 0.3`，同一个用户刷新页面就会在「能用」与
 * 「维护中」之间来回跳 —— 而他会以为是自己网络的问题，或者反复重试直到撞上
 * 那 30%。灰度的意义是「一部分用户完整地体验新功能」，不是「每次请求有 30%
 * 的概率成功」。
 *
 * 因此按 `user_id` 的稳定哈希分桶：同一个用户永远落在同一个桶里，
 * 放量比例从 30% 提到 50% 时，原来那 30% 的用户仍然在范围内（桶号不变）。
 *
 * ## 一处固有限制
 *
 * 匿名用户清一次 Cookie 就是一个新 `user_id`，因此会换桶。这不是缺陷 ——
 * 匿名身份本来就没有跨设备/跨清理的连续性（3.6）。但它意味着灰度期间
 * 匿名用户的体验可能不一致，而这是选择「匿名可直接生成」时接受的代价。
 */

export interface FeatureFlags {
  /** 关闭时 13.1 返回维护提示，不入队 */
  readonly generationEnabled: boolean;
  /**
   * 关闭时 13.5 返回维护提示。
   *
   * 与生成分开是因为两者的成本量级差三个数量级：导出只花 Chromium 的几秒 CPU，
   * 生成要花模型调用的钱。因此紧急降成本时先关生成、保留导出 ——
   * 用户至少还能把已有的计划导出带走。
   */
  readonly exportEnabled: boolean;
  /** 0～100。生成功能的放量比例 */
  readonly generationRolloutPercent: number;
  /**
   * 匿名身份入口（P7）。**默认 `false`**。
   *
   * 关闭时：不自动创建匿名号、已有的 `tp_anon` 凭据一律不解析 ——
   * 前端来的一切请求都必须是注册用户（见 `IdentityService.resolve`）。
   *
   * ## 默认值与其余三项相反，这是有意的
   *
   * 那三个是「正常开着，紧急时关」，因此默认 `true`：忘记配的表现应当是
   * 「和引入灰度之前一样」。而这一个是**产品已经决定关闭**的功能，
   * 默认 `true` 会让任何漏配的部署静默重新开放匿名注册 ——
   * 而那是一次产品行为的回退，不是一次可观测的故障：没有任何告警会响，
   * 只有转化数据在几周后变得可疑。
   *
   * ## 不走 `decideFeature`
   *
   * 那个函数按 `user_id` 分桶做百分比放量，而匿名判定发生在**身份存在
   * 之前** —— 没有 `user_id` 可用。混进去会迫使调用方编一个假 ID，
   * 而那个假 ID 会进分桶哈希，把放量分布也一起搞乱。
   *
   * 匿名入口也不该有「放量比例」：一半的访客能匿名生成、另一半必须注册，
   * 是一种没人想要的产品形态。
   */
  readonly anonymousEnabled: boolean;
}

export function loadFeatureFlags(): FeatureFlags {
  const percent = optionalInt('FEATURE_GENERATION_ROLLOUT_PERCENT', 100);

  /*
   * 越界即拒绝启动，而不是钳到 [0,100]。
   *
   * 钳的话，把 `1000` 误写进 values 的人会得到「全量放量」而他以为自己配的是
   * 千分比 —— 那是一次静默的全量上线。而 `-1` 会被钳成 0，表现是「新功能
   * 一个用户都没有」，同样静默。
   */
  if (percent < 0 || percent > 100) {
    throw new Error(
      `FEATURE_GENERATION_ROLLOUT_PERCENT 必须在 0～100 之间，当前为 ${percent}。` +
        '它是百分比而不是千分比或比例。',
    );
  }

  return {
    generationEnabled: optionalBool('FEATURE_GENERATION_ENABLED', true),
    exportEnabled: optionalBool('FEATURE_EXPORT_ENABLED', true),
    generationRolloutPercent: percent,
    // 默认 false —— 与上面两个相反的理由见 FeatureFlags.anonymousEnabled
    anonymousEnabled: optionalBool('FEATURE_ANONYMOUS_ENABLED', false),
  };
}

/**
 * 该用户是否在放量范围内。
 *
 * `percent = 100` 时恒为 true、`0` 时恒为 false —— 两个边界都不走哈希，
 * 因为「全量」与「全关」不该依赖哈希分布是否均匀。
 */
export function isInRollout(userId: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return bucketOf(userId) < percent;
}

/**
 * 用户的分桶号（0～99）。
 *
 * 取 sha256 的前 4 字节而不是 `userId.length % 100` 之类的廉价散列：
 * `user_id` 是 UUID，长度恒定、字符集有限，简单散列会让分布严重倾斜 ——
 * 而倾斜的表现是「放量 10% 实际影响了 40% 的用户」，只有事后看指标才发现。
 *
 * 加固定前缀 `rollout:`：同一个 `user_id` 将来若被用于另一处分桶
 * （比如 A/B 实验），两处应当独立 —— 否则「灰度命中的人」与
 * 「实验组的人」永远是同一批，实验结论会被灰度污染。
 */
export function bucketOf(userId: string): number {
  const digest = createHash('sha256').update(`rollout:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export type FeatureName = 'generation' | 'export';

export interface FeatureDecision {
  readonly allowed: boolean;
  /** 拒绝原因，进日志与指标（不进用户可见响应） */
  readonly reason?: 'disabled' | 'not_in_rollout';
}

/**
 * 判定一次请求是否放行。
 *
 * 两种拒绝原因分开返回：「功能被关了」与「你不在这批放量里」在运维上是
 * 完全不同的状态 —— 前者是全局的（该修或该开），后者是预期的（正在灰度）。
 * 合成一个的话，放量期间的正常拒绝会和一次误操作关闭混在同一个计数里。
 */
export function decideFeature(
  flags: FeatureFlags,
  feature: FeatureName,
  userId: string,
): FeatureDecision {
  if (feature === 'export') {
    return flags.exportEnabled ? { allowed: true } : { allowed: false, reason: 'disabled' };
  }

  if (!flags.generationEnabled) return { allowed: false, reason: 'disabled' };
  return isInRollout(userId, flags.generationRolloutPercent)
    ? { allowed: true }
    : { allowed: false, reason: 'not_in_rollout' };
}
