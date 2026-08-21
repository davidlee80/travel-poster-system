import { RENDER_ROUNDS, variantToQuery, type RenderVariant } from '@tps/presentation';
import type { BrowserContext, Page } from 'playwright-core';

import { CJK_FONT_UNAVAILABLE, RENDER_ERROR_CODES, RenderError } from './errors.js';
import {
  countBrokenImages,
  countMissingIcons,
  detectOverflow,
  probeCjkGlyphs,
  waitForReady,
  type BrokenImageReport,
  type OverflowReport,
} from './page-checks.js';

/**
 * 四轮重渲染循环（TP-1-12，设计稿 17.3）。
 *
 * ```text
 * 第 1 轮：原始 ViewModel
 *   ↓ 有 violations
 * 第 2 轮：*_compact 文案（12.3）
 *   ↓ 仍有
 * 第 3 轮：按 priority 升序隐藏低优先级条目
 *   ↓ 仍有
 * 第 4 轮：relaxed 宽松版式
 *   ↓ 仍有
 * 终止：输出当前产物 + RENDER_OVERFLOW_UNRESOLVED + validation_status = DEGRADED
 * ```
 *
 * V1.0 没写上限。不设上限时病态内容（例如某个字段被塞进 5000 字）会让
 * Worker 在同一个页面上无限重试，把整个渲染队列拖死。
 */

/** 17.3：单次渲染 ≤ 5 秒 */
export const SINGLE_RENDER_BUDGET_MS = 5_000;
/** 17.3：总渲染预算 ≤ 20 秒（四轮 × 5 秒） */
export const TOTAL_RENDER_BUDGET_MS = 20_000;

/** 页面主字体族名，用于 TP-1-11 的字形断言 */
const PROBE_FONT_FAMILY = "'Noto Sans SC'";

export interface RenderPageRequest {
  readonly context: BrowserContext;
  /** 形如 `http://web:3000` */
  readonly baseUrl: string;
  /** 页面路径，不含查询串，例如 `/render/plans/fixture-7/days/3` */
  readonly path: string;
  /** 与该 path 绑定的渲染令牌（17.1，令牌是页面级的） */
  readonly renderToken: string;
  readonly now?: () => number;
}

export interface RenderPageResult {
  readonly page: Page;
  /** 实际使用的轮次（1 起） */
  readonly round: number;
  readonly variant: RenderVariant;
  readonly overflow: OverflowReport;
  /** 四轮后仍有溢出 → true，调用方据此标记 DEGRADED */
  readonly degraded: boolean;
  readonly elapsedMs: number;
  /**
   * 清单外的图标引用数（TP-5-01，验收标准 5 期望恒为 0）。
   *
   * 只在第 1 轮测量：图标是否在清单内与降级版式无关，每轮重测只是白花
   * 20 秒预算里的时间。首轮之前就抛错的路径拿不到这个数，
   * 那种情况下页面根本没渲染出来。
   */
  readonly missingIcons: number;
  /**
   * 素材图片加载情况。
   *
   * 同样只在第 1 轮测量：素材 URL 能否取到与降级版式无关。
   * `broken > 0` 不影响 `degraded` —— 后者专指 17.3 的溢出未解决，
   * 混进图片失败会让「降级产物占比」这个指标失去原本的含义。
   */
  readonly images: BrokenImageReport;
}

/**
 * 渲染一个页面，必要时按 17.3 降级重试。
 *
 * 返回**仍然打开**的 page —— 截图与 PDF 导出都在同一个 page 上继续进行，
 * 关闭 page 后再重开会丢掉刚刚验证过的布局状态。调用方负责关闭。
 */
export async function renderPage(request: RenderPageRequest): Promise<RenderPageResult> {
  const now = request.now ?? (() => Date.now());
  const startedAt = now();

  const page = await request.context.newPage();

  /*
   * 令牌是页面级的（17.1：`day:3` 的令牌取不到 `day:4`），因此设在 page 上
   * 而不是 context 上 —— ALL_DAYS 导出要在同一个 context 里访问 N 天。
   */
  await page.setExtraHTTPHeaders({ 'x-render-token': request.renderToken });

  try {
    let last: { readonly variant: RenderVariant; readonly overflow: OverflowReport } | null = null;
    let missingIcons = 0;
    let images: BrokenImageReport = { total: 0, broken: 0 };

    for (const [index, variant] of RENDER_ROUNDS.entries()) {
      const remaining = TOTAL_RENDER_BUDGET_MS - (now() - startedAt);
      if (remaining <= 0) {
        /*
         * 预算耗尽时**不再尝试下一轮**，但也不算失败 —— 已经有一份产物了。
         * 把它当超时失败会让「内容偏长」这种小问题变成任务失败。
         */
        break;
      }

      const url = `${request.baseUrl}${request.path}${variantToQuery(variant)}`;
      await navigateAndWait(page, url, Math.min(SINGLE_RENDER_BUDGET_MS, remaining));

      /*
       * 字形断言只在第 1 轮做。
       *
       * 字体是否可用与降级轮次无关 —— 每轮重复检测只是把 20 秒预算白白花掉。
       * 而它必须在**第一次成功加载后立刻**做：后面的截图与 PDF 都建立在
       * 「页面文字是正确字形」这个前提上，晚一步就等于产出了废品再检查。
       */
      if (index === 0) {
        await assertCjkGlyphs(page);
        missingIcons = await countMissingIcons(page);
        images = await countBrokenImages(page);
      }

      const overflow = await detectOverflow(page);
      last = { variant, overflow };

      /*
       * 画布横向溢出是阻断级（17.3）：定宽长图横向放不下一定是模板缺陷，
       * 不是内容问题 —— 压缩文案与隐藏条目都改变不了画布宽度，重渲染纯属浪费。
       */
      if (overflow.canvasOverflowX) {
        throw new RenderError(
          RENDER_ERROR_CODES.templateFailed,
          `画布横向溢出：documentWidth=${overflow.documentWidth}，模板定宽应为 1200px`,
          'CANVAS_OVERFLOW_X',
        );
      }

      if (overflow.violations.length === 0) {
        return {
          page,
          round: index + 1,
          variant,
          overflow,
          degraded: false,
          elapsedMs: now() - startedAt,
          missingIcons,
          images,
        };
      }
    }

    if (last === null) {
      // 预算在第一轮之前就耗尽 —— 只可能是调用方传了已经用完的时间基准
      throw new RenderError(
        RENDER_ERROR_CODES.timeout,
        `渲染预算 ${TOTAL_RENDER_BUDGET_MS}ms 在首轮开始前已耗尽`,
        'BUDGET_EXHAUSTED_BEFORE_START',
      );
    }

    return {
      page,
      round: RENDER_ROUNDS.length,
      variant: last.variant,
      overflow: last.overflow,
      degraded: true,
      elapsedMs: now() - startedAt,
      missingIcons,
      images,
    };
  } catch (error) {
    // 失败路径必须关 page，否则 browser 会攒着永不释放的渲染进程
    await page.close().catch(() => undefined);
    throw error;
  }
}

async function navigateAndWait(page: Page, url: string, budgetMs: number): Promise<void> {
  try {
    await page.goto(url, { timeout: budgetMs, waitUntil: 'domcontentloaded' });
  } catch (error) {
    throw new RenderError(
      RENDER_ERROR_CODES.timeout,
      `导航超时或失败：${url}`,
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await waitForReady(page);
  } catch {
    /*
     * 就绪标记未出现。可能是模板抛错（React 错误边界不会设置该标记），
     * 也可能是图片一直不返回。两者都无法从这里区分，
     * 统一按 RENDER_TIMEOUT 处理 —— 16.3 里两者都是阻断，处置相同。
     */
    throw new RenderError(
      RENDER_ERROR_CODES.timeout,
      `页面未在超时内达到 ready：${url}`,
      'READY_NOT_REACHED',
    );
  }
}

async function assertCjkGlyphs(page: Page): Promise<void> {
  const probe = await probeCjkGlyphs(page, PROBE_FONT_FAMILY);

  /*
   * 17.5：字形缺失时**不允许降级输出**。
   * 豆腐块页面对用户毫无价值，静默交付比失败更糟 —— 用户会以为是自己的
   * 浏览器问题，而我们的监控一片绿色。
   *
   * 判据是「子集是否加载」而不是 17.5 原文的宽度比较（后者对 CJK 必然误判，
   * 原因见 page-checks.ts 的说明）。子集加载成功 + 构建期已证明它含 charset
   * 的每个码点 ⇒ 页面上子集内的汉字有真实字形。
   */
  if (!probe.subsetLoaded) {
    throw new RenderError(
      RENDER_ERROR_CODES.templateFailed,
      `${PROBE_FONT_FAMILY} 的 @font-face 未加载成功，当前渲染落在系统回退字体上。` +
        `中文宽度实测 ${probe.cjkWidth}px；已声明的 face：${JSON.stringify(probe.faces)}。` +
        '检查 web 服务的 /fonts/ 静态资源是否可访问',
      CJK_FONT_UNAVAILABLE,
    );
  }

  /*
   * 正文字体族必须以子集开头。
   *
   * 拦的是另一类失效：woff2 加载成功，但 CSS 变量没生效（例如
   * FontFaces 注入的 `:root` 被别处覆盖），正文落在系统字体上 ——
   * 页面完全正常，只有像素比对能发现，而那时基线已经被更新过了。
   */
  if (!probe.bodyUsesSubset) {
    throw new RenderError(
      RENDER_ERROR_CODES.templateFailed,
      `正文字体族首项不是 ${PROBE_FONT_FAMILY}，实际为 ${JSON.stringify(probe.bodyFontFamily)}。` +
        '检查 FontFaces 注入的 --tps-font-* 变量是否被覆盖',
      'BODY_FONT_NOT_SUBSET',
    );
  }
}
