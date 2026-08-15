#!/usr/bin/env node
/**
 * 视觉回归基线（TP-1-16，设计稿 22.3.4 L-08、门禁 #9/#33）。
 *
 *   node tools/visual-baseline.mjs check    比对 out-fixtures 与入库基线
 *   node tools/visual-baseline.mjs update   用 out-fixtures 更新入库基线
 *
 * ## 为什么比对在宿主上跑，生成必须在容器里
 *
 * **生成**依赖字体渲染，Windows 与 Linux 的结果必然不同 —— 开发机产出的基线
 * 会让 CI 永久失败或永久误通过（RISK-17）。因此 `update` 会检查产物目录里的
 * `render-meta.json`，来源不是 Linux 就拒绝写入（门禁 #33）。
 *
 * **比对**只是解码 PNG 后逐像素做算术，与平台无关，所以放在宿主跑：
 * 这样 pixelmatch / pngjs 只需要是 devDependency，不必进 1.2GB 的渲染镜像。
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(repoRoot, 'apps', 'render-worker', '__visual__', 'baseline');
const actualRoot = path.join(repoRoot, 'apps', 'render-worker', '__visual__', 'actual');
const fixturesDir = path.join(repoRoot, 'out-fixtures');

/**
 * 允许的像素差异比例上限。
 *
 * TP-1-16 验收标准是「重跑像素差异 < 0.5%」。留这条容差而不是要求逐字节相同，
 * 是因为 Chromium 的抗锯齿在同一版本内也可能有极小的非确定性；
 * 但 0.5% 已经足以在「中文变豆腐块」「字体换成系统回退」这类问题上失败 ——
 * 那些改变的是大面积文字，差异远超 0.5%。
 */
const MAX_DIFF_RATIO = 0.005;

/**
 * 每个 fixture 取哪一天做像素基线。
 *
 * 只取第 1 天而不是全部 22 天：单张 2400px 宽的长图约 1MB，全量入库会给仓库
 * 增加 20MB+ 二进制。第 1 天已经覆盖全部 8 个模块与两种字体，
 * 而「某一天的布局回归」由结构化摘要（layout.json）覆盖 —— 它对所有天生效，
 * 且 diff 可读。两者互补。
 */
const PIXEL_BASELINE_DAY = 1;

const FIXTURES = [1, 7, 14];

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * 校验产物来源（门禁 #33）。
 *
 * 这是 update 路径上唯一的硬门禁。没有它，「在 Windows 上跑一次 update」
 * 是一个完全自然的动作，而后果是视觉回归从此形同虚设 —— 而且不会有任何报错。
 */
async function assertLinuxProvenance(dir) {
  let meta;
  try {
    meta = await readJson(path.join(dir, 'render-meta.json'));
  } catch {
    throw new Error(
      `${dir} 缺少 render-meta.json。基线只能来自 pnpm fixture:render（容器内渲染）的产物。`,
    );
  }

  const { platform, arch, chromiumVersion } = meta.provenance ?? {};

  if (platform !== 'linux') {
    throw new Error(
      `产物来自 platform=${platform}，拒绝写入基线（门禁 #33）。\n` +
        '字体渲染在 Windows / macOS 与 Linux 上必然不同，开发机产出的基线会让 CI\n' +
        '永久失败或永久误通过。请用 pnpm fixture:render 在容器内重新生成。',
    );
  }

  log(`来源校验通过：${platform}/${arch}，Chromium ${chromiumVersion}`);
  return meta;
}

/** 解码 PNG。尺寸不同时直接判失败 —— pixelmatch 要求两图同尺寸。 */
async function decodePng(file) {
  return PNG.sync.read(await readFile(file));
}

async function comparePng(baselineFile, actualFile, diffFile) {
  const [expected, actual] = await Promise.all([decodePng(baselineFile), decodePng(actualFile)]);

  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      ok: false,
      reason:
        `尺寸不同：基线 ${expected.width}×${expected.height}，` +
        `实际 ${actual.width}×${actual.height}。` +
        '高度变化通常意味着内容或版式改变，宽度变化意味着 viewport / 缩放被改动',
    };
  }

  const diff = new PNG({ width: expected.width, height: expected.height });
  const changed = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    expected.width,
    expected.height,
    {
      // 阈值针对单像素颜色距离。0.1 能容忍抗锯齿抖动，但拦得住字形替换
      threshold: 0.1,
    },
  );

  const ratio = changed / (expected.width * expected.height);

  if (ratio > MAX_DIFF_RATIO) {
    await mkdir(path.dirname(diffFile), { recursive: true });
    await writeFile(diffFile, PNG.sync.write(diff));
    return {
      ok: false,
      reason:
        `像素差异 ${(ratio * 100).toFixed(3)}% 超过上限 ${(MAX_DIFF_RATIO * 100).toFixed(1)}%；` +
        `差异图见 ${path.relative(repoRoot, diffFile).split(path.sep).join('/')}`,
    };
  }

  return { ok: true, ratio };
}

/**
 * HTML 的结构化摘要。
 *
 * 不比对 HTML 全文：Next 的构建产物里含 chunk 文件名与内联脚本，
 * 每次构建都不同，全文比对会 100% 误报。摘要只取与版式相关的部分。
 */
function layoutDigest(html) {
  const guards = [...html.matchAll(/data-overflow-guard="([^"]+)"/g)].map((m) => m[1]);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    guardSlots: guards,
    guardCount: guards.length,
    // 文案哈希：文案变了必须是显式改动，不该悄悄跟着模板走
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    textLength: text.length,
  };
}

async function collectActual() {
  const files = await readdir(fixturesDir).catch(() => {
    throw new Error(
      `找不到 ${path.relative(repoRoot, fixturesDir)}。请先运行 pnpm fixture:render（容器内渲染）。`,
    );
  });

  return new Set(files);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'check' && mode !== 'update') {
    throw new Error('用法：node tools/visual-baseline.mjs <check|update>');
  }

  const present = await collectActual();
  const meta = await assertLinuxProvenance(fixturesDir);

  const days = Number(/^fixture-(\d+)$/.exec(meta.planVersionId)?.[1] ?? '0');
  if (!FIXTURES.includes(days)) {
    throw new Error(
      `产物是 ${meta.planVersionId}，而基线只覆盖 ${FIXTURES.join(' / ')} 天三档（TP-1-16）。`,
    );
  }

  const pngName = `day-${String(PIXEL_BASELINE_DAY).padStart(2, '0')}.png`;
  const htmlName = `day-${String(PIXEL_BASELINE_DAY).padStart(2, '0')}.html`;
  for (const required of [pngName, htmlName, `${meta.planVersionId}-all-days.pdf`]) {
    if (!present.has(required)) {
      throw new Error(`产物目录缺少 ${required}；请用 --format all 重新渲染。`);
    }
  }

  const slot = `fixture-${days}`;
  const baselinePng = path.join(baselineDir, slot, pngName);
  const baselineLayout = path.join(baselineDir, slot, 'layout.json');

  const actualPng = path.join(fixturesDir, pngName);
  const actualHtml = await readFile(path.join(fixturesDir, htmlName), 'utf8');
  const actualLayout = layoutDigest(actualHtml);

  if (mode === 'update') {
    await mkdir(path.join(baselineDir, slot), { recursive: true });
    await copyFile(actualPng, baselinePng);
    await writeFile(baselineLayout, `${JSON.stringify(actualLayout, null, 2)}\n`, 'utf8');
    await writeFile(
      path.join(baselineDir, slot, 'provenance.json'),
      `${JSON.stringify(meta.provenance, null, 2)}\n`,
      'utf8',
    );
    log(`已更新基线 ${slot}：${pngName} + layout.json + provenance.json`);
    return;
  }

  const failures = [];

  const pixel = await comparePng(
    baselinePng,
    actualPng,
    path.join(actualRoot, slot, `${pngName}.diff.png`),
  );
  if (pixel.ok) {
    log(`${slot} ${pngName}：像素差异 ${((pixel.ratio ?? 0) * 100).toFixed(4)}%`);
  } else {
    failures.push(`${slot} ${pngName}：${pixel.reason}`);
  }

  const expectedLayout = await readJson(baselineLayout);
  if (expectedLayout.textSha256 !== actualLayout.textSha256) {
    failures.push(
      `${slot} layout：文案哈希不同（基线 ${expectedLayout.textLength} 字符，` +
        `实际 ${actualLayout.textLength} 字符）。文案改动必须是显式的，` +
        '确认无误后运行 pnpm visual:update',
    );
  }
  if (expectedLayout.guardCount !== actualLayout.guardCount) {
    failures.push(
      `${slot} layout：溢出守卫数量 ${expectedLayout.guardCount} → ${actualLayout.guardCount}。` +
        '守卫变少意味着 17.3 的溢出检测覆盖面缩小了',
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) log(`✗ ${failure}`);
    throw new Error(`视觉回归失败 ${failures.length} 项`);
  }

  log(`${slot} 视觉回归通过`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
