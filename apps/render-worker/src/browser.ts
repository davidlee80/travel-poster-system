import { statfsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

/**
 * Chromium 启动（TP-1-17/18/19，设计稿 22.3.1、22.3.2）。
 *
 * 全进程**一个** browser 实例（21.2 并发模型：1 browser + 3 page）。
 * 每次渲染开一个 context，渲染完立即关闭 —— context 之间不共享缓存与存储，
 * 上一个计划的图片不会出现在下一个计划里。
 */

/** 21.2：单 browser 同时最多 3 个 page */
export const MAX_CONCURRENT_PAGES = 3;

/**
 * `/dev/shm` 的最低可用容量。
 *
 * Docker 默认给 64MB，Chromium 会在渲染大页面时因共享内存耗尽而崩溃 ——
 * 表现是 `Target closed` 之类与真实原因毫无关系的错误，极难定位（RISK-18）。
 * 256MB 是经验下限：低于此值就走 `--disable-dev-shm-usage`。
 */
const MIN_DEV_SHM_BYTES = 256 * 1024 * 1024;

export interface DevShmStatus {
  /** 无法探测时为 null（非 Linux，或 statfs 失败） */
  readonly availableBytes: number | null;
  readonly needsFallback: boolean;
  readonly reason: string;
}

/**
 * 探测 `/dev/shm` 容量，决定是否需要降级（TP-1-18）。
 *
 * ## 为什么要探测而不是永远加 `--disable-dev-shm-usage`
 *
 * 该参数让 Chromium 把共享内存写到 `/tmp`（磁盘）而不是内存，
 * 渲染明显变慢。单次渲染预算只有 5 秒（17.3），常态开启会把预算吃掉一大截。
 * 所以：容量够就用 `/dev/shm`，不够才降级。
 *
 * ## 为什么不直接读 `/dev/shm` 的挂载参数
 *
 * 挂载参数说的是上限，`statfs` 给的是**当前可用**。同一台机器上多个容器
 * 共享宿主内存时，上限充足而可用不足是完全可能的。
 */
export function checkDevShm(): DevShmStatus {
  if (process.platform !== 'linux') {
    /*
     * 非 Linux 上不降级：Windows / macOS 的 Chromium 不使用 /dev/shm。
     * 在开发机上强行降级会让本地渲染与容器行为不一致，
     * 而我们恰恰指望本地能复现容器的问题。
     */
    return {
      availableBytes: null,
      needsFallback: false,
      reason: `平台 ${process.platform} 不使用 /dev/shm`,
    };
  }

  try {
    const stats = statfsSync('/dev/shm');
    const available = stats.bsize * Number(stats.bavail);

    return available < MIN_DEV_SHM_BYTES
      ? {
          availableBytes: available,
          needsFallback: true,
          reason: `/dev/shm 可用 ${Math.round(available / 1048576)}MB，低于 ${MIN_DEV_SHM_BYTES / 1048576}MB`,
        }
      : {
          availableBytes: available,
          needsFallback: false,
          reason: `/dev/shm 可用 ${Math.round(available / 1048576)}MB`,
        };
  } catch (error) {
    /*
     * 探测失败按「需要降级」处理。
     *
     * 猜错的代价不对称：误降级只是慢一点，漏降级是 Chromium 崩溃后
     * 整批渲染失败。在无法判断时选可用性。
     */
    return {
      availableBytes: null,
      needsFallback: true,
      reason: `无法探测 /dev/shm（${error instanceof Error ? error.message : String(error)}），保守降级`,
    };
  }
}

/**
 * Chromium 启动参数（TP-1-19）。
 *
 * ## 不使用 `--no-sandbox`
 *
 * 22.3.2 要求「优先用 seccomp profile 保留沙箱」。渲染的是我们自己的页面，
 * 但页面内容里含 LLM 产出的文本与外部图片 URL —— 沙箱是这条链路上
 * 唯一阻止「渲染引擎漏洞 → 容器内任意代码执行」的东西。
 *
 * 代价是镜像必须以能创建 user namespace 的方式运行（见 Dockerfile 注释）。
 * 若部署环境确实无法提供，改法是给 Docker 传自定义 seccomp profile，
 * **不是**在这里加 `--no-sandbox`。
 */
export function chromiumArgs(devShm: DevShmStatus): string[] {
  const args = [
    /*
     * 字体渲染必须完全确定化，否则视觉基线（TP-1-16）无法复现。
     * hinting 会根据字号做像素级微调，不同 Chromium 版本的结果不同。
     */
    '--font-render-hinting=none',
    // 亚像素定位关闭：开启时同一段文字在不同起始偏移下的像素结果不同
    '--disable-lcd-text',
    // 跳过首次运行向导与默认浏览器检查，避免容器里多出一个等待
    '--no-first-run',
    '--no-default-browser-check',
    // 后台标签页节流会让 requestAnimationFrame 停摆，就绪探针因此超时
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];

  if (devShm.needsFallback) args.push('--disable-dev-shm-usage');

  return args;
}

export interface LaunchOptions {
  /** 由调用方传入以便记录降级原因；不传则现场探测 */
  readonly devShm?: DevShmStatus;
  readonly headless?: boolean;
}

export interface LaunchedBrowser {
  readonly browser: Browser;
  readonly devShm: DevShmStatus;
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const devShm = options.devShm ?? checkDevShm();

  const browser = await chromium.launch({
    headless: options.headless ?? true,
    args: chromiumArgs(devShm),
  });

  return { browser, devShm };
}

/** 17.4：viewport 1200×1600，2 倍图 */
export const RENDER_VIEWPORT = { width: 1200, height: 1600 } as const;
export const DEVICE_SCALE_FACTOR = 2;

/**
 * 渲染用 context。
 *
 * **不在这里设渲染令牌**：令牌与具体页面绑定（`day:3` 的令牌取不到 `day:4`，
 * 见 17.1），而 ALL_DAYS 导出要在同一个浏览器会话里依次访问 N 天（TP-1-15）。
 * 令牌因此是 page 级的，由 `openRenderPage` 逐页设置。
 */
export async function createRenderContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: RENDER_VIEWPORT.width, height: RENDER_VIEWPORT.height },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    /*
     * 固定 locale 与时区。
     *
     * 容器 TZ=UTC（22.3.1），但页面里的日期文案由服务端按请求 timezone
     * 渲染好后送来，浏览器侧不做时区换算。这里固定住是为了让
     * `Intl` 的任何隐式使用（如 toLocaleString）在基线与 CI 中结果一致。
     */
    locale: 'zh-CN',
    timezoneId: 'UTC',
    // 动画会让截图取到中间帧（17.4 animations: disabled 的等价配置）
    reducedMotion: 'reduce',
  });
}
