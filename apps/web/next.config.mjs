import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Next.js 配置。
 */

// 必须用 fileURLToPath 而不是 new URL(...).pathname：
// 后者在 Windows 上返回 "/E:/Docker/..."（带前导斜杠的非法路径），
// Next 会据此在 apps/ 下建出畸形的嵌套目录。这类 URL→路径转换问题
// 不含反斜杠字面量，因此 ESLint 的路径护栏抓不到，只能靠正确的 API。
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `output: 'standalone'` 是容器化的关键（设计稿 22.3.1）：产出自带最小
 * node_modules 的独立目录，镜像不必包含整个 pnpm store，也不必在镜像里
 * 重新 install。`deploy/images/web.Dockerfile` 依赖它。
 *
 * 但它在 pnpm workspace + Windows 上会失败：追踪产物需要创建符号链接，
 * 而 Windows 创建符号链接要求管理员权限或开发者模式，否则 EPERM。
 *
 * 生产与 CI 都在 Linux 上构建（设计稿 22.3「Linux 是唯一的正确性基准」），
 * 因此按平台开关：
 *   - Linux / macOS / CI  → 开启，与生产一致
 *   - Windows 本地        → 关闭，本地开发用 `next dev`，不需要 standalone
 *
 * Windows 上若已启用开发者模式，可用 NEXT_STANDALONE=1 强制开启来验证产物布局。
 *
 * 这个开关的方向是安全的：被跳过的是本地平台，而**被 CI 覆盖的恰好是生产路径**
 * —— `images` job 在 Linux 上构建 web.Dockerfile，若 standalone 产物缺失
 * 或布局不符，COPY 会直接失败。
 */
const enableStandalone = process.env['NEXT_STANDALONE'] === '1' || process.platform !== 'win32';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(enableStandalone ? { output: 'standalone' } : {}),
  // monorepo 中 standalone 需要知道 workspace 根，否则会漏掉软链依赖
  outputFileTracingRoot: workspaceRoot,
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // lint 由仓库统一的 `pnpm lint` 执行，不在 next build 里重复跑
    ignoreDuringBuilds: true,
  },
  typescript: {
    // typecheck 由 `pnpm typecheck` 执行
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
