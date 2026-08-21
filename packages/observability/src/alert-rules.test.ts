import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { METRICS_CATALOG } from './catalog.js';

/**
 * Prometheus 规则文件的自检（TP-5-04，设计稿 21.3）。
 *
 * ## 拦的是什么
 *
 * 告警最常见、也最难发现的失效方式是**表达式引用了一个不存在的指标**。
 * PromQL 对不存在的指标返回空集，于是那条告警永远不触发 ——
 * 而 Prometheus 界面上它显示为「正常」。指标改名、打错一个字母、
 * 或者应用侧那个指标从未被注册（P5 之前 21.3 的六个指标就是这个状态），
 * 症状完全一样：一片绿色，什么都不响。
 *
 * 因此这里把规则文件里出现的每个 `travel_*` 指标名对着指标目录核一遍。
 * 这是「告警规则」与「实际注册的指标」之间唯一的连接点 ——
 * 没有它，两边各自演化。
 *
 * 语法层面的校验由 `promtool check rules` 做（CI 里执行，见 ci.yml）。
 * 这里做的是**语义**校验，promtool 不知道我们有哪些指标。
 */

const RULES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/prometheus/rules/travel-poster.rules.yml',
);

interface Rule {
  readonly alert?: string;
  readonly record?: string;
  readonly expr: string;
  readonly for?: string;
  readonly labels?: Record<string, string>;
  readonly annotations?: Record<string, string>;
}

interface RuleFile {
  readonly groups: readonly { readonly name: string; readonly rules: readonly Rule[] }[];
}

const file: RuleFile = parse(readFileSync(RULES_PATH, 'utf8'));
const allRules = file.groups.flatMap((group) => group.rules);
const alerts = allRules.filter((rule) => rule.alert !== undefined);
const records = allRules.filter((rule) => rule.record !== undefined);

/** 表达式里出现的指标名（去掉 histogram 的 _bucket / _sum / _count 后缀） */
function metricsIn(expr: string): string[] {
  const names = [...expr.matchAll(/\btravel_[a-z_]+\b/g)].map((match) => match[0]);
  return [...new Set(names.map((name) => name.replace(/_(bucket|sum|count)$/, '')))];
}

describe('Prometheus 规则文件', () => {
  it('每条规则引用的指标都在 21.3 的指标目录里', () => {
    const known = new Set(METRICS_CATALOG.map((entry) => entry.name));
    const unknown: string[] = [];

    for (const rule of allRules) {
      for (const metric of metricsIn(rule.expr)) {
        if (!known.has(metric)) {
          unknown.push(`${rule.alert ?? rule.record ?? '?'} → ${metric}`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });

  it('记录规则产出的指标本身也在目录里，且登记为 recording_rule', () => {
    /*
     * `travel_asset_cache_hit_ratio` 是 R-31 的产物：应用不注册它，
     * Prometheus 侧算出来。它必须在目录里（否则「21.3 那一项去哪了」
     * 无从回答），且 `kind` 必须是 `recording_rule` ——
     * 标成 counter 会让 detectCatalogDrift 要求某个进程注册它，
     * 而那正是 R-31 要废掉的那个 Gauge。
     */
    for (const rule of records) {
      const entry = METRICS_CATALOG.find((item) => item.name === rule.record);
      expect(entry, `${rule.record} 未登记`).toBeDefined();
      expect(entry!.kind).toBe('recording_rule');
      expect(entry!.owner).toBe('prometheus');
    }
  });

  /** 21.3 表格明确要求的六条 */
  const DESIGN_ALERTS = [
    'TravelCjkFontUnavailable',
    'TravelHeroCacheHitRatioLow',
    'TravelIconLoadFailure',
    'TravelJobT1SlaBreach',
    'TravelPlanRepairIterationsHigh',
    'TravelRenderDegradedRatioHigh',
  ] as const;

  /**
   * 实现补充的告警，与 METRICS_CATALOG 里 `source: 'supplementary'` 同一性质。
   *
   * 每加一条都要在这里写明理由 —— 告警的边际成本是「值班的人被叫起来」，
   * 而没有理由的告警最终会被静音，连带着把有理由的那些一起淹掉。
   */
  const SUPPLEMENTARY_ALERTS: Readonly<Record<string, string>> = {
    TravelAssetImageLoadFailureRatioHigh:
      'RenderReadyProbe 刻意让坏图不阻塞就绪（十八章降级链），因此素材 URL 全部取不到时页面仍 ready、degraded 仍为 false、导出仍 COMPLETED —— 用户拿到图片位置全空白的长图而所有信号都是绿的。21.3 的六条里没有一条能覆盖这个失效',
  };

  it('21.3 的六条告警一条不少，补充的告警都有理由', () => {
    /*
     * 逐个列出而不是只断言数量：少一条时报错信息要能说出少了哪一条。
     * 数量断言在「删了一条、加了一条」时完全沉默。
     */
    const present = alerts.map((rule) => rule.alert);
    for (const name of DESIGN_ALERTS) {
      expect(present, `21.3 要求的 ${name} 不在规则文件里`).toContain(name);
    }

    // 反向：规则文件里的每一条要么是 21.3 要求的，要么在补充清单里有理由
    for (const name of present) {
      const known =
        DESIGN_ALERTS.includes(name as (typeof DESIGN_ALERTS)[number]) ||
        SUPPLEMENTARY_ALERTS[name!] !== undefined;
      expect(known, `${name} 既不在 21.3 的六条里，也没在 SUPPLEMENTARY_ALERTS 写明理由`).toBe(
        true,
      );
    }
  });

  it('每条告警都有 severity、说明与 runbook 链接', () => {
    for (const rule of alerts) {
      /*
       * runbook 是 TP-5-11 的要求「每个 P0 告警有对应处置步骤」。
       * 没有它的告警在半夜响起来时，值班的人只能从零开始猜 ——
       * 而告警本身已经知道该看哪几个指标（写在 description 里）。
       */
      expect(rule.labels?.['severity'], `${rule.alert!} 缺 severity`).toMatch(
        /^(critical|warning)$/,
      );
      expect(rule.annotations?.['summary'], `${rule.alert!} 缺 summary`).toBeTruthy();
      expect(rule.annotations?.['description'], `${rule.alert!} 缺 description`).toBeTruthy();
      expect(rule.annotations?.['runbook'], `${rule.alert!} 缺 runbook`).toMatch(/^docs\//);
    }
  });

  it('只有「任意一次即告警」的两条没有 for', () => {
    /*
     * 21.3 给每条告警都定了持续时间，除了图标回归与字体故障 ——
     * 那两条是「任意一次即告警」。没有 `for` 的告警会因为一次抓取抖动
     * 就响，因此这个例外必须是显式的、被钉住的，而不是某次编辑时漏写。
     */
    const withoutFor = alerts.filter((rule) => rule.for === undefined).map((rule) => rule.alert);
    expect(withoutFor.sort()).toEqual(['TravelCjkFontUnavailable', 'TravelIconLoadFailure']);
  });

  it('critical 只给「产物对用户无价值」的那几条', () => {
    const critical = alerts
      .filter((rule) => rule.labels?.['severity'] === 'critical')
      .map((rule) => rule.alert)
      .sort();

    /*
     * 判据不是「严重」而是**产物是否还有价值**：
     *   字形缺失   → 豆腐块页面（17.5 明确不允许降级输出）
     *   图标缺失   → 契约漂移，验收标准 5 要求恒为 0
     *   素材图全坏 → 图片位置全空白的长图，而系统报告 COMPLETED
     * 三者的共同点是「交付了，但交付的东西没用」，而这恰恰是监控最容易漏掉的
     * 一类故障 —— 它不表现为失败率上升。
     *
     * 降级产物占比、缓存命中率、SLA 违约都是 warning：那些情况下用户拿到的
     * 东西仍然可用，只是变差了。
     */
    expect(critical).toEqual([
      'TravelAssetImageLoadFailureRatioHigh',
      'TravelCjkFontUnavailable',
      'TravelIconLoadFailure',
    ]);
  });

  it('SLA 告警只看 ≤7 天那一档', () => {
    const sla = alerts.find((rule) => rule.alert === 'TravelJobT1SlaBreach')!;

    /*
     * 8～14 天的目标不同（要分段调两次模型，21.2）。不带这个筛选条件的话，
     * 一个全是 14 天请求的时段会让 P95 看起来在违约，而它其实符合那一档 ——
     * 而误报的告警很快就会被静音，连真的违约也一起静音了。
     */
    expect(sla.expr).toContain('total_days_bucket="1-7"');
    expect(sla.expr).toContain('milestone="t1"');
    expect(sla.expr).toContain('> 75');
  });
});
