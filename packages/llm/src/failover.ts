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

import { ImageUnavailableError, type ImageClient, type ImageResult } from './image.js';
import { LlmUnavailableError, type LlmClient, type LlmResult } from './client.js';

/** 一次尝试。收到的 signal 在放弃该候选时被 abort */
export type Attempt<T> = (signal: AbortSignal) => Promise<T>;

export interface RaceOptions {
  /** 等多久就去发下一个候选 */
  readonly perAttemptMs: number;
  /** 整条候选链的硬上限 */
  readonly totalBudgetMs: number;
  /** 对冲触发延迟。缺省 = perAttemptMs（严格顺序） */
  readonly hedgeDelayMs?: number;
  /**
   * 外部预算耗尽的信号（任务级 deadline）。
   *
   * **只阻止开新候选，不 abort 在途的** —— 已经发出的请求钱已经花了，
   * 产物只要回来就该用，这是本模块的核心语义。
   *
   * 存在的理由：`totalBudgetMs` 由 env 算出（候选数 × 单候选超时），
   * 而候选数来自数据库，运营可以配成 20。那个乘积管不住 16.3 的 300 秒
   * 任务上限 —— 剩 8 秒时一条 20 候选的链仍会串行烧掉 20 次请求，
   * 全部落在 deadline 之后。少了这个信号，那笔钱没有任何东西挡得住。
   */
  readonly abortSignal?: AbortSignal;
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

        // 失败原因已在落定处收集（见上面的 `settled`），这里只管调度
        if (inFlight.size === 0) return null;
      }
    } finally {
      timer.cancel();
    }
  };

  for (const [index, attempt] of attempts.entries()) {
    /*
     * 任务级预算已耗尽：不再开新候选，但**不动在途的** ——
     * 下面那段收尾仍会等它们，因为那些请求的钱已经花了。
     */
    if (options.abortSignal?.aborted === true) break;

    const remaining = deadline - now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    controllers.push(controller);
    attemptsStarted += 1;

    const settled: Promise<Settled<T>> = attempt(controller.signal).then(
      (value) => ({ ok: true as const, position: index, value }),
      (error: unknown) => {
        /*
         * 在落定处收集，而不是等 `waitForSuccess` 观测到。
         *
         * 总预算恰好耗尽时（`remaining <= 0`）下面那次收尾的 `waitForSuccess`
         * 压根不会执行，在途候选的失败原因会全部丢掉 —— 于是调用方抛出的
         * 消息成了「全部 N 个候选模型均失败：」后面什么都没有，
         * 而这恰恰是最需要原因的那种故障（上游整体卡住）。
         */
        errors.push(error);
        return { ok: false as const, position: index, error };
      },
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

// ── 装饰器 ──────────────────────────────────────────────────

/**
 * 一条候选链的结局，回报给调用方。
 *
 * `packages/llm` 不依赖 `@tps/observability`（分层：模型访问层不该知道
 * 指标体系长什么样），因此指标与日志由调用方按这个回调上报。
 */
export interface FailoverOutcome {
  /** 胜出候选的位次。> 0 说明主模型没顶住，是「主模型有问题」的唯一信号 */
  readonly position: number;
  /** 实际发出的请求数。日预算按它计，不按成功次数（本轮决策 4） */
  readonly attemptsStarted: number;
  readonly ok: boolean;
}

export interface FailoverClientOptions {
  readonly perAttemptMs: number;
  readonly totalBudgetMs: number;
  readonly onOutcome?: (outcome: FailoverOutcome) => void;
}

/**
 * 给图像客户端套上故障转移。
 *
 * **单候选时原样返回底层客户端**，不做任何包装 —— 图像的标准用户档就是
 * 单候选（本轮决策 5），那条路径必须零开销。包一层空壳会让默认路径
 * 多两次 Promise 调度，虽然可忽略，但更重要的是让调用栈变浑。
 */
export function wrapImageFailover(
  candidates: readonly ImageClient[],
  options: FailoverClientOptions,
): ImageClient {
  const first = candidates[0];
  if (first === undefined) {
    throw new ImageUnavailableError('候选模型列表为空');
  }
  if (candidates.length === 1) return first;

  return {
    // 接口要求有个 model；用主候选的名字，实际产出者见 ImageResult.model
    model: first.model,

    async generate(request) {
      const result = await raceFirstSuccess<ImageResult>(
        candidates.map((candidate) => (signal) => candidate.generate({ ...request, signal })),
        options,
      );

      options.onOutcome?.({
        position: result.kind === 'success' ? result.position : -1,
        attemptsStarted: result.attemptsStarted,
        ok: result.kind === 'success',
      });

      if (result.kind === 'failed') {
        throw new ImageUnavailableError(
          `全部 ${result.attemptsStarted} 个候选模型均失败：${describeErrors(result.errors)}`,
        );
      }

      /*
       * `costUnits` 记实际发出的请求数而不是 1。
       *
       * 超时的那些候选，供应商很可能已经生成完并计了费 —— 我们只是没等到。
       * 记 1 会让 21.4 的日预算熔断（600）比真实成本低估若干倍，
       * 而那个阈值存在的意义就是反映成本。
       *
       * 胜出者本身报 0 时保持 0：`FakeImageClient` 用它表示「这次调用不花钱」，
       * 而假实现的调用混进成本报表会让本地与 CI 的熔断毫无意义地打开。
       */
      return {
        ...result.winner,
        costUnits: result.winner.costUnits === 0 ? 0 : result.attemptsStarted,
      };
    },
  };
}

/**
 * 给文本客户端套上故障转移。
 *
 * 与图像侧对称，两处差异：
 *   - 没有 `costUnits` 概念，token 用量取胜出候选的（其余候选的 token
 *     没有产出，计进去会让「每份计划的 token 成本」失真）
 *   - 全部失败时抛 `LlmUnavailableError`，映射到 13.7 的可重试码
 */
export function wrapLlmFailover(
  candidates: readonly LlmClient[],
  options: FailoverClientOptions,
): LlmClient {
  const first = candidates[0];
  if (first === undefined) {
    throw new LlmUnavailableError('候选模型列表为空');
  }
  if (candidates.length === 1) return first;

  return {
    model: first.model,

    async complete(request) {
      /*
       * `request.signal` 是任务级 deadline（`callModel` 传入），它的作用是
       * **不要再开新候选**，而不是「掐掉在途的」。因此把它交给调度器的
       * `abortSignal`，并从转发给候选的请求里摘掉 —— 留着的话
       * `client.ts` 会把它与自己的超时取并集，于是 deadline 一到，
       * 那些已经付过钱、马上就要回来的在途请求会被一起掐死。
       *
       * 单候选路径（上面直接返回底层客户端）不经过这里，signal 照旧并入 ——
       * 那条路径上没有「其余候选」，两种语义等价。
       */
      const { signal: jobSignal, ...forwarded } = request;

      const result = await raceFirstSuccess<LlmResult>(
        candidates.map((candidate) => (signal) => candidate.complete({ ...forwarded, signal })),
        { ...options, ...(jobSignal === undefined ? {} : { abortSignal: jobSignal }) },
      );

      options.onOutcome?.({
        position: result.kind === 'success' ? result.position : -1,
        attemptsStarted: result.attemptsStarted,
        ok: result.kind === 'success',
      });

      if (result.kind === 'failed') {
        throw new LlmUnavailableError(
          `全部 ${result.attemptsStarted} 个候选模型均失败：${describeErrors(result.errors)}`,
        );
      }

      return result.winner;
    },
  };
}

/**
 * 把多个候选的失败原因拼成一句。
 *
 * 保留全部而不只是最后一个：排查时要看的恰恰是「是不是每个都因为同一个理由
 * 失败」—— 那说明问题在我们这边（请求体、凭据），而各自不同的失败更像是
 * 上游各自的问题。截断到 200 字符避免把上游的长错误体灌进日志。
 */
function describeErrors(errors: readonly unknown[]): string {
  return errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join(' | ')
    .slice(0, 200);
}
