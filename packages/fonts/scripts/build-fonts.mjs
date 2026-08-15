#!/usr/bin/env node
/**
 * 字体子集化（TP-1-04，设计稿 17.5）。
 *
 * 下载 google/fonts 的可变字体 → 按 charset 子集化并实例化字重 →
 * 写入 `assets/*.woff2` 与 `manifest.json`。
 *
 * ## 为什么产物入库、源字体不入库
 *
 * 源字体三个文件合计 ~42MB，且每次构建镜像都要重新下载才能得到产物；
 * 子集产物合计不到 10MB 且**内容稳定**（charset 不变则产物不变）。
 * 因此：
 *   - `assets/` 入库 → 镜像构建与 CI 不需要网络就能拿到字体，
 *     也满足 17.5「字体文件随仓库提供」；
 *   - `.cache/` 不入库 → 只有改 charset 或升级字体版本时才需要联网重跑。
 *
 * ## 为什么用 harfbuzz（subset-font）而不是 fonttools
 *
 * fonttools 需要 Python 环境。开发在 Windows、CI 在 Linux、镜像里还有第三套
 * 环境，多一个语言运行时就多一处「本地能跑 CI 不能跑」。
 * subset-font 是 harfbuzz 的 WASM 封装，纯 JS 依赖，三处行为一致。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import subsetFont from 'subset-font';

import { FONT_FAMILIES } from '../dist/families.js';
import { charsetFingerprint, subsetCodepoints, GB2312_HANZI_COUNT } from '../dist/charset.js';
import { readCodepoints } from './cmap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');
const cacheDir = path.join(packageRoot, '.cache');
const assetsDir = path.join(packageRoot, 'assets');

/**
 * 固定到 commit SHA，不用 `main` 也不用 tag。
 *
 * 用 `main` 会让「同一份代码在不同时间构建出不同字体」——
 * 视觉基线（TP-1-16）随之失效，而失效的表现是 CI 某天突然开始报像素差异，
 * 与当次改动毫无关系。
 *
 * google/fonts 不发布语义化 tag（它的 tag 是各字体各自的版本），
 * 所以 SHA 是唯一能锁定「这三个文件的确切内容」的方式。
 * 升级字体时改这里并重跑 fonts:build，manifest 的 sha256 会随之变化，
 * 视觉基线也必须同批更新。
 */
const FONTS_REPO_REF = '352f6b7d9d6cc4fa9e242b931291d31b21a6dc84';
const RAW_BASE = `https://raw.githubusercontent.com/google/fonts/${FONTS_REPO_REF}/`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** 下载并缓存。已存在则直接复用，避免每次重跑都拉 42MB。 */
async function fetchCached(repoPath) {
  const fileName = repoPath.split('/').pop();
  const cached = path.join(cacheDir, fileName);

  try {
    const info = await stat(cached);
    if (info.size > 0) {
      log(`  缓存命中 ${fileName}（${(info.size / 1048576).toFixed(1)}MB）`);
      return readFile(cached);
    }
  } catch {
    // 未缓存，继续下载
  }

  // 路径里的 [wght] 必须转义，否则 GitHub 返回 404
  const url = RAW_BASE + repoPath.split('/').map(encodeURIComponent).join('/');
  log(`  下载 ${fileName} …`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`下载失败 ${response.status} ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cached, buffer);
  log(`  已缓存 ${fileName}（${(buffer.length / 1048576).toFixed(1)}MB）`);

  return buffer;
}

/** 同时取回许可文件 —— OFL 1.1 第 2 条要求随字体分发许可全文。 */
async function fetchLicense(repoPath) {
  const dir = repoPath.split('/').slice(0, -1).join('/');
  const response = await fetch(`${RAW_BASE}${dir}/OFL.txt`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`取许可失败 ${response.status} ${dir}/OFL.txt`);
  return response.text();
}

const codepoints = subsetCodepoints();
const subsetText = String.fromCodePoint(...[...codepoints].sort((a, b) => a - b));

log(`字符集：${codepoints.size} 个码点（含 GB 2312 汉字 ${GB2312_HANZI_COUNT}）`);
log(`指纹：${charsetFingerprint()}`);
log(`字体源 ref：${FONTS_REPO_REF}`);

await mkdir(assetsDir, { recursive: true });

const manifest = {
  // 供测试断言：assets 是否由当前 charset 生成
  charsetFingerprint: charsetFingerprint(),
  fontsRepoRef: FONTS_REPO_REF,
  assets: {},
};

const licenses = [];

/**
 * 用源字体的真实 cmap 校验请求集合。
 *
 * harfbuzz 对源字体没有的码点静默跳过，所以「请求了 N 个码点」不等于
 * 「产物含 N 个字形」。不校验的话 `findUncoveredCharacters()` 会
 * 汇报「已覆盖」而 PNG 上是豆腐块 —— 一切构建步骤都成功，缺陷只在成品上可见。
 */
function assertCoverage(family, source) {
  /*
   * 本脚本是 .mjs，不受类型检查保护，而它读的是 dist/ 里的编译产物。
   * `coverage` 拼错或 dist 过期时，值会是 undefined —— 三元表达式会安静地
   * 走进 ascii 分支，于是「校验了七千多个码点」变成「校验了 95 个」，
   * 断言看起来通过实际什么都没查。这一次已经踩到过，所以显式挡住。
   */
  if (family.coverage !== 'full' && family.coverage !== 'ascii') {
    throw new Error(
      `${family.id} 的 coverage 不是 'full' 或 'ascii'（读到 ${JSON.stringify(family.coverage)}）。` +
        `若刚改过 src/families.ts，请用 pnpm --filter @tps/fonts fonts:build 重跑（它会先编译 dist）。`,
    );
  }

  const available = readCodepoints(source);

  const required =
    family.coverage === 'full'
      ? [...codepoints]
      : [...codepoints].filter((code) => code >= 0x20 && code <= 0x7e);

  const missing = required.filter((code) => !available.has(code));

  log(`  源字体 cmap ${available.size} 个码点，本次需要 ${required.length} 个`);

  if (missing.length > 0) {
    const sample = missing
      .slice(0, 12)
      .map(
        (code) =>
          `U+${code.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(code)}`,
      )
      .join('  ');
    throw new Error(
      `${family.cssFamily} 缺少 ${missing.length} 个所需字形，子集化后这些字符会显示为豆腐块。\n` +
        `  前几个：${sample}\n` +
        `  处理方式：从 EXTRA_CHARACTERS 移除这些字符（改用字体确实含有的替代符号），` +
        `或把该字体的 coverage 降级并确认 CSS 栈里有能兜底的字体。`,
    );
  }

  return available;
}

for (const family of FONT_FAMILIES) {
  log(`\n${family.cssFamily}`);
  const source = await fetchCached(family.sourcePath);
  licenses.push({ family: family.cssFamily, text: await fetchLicense(family.sourcePath) });

  assertCoverage(family, source);

  for (const weight of family.weights) {
    const file = `${family.id}-${weight}.woff2`;

    const buffer = await subsetFont(source, subsetText, {
      targetFormat: 'woff2',
      /*
       * 把可变轴钉死在目标字重上（instancing）。数值形式 = pin。
       * 不钉的话产物会带上完整的可变轴数据，体积反而比静态字重更大，
       * 而且 PDF 嵌入可变字体在部分阅读器上会回退到默认实例。
       *
       * 只传字体确实拥有的轴 —— harfbuzz 对不存在的轴直接失败（见 extraAxes 注释）。
       */
      variationAxes: { wght: weight, ...family.extraAxes },
    });

    await writeFile(path.join(assetsDir, file), buffer);

    manifest.assets[file] = {
      family: family.cssFamily,
      weight,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };

    const overBudget = buffer.length > family.maxBytes;
    log(
      `  ${file.padEnd(24)} ${(buffer.length / 1024).toFixed(0).padStart(6)} KB` +
        (overBudget ? `  ✗ 超出上限 ${(family.maxBytes / 1024).toFixed(0)} KB` : ''),
    );
    if (overBudget) {
      throw new Error(
        `${file} 体积 ${buffer.length} 超过上限 ${family.maxBytes}。` +
          `请收窄 charset 或调整 FONT_FAMILIES 中的 maxBytes（后者需要同时更新 TP-1-04 验收标准）。`,
      );
    }
  }
}

await writeFile(
  path.join(assetsDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

// 三个字体都是 OFL 1.1，但版权行不同，必须逐个保留（OFL 1.1 第 2 条）
await writeFile(
  path.join(packageRoot, 'OFL.txt'),
  licenses
    .map(({ family, text }) => `${'='.repeat(70)}\n${family}\n${'='.repeat(70)}\n\n${text}`)
    .join('\n\n'),
  'utf8',
);

const total = Object.values(manifest.assets).reduce((sum, a) => sum + a.bytes, 0);
log(`\n合计 ${(total / 1048576).toFixed(2)}MB，${Object.keys(manifest.assets).length} 个文件`);
