import { CreateExportRequestSchema, TEMPLATE_ID_VALUES } from '@tps/schemas';
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
/** 计划生成时选的样式套件。取枚举而不写字面量：schema 校验要求它已注册 */
const TEMPLATE = TEMPLATE_ID_VALUES[0];

describe('buildExportRequest', () => {
  const CHOICES: readonly (readonly [string, ExportChoice])[] = [
    ['完整行程 PDF', { kind: 'full-pdf' }],
    ['完整行程 PNG', { kind: 'full-png' }],
    ['每日信息图 PDF', { kind: 'all-days-pdf' }],
    ['全部每日 PNG', { kind: 'all-days-png' }],
    ['单日 PNG', { kind: 'single-day-png', dayNumber: 3 }],
    ['单日 PDF', { kind: 'single-day-pdf', dayNumber: 3 }],
  ];

  it.each(CHOICES)('%s 的请求体通过 13.5 的 schema', (_name, choice) => {
    const { body } = buildExportRequest(choice, VERSION_ID, TEMPLATE);
    const parsed = CreateExportRequestSchema.safeParse(body);

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('SINGLE_DAY 恰好带一天', () => {
    const { body } = buildExportRequest(
      { kind: 'single-day-png', dayNumber: 7 },
      VERSION_ID,
      TEMPLATE,
    );
    expect(body.scope).toBe('SINGLE_DAY');
    expect(body.day_numbers).toEqual([7]);
  });

  it('FULL_PLAN 与 ALL_DAYS 的 day_numbers 为 null', () => {
    /*
     * 传 `[]` 也能通过 TypeScript，但 schema 的 refine 会拒绝它 ——
     * 而那是一个静默的 400。
     */
    expect(
      buildExportRequest({ kind: 'full-pdf' }, VERSION_ID, TEMPLATE).body.day_numbers,
    ).toBeNull();
    expect(
      buildExportRequest({ kind: 'full-png' }, VERSION_ID, TEMPLATE).body.day_numbers,
    ).toBeNull();
    expect(
      buildExportRequest({ kind: 'all-days-pdf' }, VERSION_ID, TEMPLATE).body.day_numbers,
    ).toBeNull();
    expect(
      buildExportRequest({ kind: 'all-days-png' }, VERSION_ID, TEMPLATE).body.day_numbers,
    ).toBeNull();
  });

  it('三种组合用同一套样式套件（R-85）', () => {
    /*
     * 这条断言在 R-85 前后语义相反：原先验的是「完整页用 travel_full_plan_v1、
     * 每日页用 travel_infographic_v1」，也就是按导出种类选模板。
     *
     * 现在一套套件覆盖两个页型，三种导出必须用同一套 —— 即计划生成时
     * 选的那一套。用错不会在前端报错，但会被导出侧拒（那个套件没有
     * 对应的 presentation）。
     */
    const ids = [
      buildExportRequest({ kind: 'full-pdf' }, VERSION_ID, TEMPLATE).body.template_id,
      buildExportRequest({ kind: 'all-days-pdf' }, VERSION_ID, TEMPLATE).body.template_id,
      buildExportRequest({ kind: 'single-day-png', dayNumber: 1 }, VERSION_ID, TEMPLATE).body
        .template_id,
    ];

    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(TEMPLATE);
  });

  it('每种组合都显式带 plan_version_id', () => {
    /*
     * 缺省时服务端取「当前版本」，而用户看的是他打开页面时的那一版 ——
     * 两者不同时他会拿到一份内容与屏幕不符的 PDF。
     */
    const choices: ExportChoice[] = [
      { kind: 'full-pdf' },
      { kind: 'full-png' },
      { kind: 'all-days-pdf' },
      { kind: 'all-days-png' },
      { kind: 'single-day-png', dayNumber: 2 },
      { kind: 'single-day-pdf', dayNumber: 2 },
    ];
    for (const choice of choices) {
      expect(buildExportRequest(choice, VERSION_ID, TEMPLATE).body.plan_version_id).toBe(
        VERSION_ID,
      );
    }
  });

  it('标签含天号，便于用户区分并发的多次导出', () => {
    expect(
      buildExportRequest({ kind: 'single-day-png', dayNumber: 5 }, VERSION_ID, TEMPLATE).label,
    ).toContain('第 5 天');
  });
});
