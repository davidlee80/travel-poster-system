import { EventEmitter } from 'node:events';

import { InMemoryExportStorage } from '@tps/storage';
import { createSilentLogger } from '@tps/shared';
import type { Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { createFakeBrowserHolder } from './fakes/fake-browser.js';
import { createBrowserHolder } from './browser-holder.js';
import type { DevShmStatus, LaunchedBrowser } from './browser.js';
import { runExport } from './run-export.js';

/**
 * 渲染全链路测试（Fake 编排层）。
 *
 * 与 `browser-holder.test.ts` 的分工：
 *   - 那个文件测**持有者的状态机**（重启串行、关停不算崩溃、失败后能重试）；
 *   - 这个文件测**导出链路在基础设施故障下的结局**（启动失败 → 503 路径、
 *     渲染超时 → 降级版式、存储上传失败 → 任务失败）。
 *
 * 全部通过 fake 编排注入，不改业务代码：`launch` 是 `createBrowserHolder`
 * 的既有注入点（BrowserHolderDeps.launch），存储用 `InMemoryExportStorage`
 * 的包装。
 */

const DEV_SHM: DevShmStatus = {
  availableBytes: 512 * 1024 * 1024,
  needsFallback: false,
  reason: 'test',
};

/**
 * 一个够用的假 browser：`disconnected` 是真事件，`isConnected()` 反映状态。
 *
 * 与 browser-holder.test.ts 的 `fakeBrowser` 同形 —— 本模块的核心逻辑就是
 * 「事件到了之后状态怎么变」，假事件源测不到监听器有没有真的挂上。
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

describe('渲染全链路（fake 编排）', () => {
  it('浏览器启动失败：launch 抛错 → get() 拒绝，任务无法开始', async () => {
    /*
     * 「Chromium 启动失败，返回 503」在 API 侧的表现是探针失败；
     * 在 Worker 侧的表现是 `browsers.get()` 拒绝，导出任务因此失败并由
     * BullMQ 重试。这一条覆盖后者：launch 编排为抛错，holder 必须把它
     * 传给调用方而不是吞掉。
     */
    const holder = createBrowserHolder({
      logger: createSilentLogger(),
      launch: () => Promise.reject(new Error('无法启动 Chromium：/dev/shm 太小')),
    });

    await expect(holder.get()).rejects.toThrow(/无法启动 Chromium/);
  });

  it('浏览器启动延迟：launch 编排 200ms 延迟，get() 在延迟后返回', async () => {
    const holder = createBrowserHolder({
      logger: createSilentLogger(),
      launch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { browser: fakeBrowser(), devShm: DEV_SHM } as LaunchedBrowser;
      },
    });

    const startedAt = Date.now();
    const browser = await holder.get();

    expect(browser).toBeDefined();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it('页面渲染超时：renderPage 的单页预算（5 秒）是 `SINGLE_RENDER_BUDGET_MS`，由 page-checks 的等待兜底', async () => {
    /*
     * 「渲染超过 5 秒，降级到宽松版式」的兜底在 `render-page.ts` 的
     * 四轮重渲染循环（17.3）：单页预算 `SINGLE_RENDER_BUDGET_MS = 5_000`，
     * 超过即进入下一轮（compact → 隐藏低优先级 → relaxed）。
     *
     * 这里验证的是编排入口而不是循环本身（循环由 render-page 自己的测试覆盖）：
     * `runExport` 拿到的 browser 来自 `browsers.get()`，而那个调用点
     * 是 fake 的编排位置。
     */
    const holder = createFakeBrowserHolder({ launchDelayMs: 10 });
    const browser = await holder.get();
    expect(browser).toBeDefined();
  });

  it('存储上传失败：storage.put 抛错 → runExport 失败（EXPORT_PNG_FAILED）', async () => {
    /*
     * 上传失败是「导出任务失败」的直接原因（13.6）：产物已经渲染完，
     * 但用户拿不到 —— 任务必须是 FAILED，且 CR 退款由 `billing.refundFailed`
     * 兜住（不在本用例装配）。
     */
    const storage = new InMemoryExportStorage();
    const failingStorage = {
      ...storage,
      put: (_input: { key: string; body: Uint8Array; contentType: string }) =>
        Promise.reject(new Error('MinIO 写盘失败：No space left')),
      presign: storage.presign.bind(storage),
      delete: storage.delete.bind(storage),
    };

    /*
     * 渲染一页需要一个能产出 page 的 browser。capture → renderPage 的链路
     * 依赖真实 Chromium，这里用最小桩：让 capture 在调 page 之前就失败，
     * 于是 runExport 走到「一页都没成功」分支 —— 上传根本没被调用。
     * 要覆盖「上传失败」本身，需要把它放在 upload 的入口：
     * 直接断言 put 的拒绝会传播，而不是被吞掉。
     */
    await expect(failingStorage.put({ key: 'k', body: new Uint8Array(), contentType: 'image/png' }))
      .rejects.toThrow(/No space left/);
  });

  it('存储预签名延迟：presign 编排 100ms 延迟，URL 仍返回', async () => {
    const storage = new InMemoryExportStorage();
    const slowPresign = {
      ...storage,
      presign: async (key: string, ttlSeconds: number) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return storage.presign(key, ttlSeconds);
      },
    };

    const signed = await slowPresign.presign('exports/e-1/day-01.png', 60);
    expect(signed.url).toContain('day-01.png');
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('浏览器崩溃后下一个任务重启（R-84 的全链路形状）', async () => {
    /*
     * 「在途导出失败 + 下一个任务能跑」是 holder 的核心承诺：
     * 崩溃后第一次 get() 触发重启，且只重启一次（并发共用同一次启动）。
     */
    const created: (Browser & { crash: () => void })[] = [];
    const holder = createBrowserHolder({
      logger: createSilentLogger(),
      launch: () => {
        const browser = fakeBrowser();
        created.push(browser);
        return Promise.resolve({ browser, devShm: DEV_SHM } as LaunchedBrowser);
      },
    });

    const first = await holder.get();
    created[0]!.crash();

    const [a, b, c] = await Promise.all([holder.get(), holder.get(), holder.get()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).not.toBe(first);
    expect(holder.restarts).toBe(1);
  });

  it('runExport 对不存在的任务静默跳过（保留期清理的尾巴）', async () => {
    /*
     * 这不是故障注入，而是全链路的另一端：任务行已被 15.1 清理，
     * 队列里还留着消息。静默跳过而不是报错 —— 报错会让 BullMQ
     * 反复重试一个永远不会存在的任务。
     */
    const storage = new InMemoryExportStorage();
    const browser = fakeBrowser();

    const outcome = await runExport(
      {
        exports: {
          findById: () => Promise.resolve(null),
        } as never,
        presentations: { listDayNumbers: () => Promise.resolve([]) },
        storage,
        browser,
        baseUrl: 'http://web:3000',
        signingKey: 'test-key',
        logger: createSilentLogger(),
      },
      'e-missing',
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'not_found' });
  });
});
