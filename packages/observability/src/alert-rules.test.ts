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

  it('21.3 的六条告警一条不少', () => {
    /*
     * 逐个列出而不是只断言数量：少一条时报错信息要能说出少了哪一条。
     * 数量断言在「删了一条、加了一条」时完全沉默。
     */
    expect(alerts.map((rule) => rule.alert).sort()).toEqual([
      'TravelCjkFontUnavailable',
      'TravelHeroCacheHitRatioLow',
      'TravelIconLoadFailure',
      'TravelJobT1SlaBreach',
      'TravelPlanRepairIterationsHigh',
      'TravelRenderDegradedRatioHigh',
    ]);
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

  it('两条 critical 告警对应验收标准里「恒为 0」的两项', () => {
    const critical = alerts
      .filter((rule) => rule.labels?.['severity'] === 'critical')
      .map((rule) => rule.alert)
      .sort();

    // 验收标准 5（图标 100% 加载）与 17.5（字形缺失不允许降级输出）
    expect(critical).toEqual(['TravelCjkFontUnavailable', 'TravelIconLoadFailure']);
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
