import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright-core';
import { createSilentLogger } from '@tps/shared';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserHolder } from './browser-holder.js';
import type { DevShmStatus, LaunchedBrowser } from './browser.js';

/**
 * Browser 自愈（R-84）。
 *
 * ## 不测会怎样
 *
 * 21.2 的渲染模型是「1 browser + 3 page」，而崩溃后那个句柄从此是死的 ——
 * 原先没有任何检查或重启，表现是**后续每一个导出都失败**，直到有人重启进程。
 * 这几条断言把三件容易写错的事钉住：
 *
 *   1. **重启必须串行**：concurrency 是 3，崩溃后三个任务同时来取。启起三个
 *      Chromium（每个约 400MB）会把「崩一次」变成「反复 OOM」；
 *   2. **关停不能算崩溃**：`browser.close()` 也触发 `disconnected`，把它记成
 *      崩溃会让那个指标每次部署都 +1，从此无法判断真实稳定性；
 *   3. **启动失败后还能重试**：不清在途标记的话，一次瞬时失败会让持有者
 *      永久返回同一个 rejected promise，表现是「重启过一次之后再也起不来」。
 */

const DEV_SHM: DevShmStatus = {
  availableBytes: 512 * 1024 * 1024,
  needsFallback: false,
  reason: 'test',
};

/**
 * 一个够用的假 browser：`disconnected` 是真事件，`isConnected()` 反映状态。
 *
 * 用 EventEmitter 而不是 `vi.fn()` 拼一个：本模块的核心逻辑就是「事件到了之后
 * 状态怎么变」，而假事件源测不到监听器有没有真的挂上。
 */
function fakeBrowser(): Browser & { crash: () => void } {
  const emitter = new EventEmitter();
  let connected = true;

  const browser = {
    on: (event: string, handler: () => void) => emitter.on(event, handler),
    isConnected: () => connected,
    close: () => {
      connected = false;
      emitter.emit('disconnected');
      return Promise.resolve();
    },
    crash: () => {
      connected = false;
      emitter.emit('disconnected');
    },
  };

  return browser as unknown as Browser & { crash: () => void };
}

function harness(options: { readonly failFirst?: boolean } = {}) {
  const created: (Browser & { crash: () => void })[] = [];
  let calls = 0;

  const launch = (): Promise<LaunchedBrowser> => {
    calls += 1;
    if (options.failFirst === true && calls === 1) {
      return Promise.reject(new Error('拉不起 Chromium'));
    }
    const browser = fakeBrowser();
    created.push(browser);
    return Promise.resolve({ browser, devShm: DEV_SHM } as LaunchedBrowser);
  };

  return {
    created,
    get launchCalls() {
      return calls;
    },
    holder: createBrowserHolder({ logger: createSilentLogger(), launch }),
  };
}

describe('createBrowserHolder', () => {
  it('首次 get 启动一次，重复 get 复用同一个实例', async () => {
    const h = harness();

    const first = await h.holder.get();
    const second = await h.holder.get();

    expect(first).toBe(second);
    expect(h.launchCalls).toBe(1);
    expect(h.holder.restarts).toBe(0);
  });

  it('崩溃后下一次 get 重启，且 restarts 计数增加', async () => {
    const h = harness();
    const first = await h.holder.get();

    h.created[0]!.crash();

    const second = await h.holder.get();
    expect(second).not.toBe(first);
    expect(h.launchCalls).toBe(2);
    expect(h.holder.restarts).toBe(1);
  });

  it('崩溃后三个并发 get 只重启一次（concurrency 是 3）', async () => {
    /*
     * 这是本模块存在的主要理由。不串行的话会启起三个 Chromium，
     * 而每个约 400MB —— 在容器内存上限下这是从「崩一次」变成「反复 OOM」。
     */
    const h = harness();
    await h.holder.get();
    h.created[0]!.crash();

    const [a, b, c] = await Promise.all([h.holder.get(), h.holder.get(), h.holder.get()]);

    expect(h.launchCalls).toBe(2);
    expect(h.holder.restarts).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('关停触发的 disconnected 不算崩溃', async () => {
    /*
     * `browser.close()` 也会发 `disconnected`。把正常关停记成一次崩溃会让
     * travel_render_browser_restart_total 每次部署都 +1，
     * 于是它再也无法用来判断真实稳定性。
     */
    const h = harness();
    await h.holder.get();

    await h.holder.close();

    expect(h.holder.restarts).toBe(0);
    expect(h.launchCalls).toBe(1);
  });

  it('关停后 get 抛错，不会再拉起新的 Chromium', async () => {
    /*
     * 关停顺序是 worker.pause → worker.close → browsers.close。若此时还能
     * 重启，一个刚被 pause 拦下的任务会拉起一个没人关的 Chromium，
     * 进程退不干净。
     */
    const h = harness();
    await h.holder.get();
    await h.holder.close();

    await expect(h.holder.get()).rejects.toThrow(/已关停/);
    expect(h.launchCalls).toBe(1);
  });

  it('启动失败后仍可重试（不会永久返回同一个 rejected promise）', async () => {
    const h = harness({ failFirst: true });

    await expect(h.holder.get()).rejects.toThrow(/拉不起/);

    // 第二次必须真的再试一遍，而不是复用上次那个失败的 promise
    const browser = await h.holder.get();
    expect(browser).toBeDefined();
    expect(h.launchCalls).toBe(2);
  });

  it('devShm 暴露最近一次启动的探测结果（启动日志要报它）', async () => {
    const h = harness();
    expect(h.holder.devShm).toBeNull();

    await h.holder.get();
    expect(h.holder.devShm?.reason).toBe('test');
  });

  it('崩溃日志用 error 级别，重启日志用 warn', async () => {
    /*
     * 级别不是随手取的：崩溃是异常（error），而重启是系统在自愈（warn）。
     * 两者都记 error 会让告警噪音上升；都记 warn 会让崩溃在日志里不显眼。
     */
    const error = vi.fn();
    const warn = vi.fn();
    const logger = { ...createSilentLogger(), error, warn };

    let created: (Browser & { crash: () => void }) | null = null;
    const holder = createBrowserHolder({
      logger,
      launch: () => {
        created = fakeBrowser();
        return Promise.resolve({ browser: created, devShm: DEV_SHM } as LaunchedBrowser);
      },
    });

    await holder.get();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    created!.crash();
    expect(error).toHaveBeenCalledOnce();

    await holder.get();
    expect(warn).toHaveBeenCalledOnce();
  });
});
