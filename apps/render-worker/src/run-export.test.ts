import { describe, expect, it } from 'vitest';

import { pagesFor } from './run-export.js';

/**
 * 13.5 的产物组织（TP-4-12）。
 *
 * `runExport` 的主体需要真实的 Chromium 与 web 服务（导出链路的端到端在
 * `pnpm fixture:render` 与 P5 的门禁里跑）。这里单测的是**不需要浏览器**
 * 的那部分决策：scope → 要渲染哪些页面。
 *
 * 这条决策错了的表现很具体：`ALL_DAYS` 渲染成 1 页（用户拿到只有第一天的
 * PDF 却标着「已完成」），或者对不存在的页面发请求（一批失败天号）。
 */

const VERSION = '22222222-2222-4222-8222-222222222222';

describe('scope → 页面列表', () => {
  it('FULL_PLAN 只渲染完整页，天号为 null', () => {
    const pages = pagesFor('FULL_PLAN', null, VERSION);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.dayNumber).toBeNull();
    expect(pages[0]?.path).toBe(`/render/plans/${VERSION}/full`);
  });

  it('SINGLE_DAY 渲染指定的那一天', () => {
    const pages = pagesFor('SINGLE_DAY', [3], VERSION);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.dayNumber).toBe(3);
    expect(pages[0]?.path).toBe(`/render/plans/${VERSION}/days/3`);
  });

  it('ALL_DAYS 按传入的天号逐页渲染', () => {
    const pages = pagesFor('ALL_DAYS', [1, 2, 3, 4, 5], VERSION);
    expect(pages.map((page) => page.dayNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('天号为空时返回空列表，而不是默认渲染第 1 天', () => {
    /*
     * 默认渲染第 1 天会产出一份「只有第一天」的 PDF 并标成 COMPLETED ——
     * 用户看不出少了 13 天。返回空列表会让 runExport 落到 FAILED，
     * 而那是对的：一个没有任何展示页的版本确实无法导出。
     */
    expect(pagesFor('ALL_DAYS', null, VERSION)).toEqual([]);
    expect(pagesFor('ALL_DAYS', [], VERSION)).toEqual([]);
  });

  it('每页有自己的 pageKey（17.1 的令牌是页面级的）', () => {
    const pages = pagesFor('ALL_DAYS', [1, 2], VERSION);
    expect(new Set(pages.map((page) => page.pageKey)).size).toBe(2);
  });

  it('版本 ID 经过 URL 编码（它进路径）', () => {
    const pages = pagesFor('FULL_PLAN', null, 'a/b c');
    expect(pages[0]?.path).toBe('/render/plans/a%2Fb%20c/full');
  });
});
