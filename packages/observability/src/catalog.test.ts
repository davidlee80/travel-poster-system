import { describe, expect, it } from 'vitest';

import { METRICS_CATALOG, catalogFor, detectCatalogDrift } from './catalog.js';
import { ALLOWED_LABELS } from './labels.js';

describe('21.3 指标目录', () => {
  it('每个标签都在白名单内', () => {
    /*
     * 目录本身也要过白名单。它是文档的机器可读副本，而文档里写错一个
     * 高基数标签不会有任何症状 —— 直到有人照着它加指标。
     */
    const allowed = new Set<string>(ALLOWED_LABELS);
    const offenders = METRICS_CATALOG.flatMap((entry) =>
      entry.labels.filter((label) => !allowed.has(label)).map((label) => `${entry.name}.${label}`),
    );

    expect(offenders).toEqual([]);
  });

  it('指标名唯一', () => {
    const names = METRICS_CATALOG.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('21.3 表格的 18 项全部登记', () => {
    const fromDesign = METRICS_CATALOG.filter((entry) => entry.source === 'design-21.3');
    expect(fromDesign).toHaveLength(18);
  });

  it('记录规则不计入任何进程的注册清单', () => {
    /*
     * R-31：`travel_asset_cache_hit_ratio` 由 Prometheus 侧计算。
     * 它必须留在目录里（否则「这一项去哪了」无从回答），
     * 但绝不能出现在应用要注册的清单里 —— 那正是 R-31 要废掉的那个 Gauge。
     */
    const owners = ['api', 'generation-worker', 'render-worker', 'retention-worker'] as const;
    const all = owners.flatMap((owner) => catalogFor(owner).map((entry) => entry.name));

    expect(all).not.toContain('travel_asset_cache_hit_ratio');
    expect(METRICS_CATALOG.map((entry) => entry.name)).toContain('travel_asset_cache_hit_ratio');
  });

  it('检测缺失、未登记与标签不一致三类漂移', () => {
    /*
     * 从目录本身派生「已注册」清单，而不是手写几项。
     *
     * 手写的话，每次给 api 加一个指标这条测试就会因为 `missing` 非空而变红 ——
     * 而它要验证的是 `detectCatalogDrift` 的三条判定，与 api 有几个指标无关。
     * 用派生清单后只有「漂移检测本身坏了」才会红。
     */
    const registered = catalogFor('api').map((entry) => ({
      name: entry.name,
      labels: entry.labels,
    }));
    const mismatched = registered[0]!;

    const drift = detectCatalogDrift(
      [
        // 第一项故意多一个标签
        { name: mismatched.name, labels: [...mismatched.labels, 'outcome'] },
        ...registered.slice(1),
        // 没登记过的指标
        { name: 'travel_something_new', labels: [] },
        // 非本项目前缀的指标不该被管
        { name: 'process_cpu_seconds_total', labels: [] },
      ],
      ['api'],
    );

    expect(drift.unregistered).toEqual(['travel_something_new']);
    expect(drift.labelMismatch).toEqual([
      {
        name: mismatched.name,
        expected: [...mismatched.labels].sort(),
        actual: [...mismatched.labels, 'outcome'].sort(),
      },
    ]);
    expect(drift.missing).toEqual([]);
  });

  it('缺失一项时报出它的名字', () => {
    const drift = detectCatalogDrift([], ['retention-worker']);
    expect(drift.missing).toEqual([
      'travel_anon_purge_total',
      'travel_credit_hold_expired_total',
      'travel_knowledge_rows',
    ]);
  });
});
