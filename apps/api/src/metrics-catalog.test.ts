import { detectCatalogDrift, registeredMetrics } from '@tps/observability';
import { describe, expect, it } from 'vitest';

import { creditGateTotal } from './credits/metrics.js';
import { featureGateTotal } from './feature-gate.js';
import { identityTotal } from './identity/metrics.js';
import { queueDepth } from './queue-depth.js';

/** 21.3 指标目录门禁（TP-5-01）。理由见 generation-worker 的同名测试 */
describe('21.3 指标目录（api）', () => {
  it('目录里属于本进程的指标全部已注册，且标签集一致', () => {
    /*
     * 这几行不是凑数：指标在**模块被 import 时**才注册，而下面的漂移检测
     * 读的是「本进程已注册了哪些」。少 import 一个，`missing` 里就会多一个 ——
     * 而那并不说明生产代码有问题，只说明这个测试没把它拉进模块图。
     * 新增指标时这里也要加一行。
     */
    expect(typeof identityTotal.inc).toBe('function');
    expect(typeof featureGateTotal.inc).toBe('function');
    expect(typeof creditGateTotal.inc).toBe('function');
    expect(typeof queueDepth.set).toBe('function');

    const drift = detectCatalogDrift(registeredMetrics(), ['api']);

    expect(drift.missing).toEqual([]);
    expect(drift.labelMismatch).toEqual([]);
    expect(drift.unregistered).toEqual([]);
  });
});
