import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from './logger.js';
import { GracefulShutdown } from './shutdown.js';

const silentLogger = createSilentLogger();

/** 用抛错替代 process.exit，让测试能观察退出码而不真的退出进程 */
function makeExit(): { exit: (code: number) => never; codes: number[] } {
  const codes: number[] = [];
  const exit = ((code: number) => {
    codes.push(code);
    throw new Error(`__exit_${code}__`);
  }) as (code: number) => never;
  return { exit, codes };
}

async function expectExit(
  promise: Promise<unknown>,
  codes: number[],
  expected: number,
): Promise<void> {
  await expect(promise).rejects.toThrow(`__exit_${expected}__`);
  expect(codes).toEqual([expected]);
}

describe('GracefulShutdown', () => {
  it('按注册的逆序执行钩子（组件先停，基础设施后停）', async () => {
    const order: string[] = [];
    const { exit, codes } = makeExit();

    const sd = new GracefulShutdown({ logger: silentLogger, exit });
    sd.register('db', () => void order.push('db'));
    sd.register('redis', () => void order.push('redis'));
    sd.register('http', () => void order.push('http'));

    await expectExit(sd.shutdown('test'), codes, 0);

    expect(order).toEqual(['http', 'redis', 'db']);
  });

  it('进入排空状态后就绪探针应能感知', async () => {
    const { exit, codes } = makeExit();
    const sd = new GracefulShutdown({ logger: silentLogger, exit });

    expect(sd.isDraining).toBe(false);
    await expectExit(sd.shutdown('test'), codes, 0);
    expect(sd.isDraining).toBe(true);
  });

  it('单个钩子抛错不阻断其余钩子，但退出码为 1', async () => {
    const order: string[] = [];
    const { exit, codes } = makeExit();

    const sd = new GracefulShutdown({ logger: silentLogger, exit });
    sd.register('db', () => void order.push('db'));
    sd.register('broken', () => {
      throw new Error('boom');
    });
    sd.register('http', () => void order.push('http'));

    await expectExit(sd.shutdown('test'), codes, 1);

    // broken 抛错，但 db 仍被执行 —— 否则连接池会泄漏
    expect(order).toEqual(['http', 'db']);
  });

  it('超时后强制退出，退出码为 1', async () => {
    const { exit, codes } = makeExit();

    const sd = new GracefulShutdown({ logger: silentLogger, timeoutMs: 20, exit });
    sd.register(
      'hang',
      () =>
        new Promise<void>(() => {
          /* 永不 resolve */
        }),
    );

    await expectExit(sd.shutdown('test'), codes, 1);
  });

  it('重复触发是幂等的，钩子只执行一次', async () => {
    const hook = vi.fn();
    const { exit } = makeExit();

    const sd = new GracefulShutdown({ logger: silentLogger, exit });
    sd.register('once', hook);

    const first = sd.shutdown('signal-1').catch(() => undefined);
    const second = sd.shutdown('signal-2').catch(() => undefined);
    await Promise.all([first, second]);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('等待异步钩子真正完成后才退出', async () => {
    let finished = false;
    const { exit, codes } = makeExit();

    const sd = new GracefulShutdown({ logger: silentLogger, exit });
    sd.register('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });

    await expectExit(sd.shutdown('test'), codes, 0);
    expect(finished).toBe(true);
  });
});
