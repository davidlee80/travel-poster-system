import { detectCatalogDrift, registeredMetrics } from '@tps/observability';
import { describe, expect, it } from 'vitest';

import { anonPurgeTotal, knowledgeRows } from './retention-metrics.js';

/** 21.3 指标目录门禁（TP-5-01）。理由见 generation-worker 的同名测试 */
describe('21.3 指标目录（retention-worker）', () => {
  it('目录里属于本进程的指标全部已注册，且标签集一致', () => {
    expect(typeof anonPurgeTotal.inc).toBe('function');
    expect(typeof knowledgeRows.set).toBe('function');

    const drift = detectCatalogDrift(registeredMetrics(), ['retention-worker']);

    expect(drift.missing).toEqual([]);
    expect(drift.labelMismatch).toEqual([]);
    expect(drift.unregistered).toEqual([]);
  });
});
