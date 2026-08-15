#!/usr/bin/env node
/**
 * 把 `@tps/fonts` 的子集产物拷进 `public/fonts/`（TP-1-04，设计稿 17.5）。
 *
 * ## 为什么是拷贝而不是让 Next 打包
 *
 * `next/font/local` 会给字体加内容哈希并生成自己的 CSS。两点不合用：
 *   1. 哈希后的文件名每次构建可能变化，渲染 Worker 的字体预加载
 *      与视觉基线都依赖稳定 URL；
 *   2. 它自己生成 `@font-face`，`@tps/fonts` 的清单就不再是唯一来源 ——
 *      加一档字重要改两处，漏一处的表现是「加粗标题变回退字体」。
 *
 * ## 为什么 public/fonts 不入库
 *
 * 它是 `packages/fonts/assets/` 的逐字节副本。两份都入库意味着 15MB 的
 * 二进制且可能不一致；不一致时页面用的是副本，测试校验的是原件。
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assetsDirectory, fontAssets } from '@tps/fonts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(webRoot, 'public', 'fonts');
const source = assetsDirectory();

/*
 * 先清空再拷贝。
 *
 * 只做增量拷贝会留下上一次构建的旧文件：改了 charset 后 public/ 里同时存在
 * 新旧两份，而浏览器按文件名请求 —— 拿到的是哪一份取决于文件名是否变了。
 * 这类「本地看起来对、清缓存后就错」的问题极难定位。
 */
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const expected = new Set(fontAssets().map((asset) => asset.file));
const available = new Set(await readdir(source));

const missing = [...expected].filter((file) => !available.has(file));
if (missing.length > 0) {
  throw new Error(
    `packages/fonts/assets 缺少 ${missing.length} 个文件：${missing.join(', ')}。\n` +
      '请先运行 pnpm fonts:build（需要联网下载源字体）。',
  );
}

for (const file of expected) {
  await copyFile(path.join(source, file), path.join(target, file));
}

process.stdout.write(`已拷贝 ${expected.size} 个字体文件 → public/fonts/\n`);
