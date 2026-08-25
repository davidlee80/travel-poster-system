import type { CounterStore, UserType } from '@tps/shared';
import type { AssetRole } from '@tps/schemas';

/**
 * AI 图片生成的预算与熔断（TP-4-03/15/17，设计稿 21.2 措施二、21.4）。
 *
 * 四层限制，从窄到宽：
 *
 * ```text
 * 1. 单任务实时 Hero 次数   21.2 措施二「最多 2 次」∩ 21.4 的 QUOTA_*_AI_HERO
 *                           匿名为 0 → 匿名任务不产生任何 AI Hero（TP-4-17）
 * 2. 单任务 AI 图总张数     21.4「3 张」，超出后续槽位直接走占位图
 * 3. 单任务 AI 墙钟窗口     IMAGE_JOB_AI_BUDGET_MS，时延闸（见下）
 * 4. 全局日调用量熔断       21.4「达到预算阈值时全局切到素材库 + 占位图」
 * ```
 *
 * ## 为什么 Hero 次数与总张数是两个计数而不是一个
 *
 * 它们防的是两件不同的事。总张数（3）是**成本**上限；Hero 次数（2）曾是
 * **时延**上限 —— 21.2 的 T2 目标扣掉 T1 只剩一个固定窗口，而一次 Hero
 * 生成最多 20 秒。合成一个数的话，一个 14 天的任务可能把 3 张额度全花在
 * Hero 上（3 × 20 = 60 秒），T2 必然违约。
 *
 * ## 为什么次数不再够用：时延要有自己的闸
 *
 * 上面那句「一次最多 20 秒」是**硬编码常量**时才成立的推论。多模型故障转移
 * 把单候选超时改成了可配（默认 40 秒），并且一条候选链可以发出多个请求 ——
 * 同样的「2 次 Hero」现在可以是 80 秒也可以是 400 秒。次数就此只剩成本含义。
 *
 * 因此时延要有自己的预算：**次数管成本、窗口管时延，两者先到先停**。
 *
 * 窗口是**墙钟 + 前瞻**，不是累计耗时之和：素材解析并发跑（天 8 × 槽 6），
 * 3 条链同时花 40 秒，墙钟只走 40 秒。判据因此是「现在放行的话它最晚
 * 什么时候结束」——「窗口已流走 + 这条链的最坏耗时」超出总长就拒绝。
 * 详见 `reserve`；`recordElapsed` 回报的实际耗时只作可观测量。
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
 * 后果是：供应商挂掉时，每个可生成的槽位都会等满单候选超时才失败 ——
 * 14 天有 84 个槽位，按 21.2 的并发（天 8 × 槽 6）算下来仍是数分钟，
 * 而素材解析窗口只有 T2(155) − T1(75) = 80 秒。
 *
 * 取 2 而不是 1：单次失败可能是偶发（供应商的某个节点），
 * 连续两次几乎一定是系统性故障，此时继续尝试只是在消耗用户的等待时间 ——
 * 而降级路径（占位图）是即时的。
 *
 * **计的是「一条候选链」而不是「一个候选」。** 故障转移在 `ImageClient` 边界
 * 之内，因此一条 3 候选的链失败只记 1 次。按候选记的话这个上限（2）会让
 * 一条链失败就把额度用光，于是配了候选池却只有第一个槽位真的用上。
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
  | 'JOB_AI_TIME_EXHAUSTED'
  | 'GLOBAL_CIRCUIT_OPEN'
  | 'PROVIDER_FAILING'
  | 'ROLE_NOT_ELIGIBLE';

export interface AiBudgetDeps {
  readonly counters: CounterStore;
  readonly userType: UserType;
  /** 21.4 的 `QUOTA_*_AI_HERO`。匿名为 0 */
  readonly heroQuota: number;
  /**
   * 任务级 AI 累计耗时上限（`IMAGE_JOB_AI_BUDGET_MS`）。
   *
   * **必填而不是带默认值**：这是时延的唯一防线，而「忘了接线」与
   * 「有意不限」在带默认值的形态下长得一模一样。少传一个参数会让
   * TypeScript 立刻报错，而一个静默生效的 `Infinity` 只会在 T2 违约时
   * 才被发现 —— 那时排查方向会先落在模型供应商上。
   */
  readonly jobAiBudgetMs: number;
  /**
   * 一条候选链的最坏耗时 = 单候选超时 × 该档的候选数。
   *
   * 准入判定要的是「**如果现在放行，它最晚什么时候结束**」，而那取决于
   * 候选数 —— 而候选数是每任务从池里选出来的（`selectImageClient`），
   * 本类看不到。因此由调用方注入。
   *
   * 与 `jobAiBudgetMs` 同样**必填**：缺省值会让「忘了接线」表现为
   * 「窗口保护恰好失效」，而那要到 T2 违约时才被发现。
   */
  readonly chainWorstCaseMs: number;
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
  private elapsedMs = 0;
  /** 首次放行的墙钟时刻。AI 窗口从这一刻开始算，之前的等待不占窗口 */
  private windowStartedAt: number | null = null;

  constructor(private readonly deps: AiBudgetDeps) {}

  /** 已用张数、失败次数与累计耗时，供 `warnings` 与日志使用 */
  get used(): {
    readonly images: number;
    readonly heroes: number;
    readonly failures: number;
    readonly elapsedMs: number;
  } {
    return {
      images: this.images,
      heroes: this.heroes,
      failures: this.failures,
      elapsedMs: this.elapsedMs,
    };
  }

  /** AI 窗口已流走的墙钟时长。尚未放行过任何调用时为 0 */
  private windowUsedMs(nowMs: number): number {
    return this.windowStartedAt === null ? 0 : Math.max(0, nowMs - this.windowStartedAt);
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

    const now = (this.deps.now ?? (() => new Date()))();
    const nowMs = now.getTime();

    /*
     * ## 时延闸：墙钟 + 前瞻，不是累计耗时之和
     *
     * 判据是「**如果现在放行，它最晚什么时候结束**」：
     * 窗口已流走的墙钟 + 这条链的最坏耗时 > 窗口总长 → 拒绝。
     *
     * 为什么不能用「各链耗时之和」（本方法从前的做法）：素材解析是并发的
     * （天 8 × 槽 6），3 条链同时跑 40 秒，墙钟只走了 40 秒而和是 120 秒。
     * 按和判定会把并发误判成超支，把本来赶得上的槽位拒掉；而更糟的是
     * 反过来 —— `elapsedMs` 只在调用**返回后**才更新，同批并发的槽位
     * 全都在它还是 0 时通过，于是那个闸压根拦不住任何东西。
     *
     * 前瞻项 `chainWorstCaseMs` 是候选池必须存在的理由：一条 2 候选的链
     * 最坏是 2 × 单候选超时，而单看「已经花了多少」永远发现不了这件事 ——
     * 等发现时那 80 秒已经走掉了。
     *
     * `elapsedMs` 保留但不再参与判定，它是「实际花了多少」的可观测量。
     */
    if (this.windowUsedMs(nowMs) + this.deps.chainWorstCaseMs > this.deps.jobAiBudgetMs) {
      return { allowed: false, reason: 'JOB_AI_TIME_EXHAUSTED' };
    }

    /*
     * ## 占位必须发生在任何 `await` 之前
     *
     * 素材解析是并发的。递增放在下面那次 `peek` 之后的话，同一瞬间进入
     * 本方法的槽位会**全部**读到递增前的 `images`，于是每个都通过 ——
     * 21.4 的「3 张」与 21.2 的「2 次 Hero」双双失守，而症状是成本与 T2
     * 一起超，看不出是同一个原因。
     *
     * 检查与递增之间不能有让出点，这是这几行的全部意义。
     */
    this.images += 1;
    if (hero) this.heroes += 1;
    // 窗口从第一次放行开始计。之前的本地库查询与搜索层不占 AI 的窗口
    this.windowStartedAt ??= nowMs;

    const budget = this.deps.dailyBudget ?? DEFAULT_AI_IMAGE_DAILY_BUDGET;
    const spent = await this.deps.counters.peek(aiImageDailyKey(now));
    if (spent >= budget) {
      // 占位已经做了，这条拒绝路径必须还 —— 否则熔断打开后连降级都占着额度
      this.refund(role);
      return { allowed: false, reason: 'GLOBAL_CIRCUIT_OPEN' };
    }

    return { allowed: true };
  }

  /**
   * 记一次真实模型调用的耗时（无论成败）。
   *
   * 由调用方在调用返回后回报，而不是让本类自己掐表：一次 `reserve` 到
   * 实际发起调用之间还隔着并发锁与同键等待（最多 22 秒），把那段算进来
   * 会让「AI 花了多久」变成「这个槽位等了多久」，两者的处置完全不同。
   *
   * **不再参与准入判定**（那件事由 `reserve` 的墙钟 + 前瞻负责）。
   * 并发下这个累加值是各链耗时之**和**，而窗口是墙钟 —— 两者量纲不同，
   * 拿它当闸会同时犯两个错：并发被误判成超支，而同批并发压根拦不住。
   * 保留它是因为「这个任务实际在 AI 上花了多少」是排查时要看的量。
   */
  recordElapsed(ms: number): void {
    // 负值只可能来自时钟回拨；忽略而不是让已花掉的时间被凭空还回来
    this.elapsedMs += Math.max(0, ms);
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

  /**
   * 记入全局日计数（熔断的唯一数据来源）。
   *
   * ## 口径是「发出的请求数」而不是「成功的张数」
   *
   * `costUnits` 由客户端给出，候选链上等于**实际发出的请求数**。
   * 超时的那些候选，供应商很可能已经生成完并计了费 —— 我们只是没等到。
   * 记 1 会让 21.4 的 600 熔断比真实成本低估若干倍，而那个阈值存在的
   * 意义就是反映成本。
   *
   * `costUnits` 为 0 时不写：`FakeImageClient` 报 0，而它不花钱 ——
   * 让开发环境的调用混进成本核算会让熔断在本地毫无意义地打开。
   */
  async commit(costUnits = 1): Promise<void> {
    if (costUnits <= 0) return;
    const now = (this.deps.now ?? (() => new Date()))();
    await this.deps.counters.increment(aiImageDailyKey(now), DAILY_TTL_SECONDS, costUnits);
  }
}
