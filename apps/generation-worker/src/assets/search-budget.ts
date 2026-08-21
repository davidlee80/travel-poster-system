import { DEFAULT_IMAGE_SEARCH_DAILY_BUDGET } from '@tps/llm';
import type { AssetRole } from '@tps/schemas';
import type { CounterStore } from '@tps/shared';

/**
 * 授权图源搜索的配额与熔断（TP-6-06，设计稿 9.6、21.4 的 R-45）。
 *
 * 三层限制，从窄到宽：
 *
 * ```text
 * 1. 单任务搜索次数     9.6「≤ 8 次」∩ 21.4 的 QUOTA_TASK_IMAGE_SEARCH
 * 2. 单任务连续失败     9.6「连续失败 2 次即跳过搜索层」
 * 3. 全局日预算熔断     9.6 的 BUDGET_IMAGE_SEARCH_DAILY
 * ```
 *
 * ## 与 AiImageBudget 的两处刻意不同
 *
 * **没有身份维度。** 9.6：搜索额度匿名与注册同额，「因为搜索命中会入库为
 * 全平台共享资产，它的钱不是花在这个用户身上的」。这与 AI Hero 的额度按
 * 身份区分（匿名为 0，TP-4-17）逻辑相反 —— AI 生成物虽然也进库复用，
 * 但它的缓存键含请求上下文，实际复用面窄得多，且单价高一个量级。
 *
 * **Hero 没有独立的更严上限。** AI 层给 Hero 单开了 2 次的时延上限
 * （21.2 措施二；V1.8 起时延另有任务级累计耗时预算，见 ai-budget.ts）。
 * 搜索层不需要：一次搜索 5 秒，8 次全花在 Hero 上也是 40 秒 —— 但那不会
 * 发生，因为一个任务只有一个 Hero 槽位（`plan_presentations` 每天一个页面、
 * 每页一个 Hero，而 Hero 的缓存键按主题桶归一，14 天通常落 2～3 个桶）。
 *
 * ## 「连续」失败而不是「累计」失败
 *
 * 一个 14 天任务里偶发一次超时、隔几个槽位再偶发一次，与「图源挂了」
 * 是两件事。按累计算的话，前者会在第 3 个槽位就把搜索层关掉，
 * 而它其实工作正常。因此有 `recordSuccess()` 清零 —— AiImageBudget 没有
 * 这个方法是它的一处保守（那边失败一次的代价是 20 秒，宁可早停）。
 *
 * ## 熔断只读不写判定，写入在成功之后
 *
 * 与 AiImageBudget 同一处理：判定用 `peek`（只读），日计数只在 `commit()`
 * 里加。失败的调用不占日预算 —— 把它们算进去会让一次上游故障连带把
 * 当天的搜索预算烧光，而那一天的冷组合本来是可以在图源恢复后搜到的。
 */

/** 9.6：单任务搜索上限 8 次 */
export const MAX_IMAGE_SEARCHES_PER_JOB = 8;

/** 9.6：单任务连续失败 2 次即跳过搜索层 */
export const MAX_SEARCH_FAILURES_PER_JOB = 2;

/**
 * 全局日预算默认值。从 `@tps/llm` 的配置默认值转出，不在这里另写一个数 ——
 * 两处各写一个会让「改了配置默认值但预算类还是老值」无人发现。
 */
export { DEFAULT_IMAGE_SEARCH_DAILY_BUDGET };

/** 熔断计数的 Redis 键（含日期，过期自动重置，与 21.4 的配额计数同一处理） */
export function imageSearchDailyKey(now: Date): string {
  return `search:image:daily:${now.toISOString().slice(0, 10)}`;
}

/** 一天的秒数 + 1 小时余量：跨时区读取时不至于刚过零点就丢计数 */
const DAILY_TTL_SECONDS = 90_000;

/**
 * 拒绝原因。全部进 `warnings` 而不是错误 —— 9.6 明确「超出跳过搜索层记
 * `warnings` 不报错」，用户拿到的是下一层（AI / 占位）的图。
 */
export type SearchBudgetRejection =
  'JOB_SEARCH_LIMIT' | 'GLOBAL_CIRCUIT_OPEN' | 'PROVIDER_FAILING' | 'ROLE_NOT_ELIGIBLE';

export type SearchBudgetDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: SearchBudgetRejection };

export interface ImageSearchBudgetDeps {
  readonly counters: CounterStore;
  readonly dailyBudget?: number;
  readonly now?: () => Date;
}

/**
 * 一个生成任务对应一个实例（次数是任务内状态）。
 *
 * 不做成无状态函数 + Redis 计数：单任务计数的正确性只需要进程内可见
 * （一个任务只在一个 Worker 上跑，13.8 的 `lock:job` 保证），
 * 而放进 Redis 会给每个槽位加两次网络往返 —— 在 10.2 的 800 毫秒预算里
 * 不划算，尽管搜索本身不占那个预算，判定却发生在预算之内。
 */
export class ImageSearchBudget {
  private searches = 0;
  private consecutiveFailures = 0;

  constructor(private readonly deps: ImageSearchBudgetDeps) {}

  /** 已用次数与当前连续失败数，供 `warnings` 与日志使用 */
  get used(): { readonly searches: number; readonly failures: number } {
    return { searches: this.searches, failures: this.consecutiveFailures };
  }

  /**
   * 判定某个角色现在能否发起搜索。
   *
   * 顺序是「先看不花钱就能判定的，再看要查 Redis 的」：
   * 角色 → 任务内计数 → 连续失败 → 全局熔断。反过来会让 `ROUTE_MAP` 槽位
   * 每次都白查一次 Redis，而它的结果恒为拒绝。
   */
  async reserve(role: AssetRole): Promise<SearchBudgetDecision> {
    if (role === 'ROUTE_MAP') {
      // 9.2 的路线图是程序生成的 SVG，没有可搜索的对象
      return { allowed: false, reason: 'ROLE_NOT_ELIGIBLE' };
    }

    if (this.searches >= MAX_IMAGE_SEARCHES_PER_JOB) {
      return { allowed: false, reason: 'JOB_SEARCH_LIMIT' };
    }

    if (this.consecutiveFailures >= MAX_SEARCH_FAILURES_PER_JOB) {
      // 本任务内的图源已连续失败：继续试只是在消耗用户的等待时间
      return { allowed: false, reason: 'PROVIDER_FAILING' };
    }

    const budget = this.deps.dailyBudget ?? DEFAULT_IMAGE_SEARCH_DAILY_BUDGET;
    const now = (this.deps.now ?? (() => new Date()))();
    const spent = await this.deps.counters.peek(imageSearchDailyKey(now));
    if (spent >= budget) {
      return { allowed: false, reason: 'GLOBAL_CIRCUIT_OPEN' };
    }

    this.searches += 1;
    return { allowed: true };
  }

  /**
   * 归还一次预留（**没有真的发起搜索**时用，比如算不出检索词）。
   *
   * 不记失败：那会让「这一层压根不适用」被当成图源故障，于是一个正常任务
   * 在第 3 个槽位就以为图源挂了。全局日计数不在这里减 —— 它压根没加过。
   */
  refund(): void {
    this.searches = Math.max(0, this.searches - 1);
  }

  /** 搜索成功（拿到候选）：清零连续失败计数，见文件头 */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * 归还预留并记一次连续失败（**发起了搜索但没拿到可用候选**时用）。
   *
   * 与 `refund` 分开是必要的：两者都要还额度，但只有这一个说明
   * 「图源此刻不好」。
   */
  recordFailure(): void {
    this.refund();
    this.consecutiveFailures += 1;
  }

  /** 搜索命中并入库后记入全局日计数（熔断的唯一数据来源） */
  async commit(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();
    await this.deps.counters.increment(imageSearchDailyKey(now), DAILY_TTL_SECONDS);
  }
}
