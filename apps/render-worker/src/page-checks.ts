import type { Page } from 'playwright-core';

/**
 * 页面就绪、字体与溢出检查（TP-1-11、TP-1-12，设计稿 17.2、17.3、17.5）。
 *
 * 本文件里的三个函数体都在**浏览器上下文**里执行（`page.evaluate`），
 * 因此不能引用 Node 侧的任何变量与类型 —— 参数必须显式序列化传入。
 */

/** 17.2：模板挂载完数据、字体、图片后设置 body 的 data-render-status */
const READY_SELECTOR = 'body[data-render-status="ready"]';

/** 就绪等待上限。略大于探针自身的 12 秒总超时，让探针先超时并放行。 */
const READY_TIMEOUT_MS = 15_000;

export async function waitForReady(page: Page): Promise<void> {
  await page.waitForSelector(READY_SELECTOR, { timeout: READY_TIMEOUT_MS, state: 'attached' });
}

/**
 * 数出页面上未能解析的图标引用（TP-5-01，验收标准 5）。
 *
 * `data-icon-missing` 由 web 的 `Icon` 组件在图标名不在清单内时渲染 ——
 * 它是「图标加载失败」在这个系统里唯一可能的形态（9.1 把图标内联进构建
 * 产物，运行期没有网络请求可失败）。因此这个计数为 0 等价于
 * 「19 个图标键的映射完整」。
 *
 * 不抛错：缺一个图标不该让整份导出作废（页面其余部分完好），
 * 而 21.3 的图标回归告警会在计数 > 0 时立刻触发。
 */
export async function countMissingIcons(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-icon-missing]').length);
}

export interface BrokenImageReport {
  /** 页面上 `<img>` 的总数 */
  readonly total: number;
  /** 其中加载已结束但没有位图的数量 */
  readonly broken: number;
}

/**
 * 数出未能加载的素材图片。
 *
 * ## 与 countMissingIcons 的分工
 *
 * 那一项数的是**契约漂移**（ViewModel 引用了清单外的图标键，9.1 把图标内联
 * 进构建产物，运行期没有网络请求可失败）。这一项数的是**网络层失败**：
 * ViewModel 里的素材 URL 取不到 —— `S3_PUBLIC_BASE_URL` 配错、素材桶不允许
 * 匿名读、或对象已被清理而 ViewModel 永久保存（19.3）。
 *
 * ## 为什么必须单独数
 *
 * `RenderReadyProbe` 刻意让失败的图片**不阻塞就绪**（十八章降级链：一张坏图
 * 不该让整个导出作废）。那个决定是对的，但它的副作用是：图片全军覆没时
 * 页面照样 ready、`degraded` 照样 false、导出照样 COMPLETED —— 用户拿到一张
 * 图片位置全是空白的长图，而监控一片绿色。
 *
 * 「一张坏图降级」与「21 张全坏」在系统里本该是两件事，而在此之前
 * 它们的可观测表现完全一致。这个计数就是用来把两者分开的。
 *
 * ## 判据为什么带 complete
 *
 * `naturalWidth === 0` 单独用会误报懒加载尚未开始的图片 —— 那种图也没有位图，
 * 但它不是故障。`complete` 为 true 表示加载已经结束（无论成功或失败），
 * 两者合起来才等价于「尝试过且失败了」。
 *
 * 不抛错：与 countMissingIcons 一致，可见性由指标与日志承担。
 */
export async function countBrokenImages(page: Page): Promise<BrokenImageReport> {
  return page.evaluate(() => {
    const images = [...document.querySelectorAll('img')];
    return {
      total: images.length,
      broken: images.filter((img) => img.complete && img.naturalWidth === 0).length,
    };
  });
}

// ── TP-1-11：中文字形断言 ──────────────────────────────────────────

export interface LoadedFace {
  readonly family: string;
  readonly weight: string;
  readonly status: string;
}

export interface FontProbeResult {
  /** 我们自己的 `@font-face` 子集至少有一档加载成功 */
  readonly subsetLoaded: boolean;
  /** 页面正文实际采用的字体族确实以我们的子集开头 */
  readonly bodyUsesSubset: boolean;
  /** 正文计算后的 font-family，失败时用于诊断 */
  readonly bodyFontFamily: string;
  /** 中文文本的实测宽度，仅作诊断信息，不参与判定（原因见下） */
  readonly cjkWidth: number;
  readonly faces: readonly LoadedFace[];
}

/**
 * 断言中文字形真实存在（17.5）。
 *
 * ## 为什么 `document.fonts.ready` 不够
 *
 * 它只保证「声明的字体加载完了」。字体加载成功但**不含中文字形**时，
 * 它一样 resolve —— 页面渲染出满屏豆腐块，任务状态 `SUCCEEDED`。
 * 17.5 明确点出这是「静默通过」的故障。
 *
 * ## 为什么不用 17.5 给出的宽度比较法
 *
 * 设计稿 17.5 的写法是「量 `'运河博物馆'` 在目标字体与 `monospace` 下的宽度，
 * 相同则判定未命中中文字体」。**这个判据不成立**，实测两侧都是 500px：
 *
 *   - CJK 字形的前进宽度恒为全宽 1em，5 个字在 100px 字号下必然是 500px；
 *   - `monospace` 本身没有中文字形，浏览器会**逐字回退**到系统的 Noto CJK
 *     （R-15 已把它装进镜像），回退后同样是 1em/字。
 *
 * 于是「中文渲染完全正常」也会被判成失败。V1.0 的溢出检测（17.3）是同一类
 * 问题：代码看着合理，但对真实 DOM 必然给出错误答案。
 *
 * ## 改用可证明的检查链
 *
 * 与其用视觉启发式猜，不如把几个各自确定的事实串起来：
 *
 *   1. **构建期**：子集 woff2 的 cmap 含 charset 的每一个码点（缺一个就构建失败）；
 *   2. **构建期**：镜像内 `fc-list | grep -ci noto ≥ 1`（系统回退字体存在）；
 *   3. **渲染期（本函数）**：我们声明的 `@font-face` 至少一档 `status === 'loaded'`；
 *   4. **渲染期（本函数）**：正文计算后的 `font-family` 确实以该族开头。
 *
 * 1 + 3 合起来即可推出「页面上子集内的汉字有真实字形」—— 这是推理，不是阈值。
 * 4 拦的是另一类失效：字体加载成功但 CSS 变量没生效，正文落在别的字体上。
 *
 * 字形**长得对不对**仍然只能靠容器内的视觉基线比对（TP-1-16、L-08）。
 */
export async function probeCjkGlyphs(page: Page, fontFamily: string): Promise<FontProbeResult> {
  return page.evaluate(async (family: string) => {
    await document.fonts.ready;

    // 仅作诊断：记录中文实测宽度，出问题时能看出是「零宽」还是「正常全宽」
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:100px;white-space:nowrap';
    probe.textContent = '运河博物馆';
    probe.style.fontFamily = family;
    document.body.appendChild(probe);
    const cjkWidth = probe.getBoundingClientRect().width;
    probe.remove();

    const faces = [...document.fonts].map((face) => ({
      family: face.family,
      weight: face.weight,
      status: face.status,
    }));

    /*
     * 只要求「至少一档加载成功」。
     *
     * font-display: block 下浏览器只会取**页面实际用到**的字重，
     * 某一页没有粗体标题时 700 就停在 unloaded —— 那是正常的懒加载，
     * 不是故障。要求全部 loaded 会让这条断言在正常页面上误报。
     */
    const wanted = family.replaceAll("'", '');
    const subsetLoaded = faces.some(
      (face) => face.family.replaceAll("'", '') === wanted && face.status === 'loaded',
    );

    /*
     * 正文用的是不是我们的字体。
     *
     * 只看**第一项**：字体栈里后面几项是系统回退（R-15），本来就该在那里。
     * 判断「第一项是我们的族」等于判断「有字形的字优先用子集渲染」。
     */
    const bodyFontFamily = getComputedStyle(document.body).fontFamily;
    const firstFamily = bodyFontFamily.split(',')[0]?.trim().replaceAll(/["']/g, '') ?? '';

    return {
      subsetLoaded,
      bodyUsesSubset: firstFamily === wanted,
      bodyFontFamily,
      cjkWidth,
      faces,
    };
  }, fontFamily);
}

// ── TP-1-12：溢出检测（17.3 修正版）────────────────────────────────

export interface OverflowViolation {
  readonly slot: string;
  readonly priority: number;
  readonly overflowX: boolean;
  readonly overflowY: boolean;
  readonly clamped: boolean;
  /**
   * 是否真的丢了内容（裁切或行数截断）。
   *
   * 只有 `true` 的项参与 17.3 的降级决策；`false` 的项是「画到了行盒之外」
   * 这类纯观感问题，记录下来但不触发重渲染。
   */
  readonly losesContent: boolean;
  readonly overflowPx: number;
  /*
   * 原始尺寸。只报「溢出 3px」无法判断是内容太长还是行高不够 ——
   * 而这两者的处置完全不同（压缩文案 vs 改模板）。
   */
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly fontSize: string;
  readonly lineHeight: string;
}

export interface OverflowReport {
  /** 全部溢出项，含不丢内容的观感问题 */
  readonly all: readonly OverflowViolation[];
  /** 真的丢了内容的项。17.3 的降级循环只看这一组 */
  readonly violations: readonly OverflowViolation[];
  readonly guardedCount: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  /** 定宽长图的横向溢出必定是模板缺陷，重渲染无用 —— 阻断级 */
  readonly canvasOverflowX: boolean;
}

/**
 * 检测核心元素溢出（17.3 修正后的算法）。
 *
 * V1.0 的写法对**全部**元素判 `scrollWidth > clientWidth`，有三个必然缺陷：
 *   1. inline 元素（`<span>`/`<a>`/`<em>`）的 `clientWidth` 恒为 0，
 *      只要有内容就「溢出」，一张信息图能报出上千条；
 *   2. `overflow: auto/scroll` 的容器有内容溢出是设计意图；
 *   3. 正文说「核心元素」而代码选 `*`，得到的数字无法用于任何决策。
 *
 * 修正后只检查模板显式标注的 `[data-overflow-guard]`，并排除合法滚动容器。
 */
export async function detectOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    // 抵消亚像素与四舍五入。0 容差会让几乎每个元素都「溢出 0.5px」
    const TOLERANCE = 1;

    const guarded = [...document.querySelectorAll('[data-overflow-guard]')];

    const violations = guarded.flatMap((element) => {
      const el = element as HTMLElement;
      const style = getComputedStyle(el);

      const scrollable = ['overflowX', 'overflowY'].some((axis) => {
        const value = style[axis as 'overflowX' | 'overflowY'];
        return value === 'auto' || value === 'scroll';
      });

      // 合法滚动容器不算溢出；导出场景下模板保证它们不出现
      if (scrollable) return [];

      const overflowX = el.scrollWidth - el.clientWidth > TOLERANCE;
      const overflowY = el.scrollHeight - el.clientHeight > TOLERANCE;

      /*
       * 行数截断（-webkit-line-clamp）单独判定。
       *
       * clamp 生效时元素**看起来**正常（末行有省略号），但内容确实被截掉了。
       * 对导出产物来说这就是信息丢失，必须触发压缩文案而不是接受截断。
       */
      const lineClamp = Number.parseInt(style.webkitLineClamp, 10);
      const clamped = Number.isFinite(lineClamp) && el.scrollHeight - el.clientHeight > TOLERANCE;

      /*
       * 纵向溢出是否**真的裁掉了内容**。
       *
       * 这个区分是必需的，不是精细化。中文字体的内容区（ascent + descent）
       * 通常约 1.29em，比常见的 `line-height: 1.2` 更高，于是**任何**
       * 中文标题都会报出几像素的纵向「溢出」—— 而文字其实完整绘制了，
       * 只是画到了行盒之外。不区分的话每一天都是 DEGRADED，
       * 而「一直降级」等于让 DEGRADED 这个信号失去意义。
       *
       * 真正丢内容的只有两种情况：元素自己裁切（hidden/clip），或行数被 clamp。
       * 横向溢出不做这个区分 —— 定宽版面里横向多出来的文字一定跑到别的
       * 元素上去了，即使没被裁切也是可见缺陷。
       */
      const clipsVertically = style.overflowY === 'hidden' || style.overflowY === 'clip';
      const losesContent = overflowX || clamped || (overflowY && clipsVertically);

      if (!overflowX && !overflowY && !clamped) return [];

      return [
        {
          slot: el.dataset['overflowGuard'] ?? 'unknown',
          priority: Number(el.dataset['overflowPriority'] ?? '0'),
          overflowX,
          overflowY,
          clamped,
          losesContent,
          overflowPx: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        },
      ];
    });

    const root = document.documentElement;

    return {
      all: violations,
      violations: violations.filter((violation) => violation.losesContent),
      guardedCount: guarded.length,
      documentWidth: root.scrollWidth,
      documentHeight: root.scrollHeight,
      canvasOverflowX: root.scrollWidth - root.clientWidth > TOLERANCE,
    };
  });
}
