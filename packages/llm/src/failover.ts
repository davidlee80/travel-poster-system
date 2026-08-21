/**
 * 候选模型故障转移的调度器。
 *
 * ## 语义：严格顺序，但不放弃已发出的请求
 *
 * ```text
 * t=0      发候选 1
 * t=40s    候选 1 未返回 → **不 abort**，发候选 2
 * t=40~80  候选 1 此刻返回 → 立即采用，取消候选 2
 * t=80s    总预算耗尽 → 全部 abort，返回 failed
 * ```
 *
 * 「超时」只意味着**不再等它、去试下一个**，不意味着放弃它的结果 ——
 * 那次调用的钱已经花了，产物只要回来就该用。这是本模块与「顺序重试」
 * 唯一但关键的区别。
 *
 * ## 为什么不能用 Promise.race
 *
 * 已 reject 的候选会让 `race` 立刻返回那个 reject，从而跳过仍在跑的候选 ——
 * 恰好破坏上面那条语义。因此每次尝试都被包成**永不 reject** 的 settled 结果，
 * 失败的从在途集合里摘掉之后继续 race 剩下的。
 *
 * ## 两个时间参数的分工
 *
 * `perAttemptMs` 是「等多久就去试下一个」，`totalBudgetMs` 是硬上限。
 * 后者存在的意义是让「候选数 × 单候选超时」不会突破任务级的时间约束 ——
 * 候选数来自数据库（运营可改），单靠前者约束不住总时长。
 *
 * ## hedgeDelayMs 是预留位
 *
 * 缺省等于 `perAttemptMs`，即严格顺序。传入更小的值就变成对冲式调度
 * （8 秒未返回就并发发下一个，尾延迟更低但成本更高）。本轮不启用，
 * 留这个参数是因为切换它不需要改本模块的任何逻辑。
 */

/** 一次尝试。收到的 signal 在放弃该候选时被 abort */
export type Attempt<T> = (signal: AbortSignal) => Promise<T>;

export interface RaceOptions {
  /** 等多久就去发下一个候选 */
  readonly perAttemptMs: number;
  /** 整条候选链的硬上限 */
  readonly totalBudgetMs: number;
  /** 对冲触发延迟。缺省 = perAttemptMs（严格顺序） */
  readonly hedgeDelayMs?: number;
  readonly now?: () => number;
}

export type RaceResult<T> =
  | {
      readonly kind: 'success';
      readonly winner: T;
      /** 胜出候选在入参数组中的下标。0 以外的值说明主模型没顶住 */
      readonly position: number;
      /** 实际发出的请求数。日预算按它计，而不是按成功次数 */
      readonly attemptsStarted: number;
    }
  | {
      readonly kind: 'failed';
      /** 每个候选各自的失败原因，按落定顺序 */
      readonly errors: readonly unknown[];
      readonly attemptsStarted: number;
    };

/** 包装后的结果：永不 reject，失败也是一个值 */
type Settled<T> =
  | { readonly ok: true; readonly position: number; readonly value: T }
  | { readonly ok: false; readonly position: number; readonly error: unknown };

const TIMEOUT = Symbol('timeout');

function cancellableTimer(ms: number): {
  readonly promise: Promise<typeof TIMEOUT>;
  readonly cancel: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof TIMEOUT>((resolve) => {
    handle = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

export async function raceFirstSuccess<T>(
  attempts: readonly Attempt<T>[],
  options: RaceOptions,
): Promise<RaceResult<T>> {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.totalBudgetMs;
  const hedgeDelayMs = options.hedgeDelayMs ?? options.perAttemptMs;

  const controllers: AbortController[] = [];
  const errors: unknown[] = [];
  const inFlight = new Map<number, Promise<Settled<T>>>();
  let attemptsStarted = 0;

  /** 放弃全部在途请求。不做的话它们会继续占着连接与上游算力，而已经没人等结果了 */
  const abortAll = (): void => {
    for (const controller of controllers) controller.abort();
  };

  /**
   * 等到「某个在途候选成功」或「等满 waitMs」。
   *
   * 在途集合被失败候选清空时**立刻**返回超时，而不是等满 waitMs ——
   * 快速失败（4xx、模型名不存在）已经有确定答案，再等下去纯属浪费。
   */
  const waitForSuccess = async (
    waitMs: number,
  ): Promise<{ readonly value: T; readonly position: number } | null> => {
    if (inFlight.size === 0) return null;

    const timer = cancellableTimer(waitMs);
    try {
      for (;;) {
        const settled = await Promise.race<Settled<T> | typeof TIMEOUT>([
          ...inFlight.values(),
          timer.promise,
        ]);

        if (settled === TIMEOUT) return null;

        inFlight.delete(settled.position);
        if (settled.ok) return { value: settled.value, position: settled.position };

        errors.push(settled.error);
        if (inFlight.size === 0) return null;
      }
    } finally {
      timer.cancel();
    }
  };

  for (const [index, attempt] of attempts.entries()) {
    const remaining = deadline - now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    controllers.push(controller);
    attemptsStarted += 1;

    const settled: Promise<Settled<T>> = attempt(controller.signal).then(
      (value) => ({ ok: true as const, position: index, value }),
      (error: unknown) => ({ ok: false as const, position: index, error }),
    );
    inFlight.set(index, settled);

    const won = await waitForSuccess(Math.min(hedgeDelayMs, remaining));
    if (won !== null) {
      abortAll();
      return { kind: 'success', winner: won.value, position: won.position, attemptsStarted };
    }
  }

  /*
   * 候选已经发完，但可能还有在途的（被超时跳过、却仍在跑）。
   * 用掉剩余的总预算继续等它们 —— 这一段正是「监听前面超时的模型」。
   */
  const remaining = deadline - now();
  if (remaining > 0 && inFlight.size > 0) {
    const won = await waitForSuccess(remaining);
    if (won !== null) {
      abortAll();
      return { kind: 'success', winner: won.value, position: won.position, attemptsStarted };
    }
  }

  abortAll();
  return { kind: 'failed', errors, attemptsStarted };
}
