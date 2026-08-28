import { detectCatalogDrift, registeredMetrics } from '@tps/observability';
import { describe, expect, it } from 'vitest';

import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import { exportTotal } from './export-metrics.js';
import { iconLoadFailureTotal } from './render-metrics.js';

/** 21.3 指标目录门禁（TP-5-01）。理由见 generation-worker 的同名测试 */
describe('21.3 指标目录（render-worker）', () => {
  it('目录里属于本进程的指标全部已注册，且标签集一致', () => {
    expect(typeof exportTotal.inc).toBe('function');
    expect(typeof iconLoadFailureTotal.inc).toBe('function');

    const drift = detectCatalogDrift(registeredMetrics(), ['render-worker']);

    expect(drift.missing).toEqual([]);
    expect(drift.labelMismatch).toEqual([]);
    expect(drift.unregistered).toEqual([]);
  });

  it('template_id 标签的取值有界（当前只有已注册的样式套件）', () => {
    /*
     * `template_id` 作为标签的前提是取值有界（21.3）。
     *
     * 这条断言原先盯的是 `TEMPLATE_BY_PAGE_TYPE` —— 一张把页型当模板的
     * 硬编码表，已在 R-85 删除。意图仍然有效，但盯的对象要换成枚举本身：
     * 标签的实际值来自 `exports.template_id`，而那一列的边界是导出接口的
     * `TemplateIdSchema` 校验 —— 也就是这个枚举。
     *
     * 上限取 8：Prometheus 的基数是各标签取值的乘积，而 `template_id`
     * 还与 `page_type` 相乘。超过这个数要先确认直方图的序列数量仍可接受，
     * 而不是直接把这个数字改大。
     */
    expect(TEMPLATE_ID_VALUES.length).toBeGreaterThan(0);
    expect(TEMPLATE_ID_VALUES.length).toBeLessThanOrEqual(8);
    expect(new Set(TEMPLATE_ID_VALUES).size).toBe(TEMPLATE_ID_VALUES.length);
  });
});
