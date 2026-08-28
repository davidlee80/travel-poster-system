import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FONT_WEIGHTS } from '@tps/fonts';

/**
 * CSS 里用到的字重必须是我们实际发布的字重（TP-1-04，设计稿 17.5）。
 *
 * ## 为什么这需要一条测试
 *
 * 我们只发 400/500/700。CSS 里写 `font-weight: 600` **不会报错** ——
 * 按 CSS Fonts 4 的匹配规则，600 会静默解析到 700。于是：
 *   - 设计意图是 semibold，实际渲染是 bold；
 *   - 两者的差别在中文字体上很明显，但没有任何工具会指出来；
 *   - 有人后来补上 600 字重后，这些地方的外观会突然变化，
 *     而那次改动的 diff 里完全看不出为什么。
 *
 * 让 CSS 只写实际存在的字重，等于让样式表说真话。
 */

const stylesRoot = path.dirname(fileURLToPath(import.meta.url));
const globalsCss = path.resolve(stylesRoot, '..', 'app', 'globals.css');

/**
 * 收集要检查的样式表。
 *
 * **递归两层**（R-85）：模板目录从 `templates/<模板>/styles.css` 变成了
 * `templates/<套件>/<页型>/styles.css` —— 一套样式套件同时提供全览页与
 * 每日页，因此多了一层。只走一层的话这道门禁会**静默覆盖 0 个模板样式表**
 * （`ink-paper-v1/` 下没有 styles.css）—— 下面那条下限断言就是为此而存在。
 */
async function collectCssFiles(): Promise<string[]> {
  const files = [globalsCss];

  for (const suite of await readdir(stylesRoot, { withFileTypes: true })) {
    if (!suite.isDirectory()) continue;
    const suiteDir = path.join(stylesRoot, suite.name);

    // 套件目录自己可能有一份共享样式表
    await pushIfExists(files, path.join(suiteDir, 'styles.css'));

    for (const page of await readdir(suiteDir, { withFileTypes: true })) {
      if (!page.isDirectory()) continue;
      await pushIfExists(files, path.join(suiteDir, page.name, 'styles.css'));
    }
  }

  return files;
}

async function pushIfExists(files: string[], candidate: string): Promise<void> {
  try {
    await readFile(candidate);
    files.push(candidate);
  } catch {
    // 该层没有独立样式表
  }
}

const cssFiles = await collectCssFiles();

describe('CSS 字重', () => {
  it('找到了要检查的样式表', () => {
    // 目录改名或模板移动后，静默检查 0 个文件的测试依然「通过」
    expect(cssFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of cssFiles) {
    it(`${path.basename(path.dirname(file))}/${path.basename(file)} 只用已发布的字重`, async () => {
      const css = await readFile(file, 'utf8');

      const used = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
      const shipped = new Set<number>(FONT_WEIGHTS);
      const unshipped = [...new Set(used)].filter((weight) => !shipped.has(weight));

      expect(
        unshipped,
        `${path.basename(file)} 使用了未发布的字重；` +
          `请改用 ${[...shipped].join(' / ')}，或在 @tps/fonts 的 FONT_WEIGHTS 里增加该字重并重跑 fonts:build`,
      ).toEqual([]);
    });
  }
});
