import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assetsDirectory, readManifest } from './assets.js';
import { charsetFingerprint } from './charset.js';
import { fontAssets } from './families.js';

/**
 * 入库资产校验（TP-1-04）。
 *
 * `assets/*.woff2` 是提交进仓库的构建产物，因此**产物与源定义可能漂移** ——
 * 改了 charset 忘了重跑、只重跑了一部分、合并冲突丢了一个文件。
 * 这些情况没有任何一个会让编译或其它测试失败，最终只表现为渲染结果里
 * 少了某些字的字形。这组测试是唯一能在提交前拦住它们的地方。
 */

const manifest = await readManifest();

describe('字体资产', () => {
  it('manifest 记录的字符集指纹与当前 charset 一致', () => {
    /*
     * 这是本组里最重要的一条。
     *
     * 改了 EXTRA_CHARACTERS 却没重跑 fonts:build，是这套流程最可能发生的失误：
     * 代码看起来支持新字符，`findUncoveredCharacters()` 也说覆盖了，
     * 但 woff2 里没有那些字形 —— 页面上是豆腐块，全绿的 CI。
     */
    expect(manifest.charsetFingerprint).toBe(charsetFingerprint());
  });

  it('固定了字体源的 commit SHA', () => {
    // 用 main 会让同一份代码在不同时间构建出不同字体，
    // 视觉基线随之在某天突然失败，且与当次改动无关
    expect(manifest.fontsRepoRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it('manifest 与清单一一对应，没有多余也没有缺失', () => {
    expect(Object.keys(manifest.assets).sort()).toEqual(
      fontAssets()
        .map((a) => a.file)
        .sort(),
    );
  });

  for (const { family, weight, file } of fontAssets()) {
    describe(file, () => {
      it('文件存在且是有效 woff2', async () => {
        const buffer = await readFile(path.join(assetsDirectory(), file));
        // woff2 的魔数是 ASCII "wOF2"；woff1 是 "wOFF"，误提交会让浏览器直接拒绝
        expect(buffer.subarray(0, 4).toString('latin1')).toBe('wOF2');
      });

      it('体积在上下限之间', async () => {
        const buffer = await readFile(path.join(assetsDirectory(), file));

        // 上限：TP-1-04 验收标准「单字重 woff2 < 2MB」
        expect(buffer.length).toBeLessThan(family.maxBytes);
        // 下限：CJK 字形意外丢失时产物只剩几十 KB，而文件依然是合法 woff2
        expect(buffer.length).toBeGreaterThan(family.minBytes);
      });

      it('内容与 manifest 的 sha256 相符', async () => {
        const buffer = await readFile(path.join(assetsDirectory(), file));
        const entry = manifest.assets[file]!;

        expect(createHash('sha256').update(buffer).digest('hex')).toBe(entry.sha256);
        expect(buffer.length).toBe(entry.bytes);
      });

      it('manifest 记录的族名与字重正确', () => {
        const entry = manifest.assets[file]!;
        expect(entry.family).toBe(family.cssFamily);
        expect(entry.weight).toBe(weight);
      });
    });
  }
});
