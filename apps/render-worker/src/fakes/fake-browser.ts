import type { Browser } from 'playwright-core';
import type { BrowserHolder } from '../browser-holder.js';
import type { LaunchedBrowser } from '../browser.js';

/**
 * Fake 浏览器实现。
 *
 * 用于测试：模拟浏览器启动/渲染的延迟与故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **延迟模拟**：`launchDelayMs` 模拟启动慢，`renderDelayMs` 模拟渲染慢；
 * - **故障模拟**：`launchError` 模拟启动失败，`renderError` 模拟渲染失败。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`apps/render-worker/src/browser-holder.ts`）会：
 * 1. 调用 `chromium.launch` 启动浏览器；
 * 2. 监听 `disconnected` 事件；
 * 3. 管理重启逻辑。
 *
 * Fake 实现**不执行**这些操作，只返回预置的浏览器或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖 Chromium，不依赖系统资源。
 */
export interface FakeBrowserBehavior {
  /** 启动延迟毫秒数 */
  readonly launchDelayMs?: number;
  /** 渲染延迟毫秒数 */
  readonly renderDelayMs?: number;
  /** 启动故障 */
  readonly launchError?: Error;
  /** 渲染故障 */
  readonly renderError?: Error;
}

/**
 * 创建 Fake 浏览器持有者。
 */
export function createFakeBrowserHolder(behavior: FakeBrowserBehavior): BrowserHolder {
  let current: Browser | null = null;
  let restarts = 0;

  return {
    async get(): Promise<Browser> {
      if (behavior.launchError) {
        throw behavior.launchError;
      }

      if (behavior.launchDelayMs !== undefined && behavior.launchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.launchDelayMs));
      }

      if (current === null) {
        // 创建一个最小的 fake browser 对象
        current = {
          isConnected: () => true,
          close: async () => {},
          on: () => {},
        } as unknown as Browser;
      }

      return current;
    },

    async close(): Promise<void> {
      if (current !== null) {
        await current.close();
        current = null;
      }
    },

    get restarts() {
      return restarts;
    },

    get devShm() {
      return null;
    },
  };
}

/**
 * 包装 `BrowserHolderDeps.launch`，注入编排行为。
 */
export function wrapBrowserLaunch(
  launch: () => Promise<LaunchedBrowser>,
  behavior: FakeBrowserBehavior,
): () => Promise<LaunchedBrowser> {
  return async () => {
    if (behavior.launchError) {
      throw behavior.launchError;
    }

    if (behavior.launchDelayMs !== undefined && behavior.launchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behavior.launchDelayMs));
    }

    return launch();
  };
}
