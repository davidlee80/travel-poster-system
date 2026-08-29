#!/usr/bin/env node
/**
 * 从视觉基线生成模板示例图（R-85 P3）。
 *
 *   pnpm --filter @tps/render-worker previews
 *
 * ## 这些图是占位图
 *
 * 产出的是**整张日页长图缩到宽 400px** 的结果 —— 2400×5496 缩成 400×916，
 * 细节看不清是预期的，它只用来让用户一眼分辨「这两套样式气质不同」。
 *
 * 真正的示例图由设计提供。替换时**只需覆盖同名文件**，不用改代码：
 * 图片地址存在配置中心的 `metadata.preview_image` 里，而这个脚本
 * 与门禁都只认那个路径。
 *
 * ## 为什么用基线而不是现渲一张
 *
 * 基线是 Linux 容器里渲出来的真实产物（`platform: linux`，门禁 #33 保证），
 * 因此占位图与用户实际会拿到的产物**逐像素同源**。现渲一张要起 web + 容器，
 * 而且在 Windows 上渲出来的字体与线上不一致 —— 那种占位图会误导设计。
 *
 * ## 为什么在 render-worker 而不是仓根
 *
 * `sharp` 是这个包的依赖（仓根解析不到），而基线也在这个包里。
 * 放仓根要么加一个只为这个脚本存在的依赖，要么 `require` 一个跨包路径。
 *
 * ## 加了新套件之后
 *
 * 1. 先给新套件拍基线（`pnpm fixture:render` + `visual:update`，需 Linux 容器）
 * 2. 再跑这个脚本
 *
 * 顺序不能颠倒：没有基线时这个脚本会明确报错而不是跳过 ——
 * 跳过的后果是配置里登记了一张不存在的图，而
 * `template-catalog-coverage.test.ts` 那条「示例图真的存在」会红。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import sharp from 'sharp';

/** 卡片宽度。界面上一行放两三张，400px 足够且不至于让仓库变大 */
const PREVIEW_WIDTH = 400;

/**
 * 只取第 1 天的基线。
 *
 * 与 `PIXEL_BASELINE_DAY = 1` 同一个理由（见 `tools/visual-baseline.mjs`）：
 * 第 1 天已覆盖全部区块与两种字体。
 */
const BASELINE_DAY = 'day-01.png';
const BASELINE_FIXTURE = 'fixture-1';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.join(here, '..');
const baselineRoot = path.join(workerRoot, '__visual__', 'baseline');
const outputDir = path.join(workerRoot, '..', 'web', 'public', 'images', 'templates');

/** `ink_paper_v1` → `ink-paper-v1`：与模板目录名、与配置里的图片名一致 */
function fileStem(templateId) {
  return templateId.replaceAll('_', '-');
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const written = [];

  for (const templateId of TEMPLATE_ID_VALUES) {
    const source = path.join(baselineRoot, templateId, BASELINE_FIXTURE, BASELINE_DAY);

    /*
     * 基线缺失时报错而不是跳过。跳过会让「忘了拍基线」表现为
     * 「配置里那张图 404」—— 而那时人会去查前端而不是查基线。
     */
    try {
      await stat(source);
    } catch {
      throw new Error(
        `找不到 ${path.relative(workerRoot, source)}。\n` +
          `套件 ${templateId} 还没有视觉基线，先在 Linux 容器里拍一次：\n` +
          `  FIXTURE_TEMPLATE=${templateId} pnpm fixture:render\n` +
          `  pnpm visual:update`,
      );
    }

    const target = path.join(outputDir, `${fileStem(templateId)}.png`);
    const buffer = await sharp(source)
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      /*
       * `palette: true` 对这类大面积平色的信息图压得很好（约省一半），
       * 而示例图不需要真彩 —— 它只是让人看清版式与配色倾向。
       */
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();

    await writeFile(target, buffer);

    const meta = await sharp(buffer).metadata();
    written.push({
      templateId,
      file: path.relative(path.join(workerRoot, '..', '..'), target).replaceAll('\\', '/'),
      size: `${String(meta.width)}x${String(meta.height)}`,
      kb: (buffer.length / 1024).toFixed(1),
    });
  }

  for (const row of written) {
    process.stdout.write(`${row.templateId}  ${row.size}  ${row.kb}KB  →  ${row.file}\n`);
  }
  process.stdout.write(`共 ${String(written.length)} 张\n`);
}

await main();
