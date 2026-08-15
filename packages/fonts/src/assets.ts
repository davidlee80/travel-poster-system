import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 资产目录定位与 manifest 读取（TP-1-04）。
 *
 * 渲染 Worker 与 Next 的静态资源拷贝都需要知道 `assets/` 在哪。
 * 硬编码相对路径会在「从 dist 运行」与「从 src 跑测试」两种情形下不一致，
 * 因此统一从本模块的 URL 反推。
 */

export interface FontManifestEntry {
  readonly family: string;
  readonly weight: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FontManifest {
  readonly charsetFingerprint: string;
  readonly fontsRepoRef: string;
  readonly assets: Readonly<Record<string, FontManifestEntry>>;
}

/**
 * `assets/` 的绝对路径。
 *
 * 用 `fileURLToPath` 而不是 `new URL(...).pathname` —— 后者在 Windows 上
 * 返回 `/E:/...` 这种带前导斜杠的非法路径。这个坑在 P0 的 next.config.mjs
 * 里已经踩过一次。
 *
 * 向上两级：`dist/assets.js` 与 `src/assets.ts` 都在包根下一层，
 * 所以两种运行形态得到同一个目录。
 */
export function assetsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'assets');
}

export async function readManifest(): Promise<FontManifest> {
  const file = path.join(assetsDirectory(), 'manifest.json');
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw) as FontManifest;
}
