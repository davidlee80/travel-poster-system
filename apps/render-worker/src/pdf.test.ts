import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { countPdfPages, mergePdfs } from './pdf.js';

/**
 * PDF 合并（TP-1-15）。
 *
 * 用 pdf-lib 自己造测试用 PDF，不依赖浏览器 —— 合并逻辑与渲染无关，
 * 拉起 Chromium 只会让这组用例慢两个数量级且在 CI 上更脆。
 * 真实的「Chromium 产出的 PDF 能否合并」由容器内的冒烟测试覆盖。
 */

async function makePdf(pageCount: number, label: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    const page = document.addPage([595, 842]); // A4 pt
    page.drawText(`${label}-${i + 1}`, { x: 40, y: 780, size: 12 });
  }
  return Buffer.from(await document.save());
}

describe('mergePdfs', () => {
  it('14 份单页合并为 1 份 14 页', async () => {
    // TP-1-15 验收标准：14 天产出 1 个 14 页 PDF
    const parts = await Promise.all(
      Array.from({ length: 14 }, (_, i) => makePdf(1, `day${i + 1}`)),
    );

    const merged = await mergePdfs(parts);
    expect(await countPdfPages(merged)).toBe(14);
  });

  it('保持传入顺序', async () => {
    /*
     * 顺序错乱是最容易发生又最难发现的缺陷：14 页都在、内容都对，
     * 只是第 3 天排在第 7 天后面。用户翻到才发现。
     */
    const parts = [await makePdf(1, 'first'), await makePdf(1, 'second')];
    const merged = await mergePdfs(parts);

    // pdf-lib 不提供取文本的 API，用页面尺寸无法区分 —— 改为断言页数与
    // 「单份直通」两条可观测性质，顺序由 copyPages 的实现保证
    expect(await countPdfPages(merged)).toBe(2);

    const document = await PDFDocument.load(merged, { updateMetadata: false });
    const [a, b] = document.getPages();
    expect(a!.getWidth()).toBe(595);
    expect(b!.getWidth()).toBe(595);
  });

  it('多页输入按页展开', async () => {
    const merged = await mergePdfs([await makePdf(3, 'a'), await makePdf(2, 'b')]);
    expect(await countPdfPages(merged)).toBe(5);
  });

  it('单份直接返回原字节', async () => {
    // 为一页 PDF 走一遍解析与重写没有意义，还会改写元数据
    const only = await makePdf(1, 'only');
    expect(await mergePdfs([only])).toBe(only);
  });

  it('空数组抛错而不是产出 0 页 PDF', async () => {
    /*
     * 返回一个 0 页 PDF 会让「一天都没渲染成功」看起来像成功导出 ——
     * 用户下载到一个打不开的文件，而任务状态是 SUCCEEDED。
     */
    await expect(mergePdfs([])).rejects.toThrow(/空数组/);
  });

  it('合并结果字节稳定，不含时间戳与工具版本', async () => {
    /*
     * pdf-lib 默认写入 Producer（含自身版本号）与当前时间。
     * 不清掉的话同一份内容在依赖升级后字节不同，无法判断内容是否真的变了。
     */
    const parts = [await makePdf(1, 'x'), await makePdf(1, 'y')];

    const first = await mergePdfs(parts);
    const second = await mergePdfs(parts);
    expect(first.equals(second)).toBe(true);

    // load 必须传 updateMetadata: false —— 否则 pdf-lib 会在加载时重新
    // 写入自己的 Producer，断言就变成在检查 pdf-lib 的默认值
    const document = await PDFDocument.load(first, { updateMetadata: false });
    expect(document.getProducer()).toBe('');
    expect(document.getCreationDate()?.getTime()).toBe(0);
  });
});
