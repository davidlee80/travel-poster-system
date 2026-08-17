import type { CounterStore, UserType } from '@tps/shared';
import type { AssetRole } from '@tps/schemas';

/**
 * AI 图片生成的预算与熔断（TP-4-03/15/17，设计稿 21.2 措施二、21.4）。
 *
 * 三层限制，从窄到宽：
 *
 * ```text
 * 1. 单任务实时 Hero 次数   21.2 措施二「最多 2 次」∩ 21.4 的 QUOTA_*_AI_HERO
 *                           匿名为 0 → 匿名任务不产生任何 AI Hero（TP-4-17）
 * 2. 单任务 AI 图总张数     21.4「3 张」，超出后续槽位直接走占位图
 * 3. 全局日调用量熔断       21.4「达到预算阈值时全局切到素材库 + 占位图」
 * ```
 *
 * ## 为什么 Hero 次数与总张数是两个计数而不是一个
 *
 * 它们防的是两件不同的事。总张数（3）是**成本**上限；Hero 次数（2）是
 * **时延**上限 —— 21.2 的 T2 目标（P95 < 110 秒）扣掉 T1 的 75 秒只剩
 * 35 秒，而一次 Hero 生成最多 20 秒。合成一个数的话，一个 14 天的任务
 * 可能把 3 张额度全花在 Hero 上（3 × 20 = 60 秒），T2 必然违约。
 *
 * ## 21.4 的 `QUOTA_*_AI_HERO` 按「每任务」理解
 *
 * 21.4 的表格里这一行没有周期列（其余行都写明每分钟/每日/每月/每计划）。
 * 而 21.2 措施二明确是「**同一计划内**最多允许 2 次」。因此取每任务口径 ——
 * 两处说的是同一条约束，只是从成本与时延两个角度各写了一次。
 *
 * 按每日理解的话，注册用户当天第 3 个计划起就完全没有 AI Hero，
 * 而日计划配额是 5 —— 用户会发现「同样的操作，今天第三次做出来的效果变差了」，
 * 而页面上没有任何说明。
 *
 * ## 熔断只读不写判定，写入在生成之后
 *
 * 判定用 `peek`（只读）而不是「先自增再看」：自增即消耗，而生成可能失败。
 * 失败的调用不该占用日预算 —— 供应商侧的失败请求多数不计费，
 * 把它们算进预算会让一次上游故障连带把当天的预算烧光。
 */

/** 21.4：单任务 AI 图片生成上限 3 张 */
export const MAX_AI_IMAGES_PER_JOB = 3;

/** 21.2 措施二：单任务最多 2 次实时 AI Hero */
export const MAX_REALTIME_HERO_PER_JOB = 2;

/**
 * 单任务内允许的连续失败次数，超出即本任务不再尝试 AI。
 *
 * **设计稿没有这一条，但少了它 21.4 的上限管不住时延。**
 * 21.4 的「3 张」是成本上限，计的是**成功**生成的张数；而失败的调用要归还
 * 额度（否则一次上游抖动就让整个计划一张 AI 图都没有）。两条放在一起的
 * 后果是：供应商挂掉时，每个可生成的槽位都会等满 20 秒才失败 ——
 * 14 天有 84 个槽位，按 21.2 的并发（天 8 × 槽 6）算下来仍是数分钟，
 * 而 T2 目标（P95 < 110 秒）扣掉 T1 只剩 35 秒。
 *
 * 取 2 而不是 1：单次失败可能是偶发（供应商的某个节点），
 * 连续两次几乎一定是系统性故障，此时继续尝试只是在消耗用户的等待时间 ——
 * 而降级路径（占位图）是即时的。
 */
export const MAX_AI_FAILURES_PER_JOB = 2;

/**
 * 全局日调用量的默认阈值。
 *
 * 600 = 19.5 的预热规模（Top 50 目的地 × 12 主题桶）。取这个数的理由是
 * 它有明确含义：**一天之内消耗掉相当于整个预热库的 AI 调用量**，
 * 说明命中率出了问题（21.3 的 `travel_asset_cache_hit_ratio` 告警阈值
 * 是 0.7），此时继续付费生成不如降级并告警。
 */
export const DEFAULT_AI_IMAGE_DAILY_BUDGET = 600;

/** 熔断计数的 Redis 键（含日期，过期自动重置，与 21.4 的配额计数同一处理） */
export function aiImageDailyKey(now: Date): string {
  return `ai:image:daily:${now.toISOString().slice(0, 10)}`;
}

/** 一天的秒数 + 1 小时余量：跨时区读取时不至于刚过零点就丢计数 */
const DAILY_TTL_SECONDS = 90_000;

export type AiBudgetDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: AiBudgetRejection };

/**
 * 拒绝原因。全部进 `warnings` 而不是错误 —— 21.4 明确「记入 `warnings`，
 * 不报错」，用户拿到的是降级后的图而不是失败的任务。
 */
export type AiBudgetRejection =
  | 'HERO_QUOTA_EXHAUSTED'
  | 'JOB_IMAGE_LIMIT'
  | 'GLOBAL_CIRCUIT_OPEN'
  | 'PROVIDER_FAILING'
  | 'ROLE_NOT_ELIGIBLE';

export interface AiBudgetDeps {
  readonly counters: CounterStore;
  readonly userType: UserType;
  /** 21.4 的 `QUOTA_*_AI_HERO`。匿名为 0 */
  readonly heroQuota: number;
  readonly dailyBudget?: number;
  readonly now?: () => Date;
}

/**
 * 一个生成任务对应一个实例（计数是任务内状态）。
 *
 * 不做成无状态函数 + Redis 计数：单任务计数的正确性只需要进程内可见
 * （一个任务只在一个 Worker 上跑，13.8 的 `lock:job` 保证），
 * 而放进 Redis 会给每个槽位加两次网络往返 —— 在 800 毫秒预算里不划算。
 */
export class AiImageBudget {
  private images = 0;
  private heroes = 0;
  private failures = 0;

  constructor(private readonly deps: AiBudgetDeps) {}

  /** 已用张数与失败次数，供 `warnings` 与日志使用 */
  get used(): {
    readonly images: number;
    readonly heroes: number;
    readonly failures: number;
  } {
    return { images: this.images, heroes: this.heroes, failures: this.failures };
  }

  /**
   * 判定某个角色现在能否调用 AI。
   *
   * 顺序是「先看不花钱就能判定的，再看要查 Redis 的」：
   * 角色 → 任务内计数 → 全局熔断。反过来会让「匿名用户的 Hero 槽位」
   * 每次都白查一次 Redis，而它的结果恒为拒绝。
   */
  async reserve(role: AssetRole): Promise<AiBudgetDecision> {
    if (role === 'ROUTE_MAP') {
      // 11.3 禁止 AI 绘制地图文字；9.2 的路线图是程序生成的 SVG
      return { allowed: false, reason: 'ROLE_NOT_ELIGIBLE' };
    }

    const hero = role === 'HERO_BACKGROUND';
    if (hero) {
      const limit = Math.min(MAX_REALTIME_HERO_PER_JOB, this.deps.heroQuota);
      if (this.heroes >= limit) {
        return { allowed: false, reason: 'HERO_QUOTA_EXHAUSTED' };
      }
    }

    if (this.images >= MAX_AI_IMAGES_PER_JOB) {
      return { allowed: false, reason: 'JOB_IMAGE_LIMIT' };
    }

    if (this.failures >= MAX_AI_FAILURES_PER_JOB) {
      // 本任务内的供应商已连续失败：继续试只是在消耗用户的等待时间
      return { allowed: false, reason: 'PROVIDER_FAILING' };
    }

    const budget = this.deps.dailyBudget ?? DEFAULT_AI_IMAGE_DAILY_BUDGET;
    const now = (this.deps.now ?? (() => new Date()))();
    const spent = await this.deps.counters.peek(aiImageDailyKey(now));
    if (spent >= budget) {
      return { allowed: false, reason: 'GLOBAL_CIRCUIT_OPEN' };
    }

    this.images += 1;
    if (hero) this.heroes += 1;
    return { allowed: true };
  }

  /**
   * 归还一次预留（**没有真的调用模型**时用）。
   *
   * 典型场景是 13.8 的同键并发去重：没拿到锁，本次不会调用模型。
   * 占着任务额度会让后面本可以成功的槽位白白降级。
   *
   * 全局日计数**不在这里减**：它压根没加过（见 `commit`）。
   */
  refund(role: AssetRole): void {
    this.images = Math.max(0, this.images - 1);
    if (role === 'HERO_BACKGROUND') this.heroes = Math.max(0, this.heroes - 1);
  }

  /**
   * 归还预留并记一次失败（**调用了模型但没拿到可用产物**时用）。
   *
   * 与 `refund` 分开是必要的：两者都要还额度，但只有这一个说明
   * 「供应商此刻不好」。合成一个的话，同键去重的等待会被误记成失败，
   * 于是一个正常的 14 天任务在第 3 个槽位就以为供应商挂了。
   */
  recordFailure(role: AssetRole): void {
    this.refund(role);
    this.failures += 1;
  }

  /** 生成成功后记入全局日计数（熔断的唯一数据来源） */
  async commit(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();
    await this.deps.counters.increment(aiImageDailyKey(now), DAILY_TTL_SECONDS);
  }
}
