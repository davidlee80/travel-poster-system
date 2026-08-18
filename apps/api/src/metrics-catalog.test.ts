import { detectCatalogDrift, registeredMetrics } from '@tps/observability';
import { describe, expect, it } from 'vitest';

import { identityTotal } from './identity/metrics.js';

/** 21.3 指标目录门禁（TP-5-01）。理由见 generation-worker 的同名测试 */
describe('21.3 指标目录（api）', () => {
  it('目录里属于本进程的指标全部已注册，且标签集一致', () => {
    expect(typeof identityTotal.inc).toBe('function');

    const drift = detectCatalogDrift(registeredMetrics(), ['api']);

    expect(drift.missing).toEqual([]);
    expect(drift.labelMismatch).toEqual([]);
    expect(drift.unregistered).toEqual([]);
  });
});
