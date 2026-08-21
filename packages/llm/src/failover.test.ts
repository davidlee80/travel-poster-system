import { describe, expect, it } from 'vitest';

import { ImageUnavailableError, type ImageRequest, type ImageResult } from './image.js';

import { raceFirstSuccess, wrapImageFailover, type Attempt } from './failover.js';

/**
 * 候选模型故障转移的调度器（多模型 failover 计划的任务 1）。
 *
 * ## 为什么这一层必须单独测
 *
 * 它是整个特性里唯一有并发时序的部分，而时序缺陷不会在集成测试里稳定复现 ——
 * 真实模型的返回时间是随机的，同一个缺陷可能一百次里错一次。
 * 把调度逻辑抽成不碰网络的纯函数，时序就变成可以精确构造的输入。
 *
 * ## 最要紧的一条断言
 *
 * 「第 1 个候选在候选 2 已发出之后才返回，仍然采用第 1 个」——
 * 这是需求里「时刻监听前面超时的模型是否返回了结果」的字面含义。
 * 用 `Promise.race` 直接实现会在这里错：已 reject 的候选会让 race 立刻
 * 返回那个 reject，从而跳过仍在跑的候选。
 */

/** 手动控制何时 resolve 的 promise，用来精确构造时序 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 永不返回的候选，用于占住一个位置 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe('raceFirstSuccess', () => {
  it('第一个候选就成功时用它，position 为 0', async () => {
    const result = await raceFirstSuccess<string>(
      [() => Promise.resolve('一号'), () => never<string>()],
      { perAttemptMs: 100, totalBudgetMs: 1000 },
    );

    expect(result).toMatchObject({ kind: 'success', winner: '一号', position: 0 });
    // 后续候选压根不该被发出 —— 每个多发的请求都是一次真实的花费
    expect(result.attemptsStarted).toBe(1);
  });

  it('第一个候选超时后改用第二个', async () => {
    const result = await raceFirstSuccess<string>(
      [() => never<string>(), () => Promise.resolve('二号')],
      {
        perAttemptMs: 30,
        totalBudgetMs: 1000,
      },
    );

    expect(result).toMatchObject({ kind: 'success', winner: '二号', position: 1 });
    expect(result.attemptsStarted).toBe(2);
  });

  it('第一个候选在第二个已发出之后才返回，仍然采用第一个', async () => {
    /*
     * 这一条就是「监听前面超时的模型」。超时只意味着「不再等它、去试下一个」，
     * 不意味着「放弃它的结果」—— 那次调用的钱已经花了，产物只要回来就该用。
     */
    const first = deferred<string>();
    const started: number[] = [];

    const attempts: readonly Attempt<string>[] = [
      () => {
        started.push(0);
        return first.promise;
      },
      () => {
        started.push(1);
        return never<string>();
      },
    ];

    const race = raceFirstSuccess(attempts, { perAttemptMs: 30, totalBudgetMs: 1000 });

    // 等到第二个候选确实已经被发出
    await sleep(60);
    expect(started).toEqual([0, 1]);

    // 此刻第一个才姗姗来迟
    first.resolve('迟到的一号');

    const result = await race;
    expect(result).toMatchObject({ kind: 'success', winner: '迟到的一号', position: 0 });
  });

  it('候选立刻失败时不等满超时就切下一个', async () => {
    /*
     * 快速失败（连接被拒、4xx、模型名不存在）与超时是两回事：
     * 前者已经有确定答案，再等 40 秒纯属浪费用户的时间。
     */
    const startedAt = Date.now();
    const result = await raceFirstSuccess<string>(
      [() => Promise.reject(new Error('模型名不存在')), () => Promise.resolve('二号')],
      { perAttemptMs: 5000, totalBudgetMs: 10_000 },
    );

    expect(result).toMatchObject({ kind: 'success', winner: '二号', position: 1 });
    // 远小于 perAttemptMs：没有为已经确定失败的候选白等
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('全部候选都超时时返回 failed，并 abort 所有在途请求', async () => {
    const signals: AbortSignal[] = [];
    const attempts: readonly Attempt<string>[] = [
      (signal) => {
        signals.push(signal);
        return never<string>();
      },
      (signal) => {
        signals.push(signal);
        return never<string>();
      },
    ];

    const result = await raceFirstSuccess(attempts, { perAttemptMs: 20, totalBudgetMs: 70 });

    expect(result.kind).toBe('failed');
    expect(signals).toHaveLength(2);
    /*
     * 不 abort 的话，被放弃的请求会继续占着连接与供应商侧的算力直到自己结束 ——
     * 而此刻已经没有任何人在等它的结果了。
     */
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('总预算耗尽后不再发新候选', async () => {
    const started: number[] = [];
    const attempts: readonly Attempt<string>[] = [0, 1, 2, 3].map((index) => () => {
      started.push(index);
      return never<string>();
    });

    const result = await raceFirstSuccess(attempts, { perAttemptMs: 30, totalBudgetMs: 75 });

    expect(result.kind).toBe('failed');
    /*
     * 75ms 的总预算除以 30ms 的单候选超时，只够发出 3 个（第 3 个在 60ms 处
     * 发出，到 75ms 时预算耗尽）。第 4 个不该被发出 —— 总预算是硬上限，
     * 它存在的意义就是让「候选数 × 单候选超时」不会突破任务级的时间约束。
     */
    expect(started.length).toBeLessThanOrEqual(3);
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(result.attemptsStarted).toBe(started.length);
  });

  it('单候选时不引入额外延迟，等价于直接 await', async () => {
    /*
     * 图像的标准用户档就是单候选（本轮决策 5）。这一条保证「默认路径零开销」：
     * 调度器不该为只有一个候选的情形加任何等待。
     */
    const startedAt = Date.now();
    const result = await raceFirstSuccess<string>([() => sleep(20).then(() => '唯一')], {
      perAttemptMs: 5000,
      totalBudgetMs: 10_000,
    });

    expect(result).toMatchObject({ kind: 'success', winner: '唯一', position: 0 });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('全部候选立刻失败时，errors 保留每一个原因', async () => {
    const result = await raceFirstSuccess<string>(
      [() => Promise.reject(new Error('一号挂了')), () => Promise.reject(new Error('二号也挂了'))],
      { perAttemptMs: 1000, totalBudgetMs: 5000 },
    );

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      /*
       * 保留全部原因而不只是最后一个：排查时要看的恰恰是「是不是每个都因为
       * 同一个理由失败」—— 那说明问题在我们这边（请求体、凭据），
       * 而各自不同的失败更像是上游各自的问题。
       */
      expect(result.errors).toHaveLength(2);
      expect(String(result.errors[0])).toContain('一号挂了');
      expect(String(result.errors[1])).toContain('二号也挂了');
    }
  });

  it('候选列表为空时直接返回 failed，不抛错', async () => {
    const result = await raceFirstSuccess<string>([], { perAttemptMs: 100, totalBudgetMs: 1000 });

    expect(result).toMatchObject({ kind: 'failed', attemptsStarted: 0 });
  });

  it('反证：朴素 Promise.race 会被第一个失败击穿，因此不能用它实现', async () => {
    /*
     * `waitForSuccess` 里那段「摘掉失败的候选再继续 race 剩下的」看起来啰嗦，
     * 很容易在重构时被简化成一行 Promise.race。这条测试把简化后的行为固定成
     * 可执行的断言，而不是只写在注释里。
     *
     * 差别是实质的：一个 4xx 的候选会让朴素实现整条链失败，
     * 而正确实现会继续用其余候选。
     */
    const slowButFine = deferred<string>();
    const attempts: readonly Attempt<string>[] = [
      () => Promise.reject(new Error('模型名不存在')),
      () => slowButFine.promise,
    ];

    // 朴素实现：把所有候选交给 Promise.race
    const naive = Promise.race(attempts.map((attempt) => attempt(new AbortController().signal)));
    await expect(naive).rejects.toThrow('模型名不存在');

    // 同样的输入，本模块拿到的是第二个候选的产物
    slowButFine.resolve('二号的产物');
    const result = await raceFirstSuccess(attempts, { perAttemptMs: 50, totalBudgetMs: 1000 });
    expect(result).toMatchObject({ kind: 'success', winner: '二号的产物', position: 1 });
  });
});

describe('FailoverImageClient', () => {
  const request = {
    prompt: '杭州西湖',
    negativePrompt: 'no text',
    width: 1600,
    height: 600,
    seed: 42,
    timeoutMs: 40_000,
  };

  function stubImage(model: string, behaviour: (signal?: AbortSignal) => Promise<ImageResult>) {
    return { model, generate: (req: ImageRequest) => behaviour(req.signal) };
  }

  function imageResult(model: string): ImageResult {
    return {
      bytes: new Uint8Array([1]),
      model,
      modelVersion: model,
      seed: 42,
      costUnits: 1,
    };
  }

  it('单候选时不包装，直接返回底层客户端', () => {
    const only = stubImage('solo', () => Promise.resolve(imageResult('solo')));
    const client = wrapImageFailover([only], { perAttemptMs: 100, totalBudgetMs: 200 });

    // 图像标准用户档就是单候选，默认路径必须零开销
    expect(client).toBe(only);
  });

  it('候选 1 超时后用候选 2，回传的 model 是候选 2 的名字', async () => {
    const client = wrapImageFailover(
      [
        stubImage('慢模型', () => new Promise<ImageResult>(() => undefined)),
        stubImage('快模型', () => Promise.resolve(imageResult('快模型'))),
      ],
      { perAttemptMs: 30, totalBudgetMs: 500 },
    );

    const result = await client.generate(request);
    /*
     * model 必须是真正产出这张图的那个 —— 二十章要求 generation_metadata
     * 如实记录模型。回传主候选的名字会让「哪个模型画的」这个问题永久答错。
     */
    expect(result.model).toBe('快模型');
  });

  it('costUnits 记实际发出的请求数，不是 1', async () => {
    /*
     * 本轮决策 4：日预算按实际发出的请求数计。超时的那个候选供应商很可能
     * 已经生成完并计了费，只记 1 会让 600 的熔断阈值失去意义。
     */
    const client = wrapImageFailover(
      [
        stubImage('慢模型', () => new Promise<ImageResult>(() => undefined)),
        stubImage('快模型', () => Promise.resolve(imageResult('快模型'))),
      ],
      { perAttemptMs: 30, totalBudgetMs: 500 },
    );

    const result = await client.generate(request);
    expect(result.costUnits).toBe(2);
  });

  it('胜出者报 0 时仍是 0 —— 假实现不该混进成本报表', async () => {
    /*
     * `FakeImageClient` 用 costUnits = 0 表示「这次调用不花钱」。改写成
     * attemptsStarted 会让本地与 CI 的调用计入 21.4 的日预算，
     * 于是 600 的熔断会在开发环境毫无意义地打开。
     */
    const free = (model: string) => ({ ...imageResult(model), costUnits: 0 });
    const client = wrapImageFailover(
      [
        stubImage('慢模型', () => new Promise<ImageResult>(() => undefined)),
        stubImage('假模型', () => Promise.resolve(free('假模型'))),
      ],
      { perAttemptMs: 30, totalBudgetMs: 500 },
    );

    expect((await client.generate(request)).costUnits).toBe(0);
  });

  it('全部候选失败时抛 ImageUnavailableError', async () => {
    const client = wrapImageFailover(
      [
        stubImage('一号', () => Promise.reject(new Error('挂了'))),
        stubImage('二号', () => Promise.reject(new Error('也挂了'))),
      ],
      { perAttemptMs: 100, totalBudgetMs: 500 },
    );

    await expect(client.generate(request)).rejects.toThrow(ImageUnavailableError);
  });

  it('把外部 signal 透传给候选，胜出后其余被 abort', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const client = wrapImageFailover(
      [
        stubImage('慢模型', (signal) => {
          seen.push(signal);
          return new Promise<ImageResult>(() => undefined);
        }),
        stubImage('快模型', (signal) => {
          seen.push(signal);
          return Promise.resolve(imageResult('快模型'));
        }),
      ],
      { perAttemptMs: 30, totalBudgetMs: 500 },
    );

    await client.generate(request);

    expect(seen).toHaveLength(2);
    // 没有 signal 的话，被放弃的请求会继续占着上游算力
    expect(seen.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it('onOutcome 回报胜出位次与发出数，供调用方记指标', async () => {
    /*
     * packages/llm 不依赖 @tps/observability（分层），因此指标由调用方上报。
     * position > 0 是「主模型没顶住」的唯一信号。
     */
    const outcomes: { position: number; attemptsStarted: number; ok: boolean }[] = [];
    const client = wrapImageFailover(
      [
        stubImage('慢模型', () => new Promise<ImageResult>(() => undefined)),
        stubImage('快模型', () => Promise.resolve(imageResult('快模型'))),
      ],
      {
        perAttemptMs: 30,
        totalBudgetMs: 500,
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    );

    await client.generate(request);
    expect(outcomes).toEqual([{ position: 1, attemptsStarted: 2, ok: true }]);
  });
});
