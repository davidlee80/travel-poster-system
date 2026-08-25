import { ConfigError, optionalInt } from '@tps/shared';

/**
 * 货币单位与人民币兑换（设计：用户货币 CR 消耗系统）。
 *
 * ## CR 是整数，全程不用浮点
 *
 * 这是钱。`0.1 + 0.2 !== 0.3` 在余额上的表现是「充了 100 次 1 元，余额显示
 * 99.99999999996 元」，而任何一次比较（余额是否够）都可能在边界上翻面。
 * 因此对外只有 CR 这一个整数单位，人民币只在**充值入口**与**运营算价**时出现。
 *
 * ## 为什么 1 元 = 1000 CR
 *
 * 粒度要能表示单次模型调用的成本。一次 20K token 的调用在几分钱量级，
 * 若 1 元 = 100 CR，那次调用是 2～3 CR —— 舍入误差占到 30%。
 * 1000 的粒度（1 CR = 0.001 元）让同一次调用是 20～30 CR，舍入误差可忽略，
 * 而 `Number.MAX_SAFE_INTEGER` 能表示 9 万亿元，不存在溢出风险。
 *
 * 它是可配的（`CREDIT_CR_PER_CNY`），但**改它会让存量余额的含义变化** ——
 * 数据库里存的是 CR，改比率等于给所有人的钱包重新标价。真要改必须同时
 * 迁移余额，因此这里不提供任何「按新比率折算」的辅助函数：
 * 没有那个函数，下一个人会先想清楚再动。
 */

export interface CreditConfig {
  /** 1 元人民币兑多少 CR */
  readonly crPerCny: number;
  /** 首次注册赠送的 CR。0 = 不赠送 */
  readonly signupGrantCr: number;
  /**
   * 预留额相对估算值的放大系数（百分比，100 = 不放大）。
   *
   * 估算走的是**最坏情况上界**（见 `estimate.ts`），因此理论上不需要放大。
   * 留这个旋钮是因为上界依赖若干「运营可改」的量（模型池候选数、
   * `QUOTA_*_AI_HERO`），配置漂移时预留不足会让结算把余额扣成负数 ——
   * 而余额有 `>= 0` 的 CHECK，那会让结算事务直接失败、任务卡在终态之前。
   */
  readonly holdBufferPercent: number;
}

export function loadCreditConfig(): CreditConfig {
  const config: CreditConfig = {
    crPerCny: optionalInt('CREDIT_CR_PER_CNY', 1_000),
    signupGrantCr: optionalInt('CREDIT_SIGNUP_GRANT_CR', 9_900),
    holdBufferPercent: optionalInt('CREDIT_HOLD_BUFFER_PERCENT', 120),
  };
  assertCreditConfig(config);
  return config;
}

export function assertCreditConfig(config: CreditConfig): void {
  const problems: string[] = [];

  if (config.crPerCny <= 0) {
    problems.push(`CREDIT_CR_PER_CNY 必须为正数，实际 ${config.crPerCny}。`);
  }
  if (config.signupGrantCr < 0) {
    problems.push(`CREDIT_SIGNUP_GRANT_CR 不能为负，实际 ${config.signupGrantCr}。`);
  }
  if (config.holdBufferPercent < 100) {
    /*
     * 低于 100 意味着预留比估算还少，而估算已经是上界 —— 那就等于故意让
     * 结算超出预留。超出的部分要么把余额扣成负数（CHECK 拒绝，事务失败，
     * 任务卡住），要么静默不扣（我们白付）。两种都不能接受。
     */
    problems.push(
      `CREDIT_HOLD_BUFFER_PERCENT 必须 >= 100，实际 ${config.holdBufferPercent}。` +
        '低于 100 等于让结算金额超出预留额。',
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(`货币配置不合法:\n  - ${problems.join('\n  - ')}`);
  }
}

/** 人民币（元）→ CR。只用于充值入口与运营算价 */
export function cnyToCredits(cny: number, config: CreditConfig): number {
  /*
   * 向下取整而不是四舍五入：多给用户不到 1 CR（0.001 元）无所谓，
   * 但「充 9.9 元拿到 9900.4 CR」这种非整数余额一旦落库，
   * 后续所有整数运算的前提就没了。
   */
  return Math.floor(cny * config.crPerCny);
}

/** CR → 人民币（元），只用于展示。返回字符串避免调用方拿浮点去算 */
export function creditsToCnyText(credits: number, config: CreditConfig): string {
  return (credits / config.crPerCny).toFixed(2);
}

/** 估算值 → 预留额 */
export function holdAmount(estimated: number, config: CreditConfig): number {
  return Math.ceil((estimated * config.holdBufferPercent) / 100);
}
