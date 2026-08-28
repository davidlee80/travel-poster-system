import type { Browser } from 'playwright-core';
import type { Logger } from '@tps/shared';

import { launchBrowser, type DevShmStatus, type LaunchedBrowser } from './browser.js';
import { browserRestartTotal } from './render-metrics.js';

/**
 * Browser 的持有者：断开后自愈（R-84）。
 *
 * ## 修的是什么
 *
 * 21.2 的渲染模型是「1 browser + 3 page」，browser 在进程启动时启一次、关停时
 * 关一次。中间它若崩溃（一个 14 天信息图页面 OOM 掉 Chromium 是现实场景），
 * 那个句柄从此是死的 —— 三个在途导出一起失败，而**后续每一个导出也都失败**，
 * 直到有人重启进程。原先没有任何 `disconnected` 处理、`isConnected` 检查或重启。
 *
 * ## 为什么是「任务开始时懒检查」而不是事件驱动的立刻重启
 *
 * 崩溃发生在渲染中途时，那一次导出无论如何都救不回来（page 已经没了）。
 * 真正需要的是**下一个任务能跑**，因此在取 browser 时检查并重启就够了，
 * 失败的那次交给 BullMQ 重试。
 *
 * `disconnected` 事件仍然监听，但只用于**记账**：不记的话「浏览器崩过几次」
 * 无人知道，而那正是判断「是不是该调大 /dev/shm 或降并发」的依据。
 *
 * ## 重启必须串行
 *
 * concurrency 是 3，崩溃后三个任务会同时来取。不串行的话会启起三个 Chromium，
 * 而每个约 400MB —— 在容器内存上限下这是从「崩一次」变成「反复 OOM」。
 */

export interface BrowserHolder {
  /** 取一个可用的 browser。已断开时先重启；并发调用共用同一次重启 */
  get(): Promise<Browser>;
  /** 关停。之后 `get()` 一律抛错，且不再自动重启 */
  close(): Promise<void>;
  /** 重启次数（不含首次启动），供测试与日志断言 */
  readonly restarts: number;
  /**
   * 最近一次启动的 `/dev/shm` 探测结果。未启动过时为 null。
   *
   * 启动日志要报它（TP-1-18）：它告诉你 `--disable-dev-shm-usage` 有没有被
   * 加上，而那直接影响渲染稳定性。重启后它会被刷新 —— 如果一次重启后
   * 这个值变了，那本身就是个线索。
   */
  readonly devShm: DevShmStatus | null;
}

export interface BrowserHolderDeps {
  readonly logger: Logger;
  /** 注入点：测试用假实现，生产用 `launchBrowser` */
  readonly launch?: () => Promise<LaunchedBrowser>;
}

export function createBrowserHolder(deps: BrowserHolderDeps): BrowserHolder {
  const launch = deps.launch ?? launchBrowser;

  let current: Browser | null = null;
  /** 在途的启动。并发的 `get()` 共用它，因此不会启起多个 Chromium */
  let launching: Promise<Browser> | null = null;
  let closed = false;
  let launchedOnce = false;
  let restarts = 0;
  let devShm: DevShmStatus | null = null;

  function attachDisconnectHandler(browser: Browser): void {
    browser.on('disconnected', () => {
      /*
       * 关停时 `browser.close()` 也会触发这个事件。此时不记账也不重启 ——
       * 把正常关停记成一次崩溃会让「崩溃次数」这个指标每次部署都 +1，
       * 于是它再也无法用来判断真实的稳定性。
       */
      if (closed) return;

      current = null;
      deps.logger.error(
        { reason_code: 'BROWSER_DISCONNECTED' },
        'Chromium 断开连接（多为页面 OOM）。在途导出会失败并由队列重试，下一个任务会触发重启',
      );
    });
  }

  async function ensure(): Promise<Browser> {
    if (launching !== null) return launching;

    const isRestart = launchedOnce;
    launching = (async () => {
      /*
       * 不解构成局部 `devShm` —— 那会遮蔽外层同名变量，于是 getter
       * 永远返回 null，而启动日志里那一项会变成 undefined。
       */
      const launched = await launch();
      attachDisconnectHandler(launched.browser);
      current = launched.browser;
      devShm = launched.devShm;

      if (isRestart) {
        restarts += 1;
        browserRestartTotal.inc({ reason_code: 'BROWSER_DISCONNECTED' });
        deps.logger.warn(
          { reason_code: 'BROWSER_RESTARTED', dev_shm: launched.devShm.reason },
          `Chromium 已重启（累计 ${restarts} 次）。反复重启说明内存不足：先看 /dev/shm 与容器上限，再考虑降并发`,
        );
      }

      launchedOnce = true;
      return launched.browser;
    })();

    try {
      return await launching;
    } finally {
      /*
       * 无论成败都清空在途标记。失败时清空是必要的 —— 不清的话
       * 一次瞬时启动失败会让这个持有者永久返回同一个 rejected promise，
       * 表现是「重启过一次之后再也起不来」。
       */
      launching = null;
    }
  }

  return {
    async get() {
      if (closed) throw new Error('BrowserHolder 已关停');

      // `isConnected()` 是同步的本地状态检查，不发协议消息，因此每任务调一次没有代价
      if (current !== null && current.isConnected()) return current;
      return ensure();
    },

    async close() {
      closed = true;
      const browser = current;
      current = null;
      if (browser !== null && browser.isConnected()) await browser.close();
    },

    get restarts() {
      return restarts;
    },

    get devShm() {
      return devShm;
    },
  };
}
