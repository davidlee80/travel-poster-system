import { detectCatalogDrift, registeredMetrics } from '@tps/observability';
import { describe, expect, it } from 'vitest';

import { exportTotal } from './export-metrics.js';
import { TEMPLATE_BY_PAGE_TYPE, iconLoadFailureTotal } from './render-metrics.js';

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

  it('两种页面类型各自对应一个模板 ID', () => {
    /*
     * `template_id` 作为标签的前提是取值有界（21.3）。这条断言把「有界」
     * 钉在两个值上 —— 12.2 只有两个模板，而将来加第三个时这里会失败，
     * 提醒去确认基数仍然可接受。
     */
    expect(Object.values(TEMPLATE_BY_PAGE_TYPE)).toEqual([
      'travel_infographic_v1',
      'travel_full_plan_v1',
    ]);
  });
});
