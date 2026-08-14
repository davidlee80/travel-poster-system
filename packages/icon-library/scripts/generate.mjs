#!/usr/bin/env node
/**
 * 把 SVG 文件编译为 TypeScript 常量（TP-1-03，设计稿 9.1）。
 *
 * ## 为什么必须内联，不能走 HTTP
 *
 * 验收标准 5 要求「图标加载成功率为 100%」。HTTP 请求做不到 100% ——
 * 任何网络抖动、CDN 故障、缓存失效都会让某个图标变成空白，而信息图上
 * 缺一个图标就是可见缺陷。把 SVG 编译进构建产物后，运行期零网络请求，
 * 加载成功率由构建成功保证。
 *
 * ## 为什么用代码生成而不是 SVGR 之类的构建插件
 *
 * 生成产物是**纯字符串常量**，因此：
 *   - 服务端渲染（Playwright 抓取的页面）与客户端渲染完全一致；
 *   - 不依赖 bundler 的 loader 配置，Next / vitest / tsc 三处行为相同；
 *   - 生成结果入 .gitignore 但生成器与源 SVG 入库，diff 可读。
 *
 * 同时校验 9.1 的交付要求：19 个文件、统一 viewBox、无外部引用。
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const svgDir = path.join(here, '..', 'src', 'svg');
const outDir = path.join(here, '..', 'src', 'generated');

/** 9.1 要求的图标清单。数量与名称都是契约，不是约定。 */
const EXPECTED = {
  module: ['calendar', 'food', 'map', 'route', 'camera', 'ticket', 'budget', 'tips'],
  period: ['period-morning', 'period-noon', 'period-afternoon', 'period-evening', 'period-night'],
  transport: [
    'transport-walk',
    'transport-transit',
    'transport-taxi',
    'transport-boat',
    'transport-bike',
    'transport-drive',
  ],
};

const EXPECTED_ALL = [...EXPECTED.module, ...EXPECTED.period, ...EXPECTED.transport];

/** 违反这些就不是「自包含」的图标，PDF 导出或离线渲染时会失效 */
const FORBIDDEN_PATTERNS = [
  [/<image\b/i, '<image> 引用外部位图'],
  [/xlink:href|href\s*=\s*["']https?:/i, '外部引用'],
  [/<script\b/i, '<script>'],
  [/font-family/i, 'font-family（图标不应依赖字体）'],
  [/<text\b/i, '<text>（图标内不放文字，见 11.3）'],
  [/url\(/i, 'url() 引用'],
];

function fail(message) {
  process.stderr.write(`图标校验失败: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function validate(name, svg) {
  if (!svg.includes('viewBox="0 0 24 24"')) {
    fail(`${name}.svg 的 viewBox 必须为 "0 0 24 24"（9.1 交付要求）`);
  }
  if (!svg.includes('stroke="currentColor"')) {
    fail(`${name}.svg 必须使用 stroke="currentColor" 以继承文字颜色（9.1）`);
  }
  for (const [pattern, label] of FORBIDDEN_PATTERNS) {
    if (pattern.test(svg)) {
      fail(`${name}.svg 含禁止内容：${label}`);
    }
  }
}

/** 取出 <svg> 的内部内容，去掉外层标签 —— 组件自己控制外层属性 */
function innerContent(svg) {
  const match = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!match || match[1] === undefined) {
    throw new Error('无法解析 SVG 内容');
  }
  return match[1].trim().replace(/\s*\n\s*/g, '');
}

const files = (await readdir(svgDir)).filter((f) => f.endsWith('.svg')).sort();
const names = files.map((f) => f.replace(/\.svg$/, ''));

// 数量与名称双向校验：多一个、少一个、拼错一个都失败
const missing = EXPECTED_ALL.filter((n) => !names.includes(n));
const extra = names.filter((n) => !EXPECTED_ALL.includes(n));

if (missing.length > 0) fail(`缺少图标: ${missing.join(', ')}`);
if (extra.length > 0) fail(`存在清单外的图标: ${extra.join(', ')}（请先更新 9.1 与本生成器）`);
if (names.length !== EXPECTED_ALL.length) {
  fail(`图标数量应为 ${EXPECTED_ALL.length}，实际 ${names.length}`);
}

const entries = [];
for (const name of EXPECTED_ALL) {
  const svg = await readFile(path.join(svgDir, `${name}.svg`), 'utf8');
  validate(name, svg);
  entries.push([name, innerContent(svg)]);
}

const lines = [
  '// 本文件由 scripts/generate.mjs 从 src/svg/*.svg 生成，请勿手改。',
  '// 图标内联进构建产物以满足验收标准 5「加载成功率 100%」（设计稿 9.1）。',
  '',
  '/** SVG 内部内容（不含外层 <svg> 标签），键为图标名 */',
  'export const ICON_PATHS = {',
  ...entries.map(([name, body]) => `  ${JSON.stringify(name)}: ${JSON.stringify(body)},`),
  '} as const;',
  '',
  'export type GeneratedIconName = keyof typeof ICON_PATHS;',
  '',
  `export const MODULE_ICON_FILES = ${JSON.stringify(EXPECTED.module)} as const;`,
  `export const PERIOD_ICON_FILES = ${JSON.stringify(EXPECTED.period)} as const;`,
  `export const TRANSPORT_ICON_FILES = ${JSON.stringify(EXPECTED.transport)} as const;`,
  '',
];

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'icons.ts'), lines.join('\n'), 'utf8');

process.stdout.write(`已生成 ${entries.length} 个图标常量 → src/generated/icons.ts\n`);
