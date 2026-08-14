import type { Logger } from 'pino';

/**
 * 优雅停机框架（TP-0-08，设计稿 22.3.3、L-10、验收门禁 #34）。
 *
 * 为什么必须在 P0 就做：Worker 收到 SIGTERM 若直接退出，正在处理的任务会把
 * generation_jobs 留在 RENDERING_HTML 之类的中间态上悬挂 —— 既不是终态也不会
 * 被重新消费。K8s 滚动更新每次都会触发 SIGTERM，这不是异常路径而是常规路径。
 *
 * 关闭顺序（先停入口，后停出口）：
 *   1. draining = true —— 就绪探针立刻返回 not_ready，负载均衡摘掉本实例
 *   2. 按注册的逆序执行 hook（后注册的先关，即依赖方先于被依赖方）
 *   3. 全部完成或超时后退出
 *
 * Chromium 会产生僵尸子进程，容器必须以 tini/--init 作为 PID 1（见 Dockerfile），
 * 否则本模块正常退出后仍会残留子进程。
 */

export type ShutdownHook = () => Promise<void> | void;

export interface ShutdownOptions {
  readonly logger: Logger;
  /**
   * 从收到信号到强制退出的总预算。
   * 必须小于 K8s terminationGracePeriodSeconds，否则会被 SIGKILL 打断而来不及收尾。
   */
  readonly timeoutMs?: number;
  /** 供测试注入；生产使用 process.exit */
  readonly exit?: (code: number) => never;
}

interface RegisteredHook {
  readonly name: string;
  readonly hook: ShutdownHook;
}

export class GracefulShutdown {
  private readonly hooks: RegisteredHook[] = [];
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly exit: (code: number) => never;

  private draining = false;
  private shutdownPromise: Promise<number> | null = null;

  constructor(options: ShutdownOptions) {
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.exit = options.exit ?? ((code: number) => process.exit(code));
  }

  /**
   * 注册关闭钩子。执行顺序为注册顺序的逆序 ——
   * 先注册基础设施（数据库、Redis），后注册使用它们的组件（HTTP 服务、Worker），
   * 关闭时组件先停、基础设施后停，避免组件还在用连接就被断开。
   */
  register(name: string, hook: ShutdownHook): this {
    this.hooks.push({ name, hook });
    return this;
  }

  /** 就绪探针据此返回 503：正在排空的实例不应再接收新流量 */
  get isDraining(): boolean {
    return this.draining;
  }

  /** 监听 SIGTERM / SIGINT。SIGKILL 无法捕获，因此超时预算必须留足。 */
  listen(): this {
    const onSignal = (signal: NodeJS.Signals): void => {
      void this.shutdown(signal);
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    process.on('unhandledRejection', (reason) => {
      this.logger.error(
        { err: reason, reason_code: 'UNHANDLED_REJECTION' },
        '未处理的 Promise 拒绝',
      );
      void this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err, reason_code: 'UNCAUGHT_EXCEPTION' }, '未捕获异常');
      void this.shutdown('uncaughtException');
    });

    return this;
  }

  /** 幂等：重复信号不会触发第二轮关闭 */
  async shutdown(trigger: string): Promise<number> {
    if (this.shutdownPromise) {
      this.logger.warn({ trigger }, '关闭已在进行中，忽略重复触发');
      return this.shutdownPromise;
    }

    this.draining = true;
    this.shutdownPromise = this.run(trigger);
    const code = await this.shutdownPromise;
    this.exit(code);
  }

  private async run(trigger: string): Promise<number> {
    const startedAt = process.hrtime.bigint();
    this.logger.info(
      { trigger, hook_count: this.hooks.length, timeout_ms: this.timeoutMs },
      '开始优雅停机',
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      timer.unref();
    });

    const outcome = await Promise.race([this.runHooks(), timeout]);
    if (timer) clearTimeout(timer);

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    if (outcome === 'timeout') {
      this.logger.error(
        { trigger, elapsed_ms: elapsedMs, reason_code: 'SHUTDOWN_TIMEOUT' },
        '停机超时，强制退出',
      );
      return 1;
    }

    const failed = outcome.filter((r) => !r.ok);
    if (failed.length > 0) {
      this.logger.error(
        {
          trigger,
          elapsed_ms: elapsedMs,
          failed: failed.map((f) => f.name),
          reason_code: 'SHUTDOWN_HOOK_FAILED',
        },
        '部分关闭钩子失败',
      );
      return 1;
    }

    this.logger.info({ trigger, elapsed_ms: elapsedMs }, '优雅停机完成');
    return 0;
  }

  private async runHooks(): Promise<{ name: string; ok: boolean }[]> {
    const results: { name: string; ok: boolean }[] = [];

    // 逆序执行：后注册的先关
    for (let i = this.hooks.length - 1; i >= 0; i -= 1) {
      const entry = this.hooks[i];
      if (!entry) continue;

      const { name, hook } = entry;
      try {
        await hook();
        this.logger.debug({ hook: name }, '关闭钩子完成');
        results.push({ name, ok: true });
      } catch (err) {
        // 单个钩子失败不中断其余钩子 —— 否则一个连接池关不掉会导致其他资源全部泄漏
        this.logger.error({ err, hook: name }, '关闭钩子抛错');
        results.push({ name, ok: false });
      }
    }

    return results;
  }
}
