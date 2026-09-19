import { describe, expect, it } from 'vitest';

import { STEP_SECTIONS } from '@/components/planner/steps/sections';

import {
  ENTRY_ROUTE_LABEL,
  STEP1_CONTENT_BY_ROUTE,
  routeAffectsStep,
  step1Sections,
  type Step1Content,
} from './entry-routes';
import { ROUTE_FIELDS } from './route-fields';

/** 断言辅助：取出非 plan 路线的内容（plan 为 undefined，见表定义） */
function contentOf(route: 'explore' | 'destination' | 'time'): Step1Content {
  const content = STEP1_CONTENT_BY_ROUTE[route];
  if (content === undefined) throw new Error(`${route} 的内容未定义`);
  return content;
}

/**
 * 第 1 步路线内容表的守护。
 *
 * 这张表是「四条路线各自看到什么第 1 步」的唯一真相源。
 * 断言分两层：
 *
 *   - 结构：契约字段必须真的存在于第 1 步（引用了不存在的字段，
 *     页面会静默少一块）；占位字段必须在注册表里。
 *   - 语义：explore 不问目的地、time 不问日期区间 —— 这些是
 *     「路线之所以是路线」的差异，断言它们防的是下一位改表时
 *     顺手把五个区块抄回 explore。
 */
describe('STEP1_CONTENT_BY_ROUTE', () => {
  const step1ContractIds = new Set(
    STEP_SECTIONS['01'].flatMap((section) => section.fields),
  );

  it('四条路线都有定义；plan 为 undefined（走 STEP_SECTIONS[01] 现状）', () => {
    expect(STEP1_CONTENT_BY_ROUTE.explore).toBeDefined();
    expect(STEP1_CONTENT_BY_ROUTE.destination).toBeDefined();
    expect(STEP1_CONTENT_BY_ROUTE.time).toBeDefined();
    expect(STEP1_CONTENT_BY_ROUTE.plan).toBeUndefined();
  });

  it('引用的契约字段必须真的属于第 1 步', () => {
    for (const route of ['explore', 'destination', 'time'] as const) {
      for (const section of contentOf(route).sections) {
        for (const fieldId of section.fields) {
          if (fieldId.startsWith('RT-')) continue;
          expect(
            step1ContractIds.has(fieldId as never),
            `${route} 引用了非第 1 步的契约字段 ${fieldId}`,
          ).toBe(true);
        }
      }
    }
  });

  it('引用的 RT-* 字段必须在注册表里（拼错即红）', () => {
    for (const route of ['explore', 'destination', 'time'] as const) {
      for (const section of contentOf(route).sections) {
        for (const fieldId of section.fields) {
          if (!fieldId.startsWith('RT-')) continue;
          expect(
            Object.hasOwn(ROUTE_FIELDS, fieldId),
            `${route} 引用了未注册的占位字段 ${fieldId}`,
          ).toBe(true);
        }
      }
    }
  });

  it('每条路线的占位字段只属于这条路线（apiKey 块与路线同名）', () => {
    for (const route of ['explore', 'destination', 'time'] as const) {
      for (const section of contentOf(route).sections) {
        for (const fieldId of section.fields) {
          if (!fieldId.startsWith('RT-')) continue;
          const spec = ROUTE_FIELDS[fieldId as keyof typeof ROUTE_FIELDS];
          expect(spec.apiKey.startsWith(`route_${route}.`)).toBe(true);
        }
      }
    }
  });

  it('路线语义：explore 不问日期与目的地，time 不问日期区间，destination 不问目的地列表', () => {
    const fieldsOf = (route: 'explore' | 'destination' | 'time') =>
      new Set(contentOf(route).sections.flatMap((s) => s.fields));

    const explore = fieldsOf('explore');
    expect(explore.has('PV2-01-003')).toBe(false); // 目的地列表
    expect(explore.has('PV2-01-004')).toBe(false); // 日期区间
    expect(explore.has('PV2-01-001')).toBe(true); // 出发地

    const time = fieldsOf('time');
    expect(time.has('PV2-01-003')).toBe(true); // 目的地（time 已知去哪）
    expect(time.has('PV2-01-004')).toBe(false); // 不问确定日期

    const destination = fieldsOf('destination');
    expect(destination.has('PV2-01-003')).toBe(false); // 正是要选的
    expect(destination.has('PV2-01-004')).toBe(true); // 假期已有日期
  });

  it('去重原则：任何路线都不在第 1 步问人数与预算（第 2、3 步的事）', () => {
    for (const route of ['explore', 'destination', 'time'] as const) {
      const ids = contentOf(route).sections.flatMap((s) => s.fields);
      for (const id of ids) {
        expect(id.startsWith('PV2-02-'), `${route} 不应在第 1 步问人员`).toBe(false);
        expect(id.startsWith('PV2-03-'), `${route} 不应在第 1 步问预算`).toBe(false);
      }
    }
  });

  it('每条路线都有页头文案（title 非空）', () => {
    for (const route of ['explore', 'destination', 'time'] as const) {
      expect(contentOf(route).head.title.length).toBeGreaterThan(0);
    }
  });
});

describe('step1Sections（渲染入口）', () => {
  it('plan 路线与未选路线都回落到 STEP_SECTIONS[01] 全量', () => {
    expect(step1Sections('plan')).toBe(STEP_SECTIONS['01']);
    expect(step1Sections(null)).toBe(STEP_SECTIONS['01']);
  });

  it('explore/destination/time 返回各自的内容表区块', () => {
    expect(step1Sections('explore')).toBe(contentOf('explore').sections);
    expect(step1Sections('destination')).toBe(contentOf('destination').sections);
    expect(step1Sections('time')).toBe(contentOf('time').sections);
  });
});

describe('routeAffectsStep / ENTRY_ROUTE_LABEL', () => {
  it('只有第 1 步受路线影响', () => {
    expect(routeAffectsStep('01')).toBe(true);
    expect(routeAffectsStep('00')).toBe(false);
    expect(routeAffectsStep('02')).toBe(false);
    expect(routeAffectsStep('09')).toBe(false);
  });

  it('四条路线都有标签', () => {
    expect(Object.keys(ENTRY_ROUTE_LABEL).sort()).toEqual(
      ['destination', 'explore', 'plan', 'time'].sort(),
    );
  });
});
