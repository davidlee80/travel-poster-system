import { detectCatalogDrift, catalogFor, registeredMetrics } from '@tps/observability';
import { describe, expect, it } from 'vitest';

/*
 * 这些 import 只为触发指标注册（模块副作用）。ESLint 的 no-unused-vars
 * 会抱怨，因此显式使用它们的一个成员。
 */
import { assetResolutionTotal } from './assets/asset-metrics.js';
import { creditSettledCrTotal, creditUnpricedTotal } from './credit-metrics.js';
import { llmTokensTotal } from './llm-metrics.js';
import { jobTotal } from './plan-metrics.js';
import { retrievalReferenceTotal } from './plan-metrics.js';

/**
 * 21.3 指标目录门禁（TP-5-01）。
 *
 * 这个测试拦的是**文档与代码之间的漂移**，而漂移在 P5 之前已经发生过三次：
 * `travel_llm_tokens_total` 只存在于一句注释里、`travel_icon_load_failure_total`
 * 从未被创建、`travel_export_total` 少了 `format` 标签（于是它的 help 文本
 * 承诺的「读出 PDF 的成功率」根本做不到）。
 *
 * 三者的共同点：**没有任何测试会因此变红**。指标缺失的表现是告警永远不触发，
 * 而那与「系统一直很健康」在图上完全一样。
 */
describe('21.3 指标目录（generation-worker）', () => {
  it('目录里属于本进程的指标全部已注册，且标签集一致', () => {
    // 触发注册；具体值不重要
    expect(typeof assetResolutionTotal.inc).toBe('function');
    expect(typeof creditSettledCrTotal.inc).toBe('function');
    expect(typeof creditUnpricedTotal.inc).toBe('function');
    expect(typeof llmTokensTotal.inc).toBe('function');
    expect(typeof jobTotal.inc).toBe('function');
    expect(typeof retrievalReferenceTotal.inc).toBe('function');

    const drift = detectCatalogDrift(registeredMetrics(), ['generation-worker']);

    expect(drift.missing).toEqual([]);
    expect(drift.labelMismatch).toEqual([]);
  });

  it('本进程注册的每个 travel_* 指标都已登记在目录里', () => {
    const drift = detectCatalogDrift(registeredMetrics(), ['generation-worker']);

    /*
     * 反向检查。只查「目录里的都实现了」会放过未登记的新指标，
     * 而未登记指标最典型的问题恰恰是标签基数没人审过 ——
     * 一个 `destination` 标签就能让 Prometheus 长出上千条序列。
     */
    expect(drift.unregistered).toEqual([]);
  });

  it('目录声明的 owner 覆盖了 21.3 表格里属于生成链路的每一项', () => {
    const names = catalogFor('generation-worker').map((entry) => entry.name);

    // 21.3 表格中由生成链路负责的项，逐个列出（漏一个即失败）
    expect(names).toEqual(
      expect.arrayContaining([
        'travel_job_duration_seconds',
        'travel_job_milestone_seconds',
        'travel_job_total',
        'travel_llm_tokens_total',
        'travel_llm_duration_seconds',
        'travel_plan_repair_iterations',
        'travel_validation_violations_total',
        'travel_asset_resolution_total',
        'travel_ai_image_total',
        'travel_retrieval_reference_total',
      ]),
    );
  });
});
