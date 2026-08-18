import { CreateExportRequestSchema } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { buildExportRequest, type ExportChoice } from './export-request.js';

/**
 * 前端构造的导出请求必须通过**服务端那份 schema**（13.5）。
 *
 * ## 这条测试抓的是什么
 *
 * `CreateExportRequestSchema` 有一条 refine：`SINGLE_DAY` 时 `day_numbers`
 * 恰好一天、其余必须为 null。违反它的后果是一个 400 —— 用户点了导出按钮，
 * 什么也没发生，而前端代码看起来完全正常。
 *
 * 用服务端的 schema 而不是自己再写一遍断言：两份约束必然在某次改动后分歧，
 * 而这里分歧的表现正是那个静默的 400。
 */

const VERSION_ID = '22222222-2222-4222-8222-222222222222';

describe('buildExportRequest', () => {
  const CHOICES: readonly (readonly [string, ExportChoice])[] = [
    ['完整行程 PDF', { kind: 'full-pdf' }],
    ['每日信息图 PDF', { kind: 'all-days-pdf' }],
    ['单日 PNG', { kind: 'single-day-png', dayNumber: 3 }],
  ];

  it.each(CHOICES)('%s 的请求体通过 13.5 的 schema', (_name, choice) => {
    const { body } = buildExportRequest(choice, VERSION_ID);
    const parsed = CreateExportRequestSchema.safeParse(body);

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('SINGLE_DAY 恰好带一天', () => {
    const { body } = buildExportRequest({ kind: 'single-day-png', dayNumber: 7 }, VERSION_ID);
    expect(body.scope).toBe('SINGLE_DAY');
    expect(body.day_numbers).toEqual([7]);
  });

  it('FULL_PLAN 与 ALL_DAYS 的 day_numbers 为 null', () => {
    /*
     * 传 `[]` 也能通过 TypeScript，但 schema 的 refine 会拒绝它 ——
     * 而那是一个静默的 400。
     */
    expect(buildExportRequest({ kind: 'full-pdf' }, VERSION_ID).body.day_numbers).toBeNull();
    expect(buildExportRequest({ kind: 'all-days-pdf' }, VERSION_ID).body.day_numbers).toBeNull();
  });

  it('三种组合各自用对应的模板', () => {
    /*
     * 完整页用 travel_full_plan_v1、每日页用 travel_infographic_v1（12.2）。
     * 用错模板不会报错 —— 导出会成功，只是产物的版式不是用户在屏幕上看到的那个。
     */
    expect(buildExportRequest({ kind: 'full-pdf' }, VERSION_ID).body.template_id).toBe(
      'travel_full_plan_v1',
    );
    expect(buildExportRequest({ kind: 'all-days-pdf' }, VERSION_ID).body.template_id).toBe(
      'travel_infographic_v1',
    );
    expect(
      buildExportRequest({ kind: 'single-day-png', dayNumber: 1 }, VERSION_ID).body.template_id,
    ).toBe('travel_infographic_v1');
  });

  it('每种组合都显式带 plan_version_id', () => {
    /*
     * 缺省时服务端取「当前版本」，而用户看的是他打开页面时的那一版 ——
     * 两者不同时他会拿到一份内容与屏幕不符的 PDF。
     */
    const choices: ExportChoice[] = [
      { kind: 'full-pdf' },
      { kind: 'all-days-pdf' },
      { kind: 'single-day-png', dayNumber: 2 },
    ];
    for (const choice of choices) {
      expect(buildExportRequest(choice, VERSION_ID).body.plan_version_id).toBe(VERSION_ID);
    }
  });

  it('标签含天号，便于用户区分并发的多次导出', () => {
    expect(
      buildExportRequest({ kind: 'single-day-png', dayNumber: 5 }, VERSION_ID).label,
    ).toContain('第 5 天');
  });
});
