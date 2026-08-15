import { describe, expect, it } from 'vitest';

import { fitWidthScale } from './pdf.js';

/**
 * PDF 缩放（TP-1-14，R-16 修正 17.4 的 `scale: 1.0`）。
 *
 * 这组用例存在的理由：17.4 原文的 `scale: 1.0` 会让 Chromium **静默横向裁切**
 * 海报右侧约 40%。PDF 正常生成、页数正常、没有任何报错 —— 实测 14 天导出得到
 * 28 页，每页只有左侧一部分内容。缩放比一旦被改回 1，本组会立刻失败。
 */

/** A4 可打印宽度 = 210 - 10 - 10 = 190mm，换算 96dpi 后约 718.11px */
const A4_PRINTABLE_PX = (190 / 25.4) * 96;

describe('fitWidthScale', () => {
  it('把 1200px 定宽海报缩到 A4 可打印宽度', () => {
    const scale = fitWidthScale(1200);
    expect(scale).toBeCloseTo(A4_PRINTABLE_PX / 1200, 6);
    // 约 0.598。这个数字本身不是契约，但它必须显著小于 1 ——
    // 接近 1 说明推导用错了单位，而后果依然是静默裁切
    expect(scale).toBeLessThan(0.7);
    expect(scale).toBeGreaterThan(0.5);
  });

  it('缩放后的宽度正好等于可打印宽度', () => {
    // 这是本函数唯一的正确性定义：内容宽 × 缩放 = 可打印宽
    expect(1200 * fitWidthScale(1200)).toBeCloseTo(A4_PRINTABLE_PX, 6);
    expect(900 * fitWidthScale(900)).toBeCloseTo(A4_PRINTABLE_PX, 6);
  });

  it('内容比可打印区窄时放大而不是留白', () => {
    expect(fitWidthScale(400)).toBeGreaterThan(1);
  });

  it('超出 Chromium 允许范围时抛错并指向页边距', () => {
    /*
     * Chromium 的 printToPDF 只接受 0.1～2.0。不自己挡住的话它会抛
     * "scale is out of range"，而那条信息看不出是页边距或内容宽度配错了。
     */
    // 需要 >2 的缩放：内容宽度 < 359px
    expect(() => fitWidthScale(300)).toThrow(/超出 Chromium 允许/);
    // 需要 <0.1 的缩放：内容宽度 > 7181px
    expect(() => fitWidthScale(20_000)).toThrow(/超出 Chromium 允许/);
  });
});
