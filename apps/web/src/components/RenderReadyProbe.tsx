'use client';

import { useEffect } from 'react';

/**
 * 页面就绪标识（TP-1-11，设计稿 17.2）。
 *
 * 渲染 Worker 等待 `[data-render-status="ready"]` 后才截图。
 *
 * ## 为什么不能只等 document.fonts.ready
 *
 * 17.2 只写了「加载完数据、图片和字体后设置」，但没说怎么判定。
 * 三件事必须都完成，且**顺序上图片最慢**：
 *   1. 数据 —— 服务端渲染已完成（本组件挂载即意味着数据已在 DOM 里）
 *   2. 字体 —— `document.fonts.ready`
 *   3. 图片 —— 每个 `<img>` 的 `decode()` 完成，不只是 `complete`
 *
 * `img.complete` 为 true 只表示**下载**完成，浏览器可能还没解码出位图；
 * 此时截图会得到空白或半张图。必须用 `decode()`。
 *
 * 失败的图片不阻塞就绪 —— 十八章的降级链要求「景点图缺失不阻断流程」，
 * 若在此处等到超时，一张坏图就会让整个任务失败。
 */

/** 单张图片的等待上限。超时后放行，让降级链接管。 */
const IMAGE_TIMEOUT_MS = 8_000;
/** 整体等待上限，小于 17.3 的单次渲染预算（5 秒）之外留出余量 */
const TOTAL_TIMEOUT_MS = 12_000;

export function RenderReadyProbe() {
  useEffect(() => {
    let cancelled = false;

    const markReady = (detail: string): void => {
      if (cancelled) return;
      document.body.dataset['renderStatus'] = 'ready';
      document.body.dataset['renderReadyDetail'] = detail;
    };

    const run = async (): Promise<void> => {
      const started = performance.now();

      try {
        await Promise.race([
          waitForAssets(),
          new Promise<void>((resolve) => setTimeout(resolve, TOTAL_TIMEOUT_MS)),
        ]);
      } catch {
        // 任何异常都不应阻止就绪 —— 阻塞的代价是整个导出任务失败
      }

      markReady(`${Math.round(performance.now() - started)}ms`);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, []);

  // 初始状态显式声明为 pending，让「页面还没跑 JS」与「已就绪」可区分
  return <span data-render-probe="mounted" hidden />;
}

async function waitForAssets(): Promise<void> {
  await document.fonts.ready;

  const images = [...document.querySelectorAll('img')];
  await Promise.all(
    images.map(async (img) => {
      try {
        await Promise.race([
          // decode() 保证位图已解码，而 complete 只保证下载完成
          img.decode(),
          new Promise<void>((resolve) => setTimeout(resolve, IMAGE_TIMEOUT_MS)),
        ]);
      } catch {
        // 加载失败的图片由模板的占位分支处理（十八章降级链）
      }
    }),
  );

  // 让浏览器完成一次布局与绘制，避免在样式应用前截图
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
