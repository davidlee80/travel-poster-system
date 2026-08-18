/**
 * 21.3 指标目录（TP-5-01）。
 *
 * ## 为什么需要一份目录，而不是「代码里注册了就算」
 *
 * 21.3 用一张表列出 18 个指标。表在文档里、注册散在 5 个进程的 8 个文件里，
 * 两边各写一份的结果是**没人知道差了哪几个** —— 这正是 P5 开始时的实际情况：
 * `travel_llm_tokens_total` 只出现在一句注释里，`travel_icon_load_failure_total`
 * 从未存在，而 `travel_export_total` 少了 `format` 标签（于是「PDF 的成功率」
 * 根本查不出来，尽管注释说它能查）。
 *
 * 这份目录是那张表的机器可读形态：
 *   - `source: 'design-21.3'` 的项**必须**在对应进程里注册（缺一个即门禁失败）；
 *   - 每个已注册的 `travel_*` 指标都必须在这里登记（悄悄加指标不登记也失败）；
 *   - `labels` 写的是**实现的**标签集，与设计稿不同处由 `note` 说明原因。
 *
 * 双向断言是刻意的。只查「表里的都实现了」会放过未登记的新指标，
 * 而未登记指标最常见的问题恰恰是标签基数没人审过。
 */

/** 注册该指标的进程。`prometheus` 表示由服务端规则计算，应用不注册 */
export type MetricOwner =
  'api' | 'generation-worker' | 'render-worker' | 'retention-worker' | 'prometheus';

export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'recording_rule';

export interface CatalogEntry {
  readonly name: string;
  readonly kind: MetricKind;
  /** 实现的标签集（顺序无关，比较时按集合） */
  readonly labels: readonly string[];
  readonly owner: MetricOwner;
  /** `design-21.3`：21.3 表格明确要求的；`supplementary`：实现补充的 */
  readonly source: 'design-21.3' | 'supplementary';
  /** 与设计稿的差异、或补充指标存在的理由 */
  readonly note?: string;
}

export const METRICS_CATALOG: readonly CatalogEntry[] = [
  // ── 任务与 SLA（generation-worker）────────────────────────
  {
    name: 'travel_job_duration_seconds',
    kind: 'histogram',
    labels: ['stage', 'total_days_bucket', 'outcome'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: '与 generation_jobs.stage_timings 同源：同一个计时器既写库又打点',
  },
  {
    name: 'travel_job_milestone_seconds',
    kind: 'histogram',
    labels: ['milestone', 'total_days_bucket', 'user_type'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: 'user_type 由 R-13 追加',
  },
  {
    name: 'travel_job_total',
    kind: 'counter',
    labels: ['status', 'error_code', 'user_type'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: 'user_type 由 R-13 追加；成功时 error_code="none"（Prometheus 无空标签概念）',
  },

  // ── LLM（generation-worker）───────────────────────────────
  {
    name: 'travel_llm_tokens_total',
    kind: 'counter',
    labels: ['model', 'purpose', 'direction'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: 'direction=input|output 是实现追加的：两者单价不同，合成一个数无法核算成本',
  },
  {
    name: 'travel_llm_duration_seconds',
    kind: 'histogram',
    labels: ['model', 'purpose', 'outcome'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: 'outcome 是实现追加的：超时与成功的耗时混在一起会把 P95 顶到超时上限',
  },

  // ── 校验与修复（generation-worker）────────────────────────
  {
    name: 'travel_plan_repair_iterations',
    kind: 'histogram',
    labels: ['outcome'],
    owner: 'generation-worker',
    source: 'design-21.3',
  },
  {
    name: 'travel_validation_violations_total',
    kind: 'counter',
    labels: ['rule_id', 'severity'],
    owner: 'generation-worker',
    source: 'design-21.3',
  },
  {
    name: 'travel_plan_regenerations_total',
    kind: 'counter',
    labels: ['outcome'],
    owner: 'generation-worker',
    source: 'supplementary',
    note: '21.4 的「最多 2 次定向重生成」需要单独的计数才能核算 LLM 成本',
  },

  // ── 素材（generation-worker）──────────────────────────────
  {
    name: 'travel_asset_resolution_total',
    kind: 'counter',
    labels: ['role', 'strategy', 'outcome'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: '设计稿写 status；实现统一用 outcome —— status 在 travel_job_total 里表示任务状态，同一个词指两件事会让告警表达式写错（R-39）',
  },
  {
    name: 'travel_asset_match_score',
    kind: 'histogram',
    labels: ['role'],
    owner: 'generation-worker',
    source: 'supplementary',
    note: 'TP-3-09 的分数分布报告。桶边界压着十章的 0.65 / 0.80 两个阈值',
  },
  {
    name: 'travel_asset_resolution_duration_seconds',
    kind: 'histogram',
    labels: ['role', 'strategy'],
    owner: 'generation-worker',
    source: 'supplementary',
    note: '21.2 的单槽位 800 毫秒上限',
  },
  {
    name: 'travel_asset_batch_duration_seconds',
    kind: 'histogram',
    labels: ['outcome'],
    owner: 'generation-worker',
    source: 'supplementary',
    note: '21.2 的「全部素材解析（14 天）P95 < 25 秒」',
  },
  {
    name: 'travel_ai_image_total',
    kind: 'counter',
    labels: ['outcome', 'role', 'user_type'],
    owner: 'generation-worker',
    source: 'design-21.3',
    note: 'user_type 由 R-13 追加，用于验证「匿名 AI Hero 额度为 0」',
  },
  {
    name: 'travel_asset_cache_hit_ratio',
    kind: 'recording_rule',
    labels: ['role'],
    owner: 'prometheus',
    source: 'design-21.3',
    note: 'R-31：由记录规则从 travel_asset_resolution_total 导出，应用不注册 Gauge',
  },

  // ── 检索（generation-worker）──────────────────────────────
  {
    name: 'travel_retrieval_reference_total',
    kind: 'counter',
    labels: ['outcome', 'source'],
    owner: 'generation-worker',
    source: 'design-21.3',
  },

  // ── 渲染与导出（render-worker）────────────────────────────
  {
    name: 'travel_render_overflow_rounds',
    kind: 'histogram',
    labels: ['template_id', 'page_type'],
    owner: 'render-worker',
    source: 'design-21.3',
  },
  {
    name: 'travel_render_degraded_total',
    kind: 'counter',
    labels: ['reason_code'],
    owner: 'render-worker',
    source: 'design-21.3',
    note: '设计稿写 reason；实现用 reason_code —— 白名单里已有 reason_code，且值确实是码而不是自由文本（R-39）',
  },
  {
    name: 'travel_icon_load_failure_total',
    kind: 'counter',
    labels: [],
    owner: 'render-worker',
    source: 'design-21.3',
    note: '采集点是渲染页面里的 [data-icon-missing]：那是「图标加载失败」唯一可观测的形态（验收标准 5）',
  },
  {
    name: 'travel_render_failure_total',
    kind: 'counter',
    labels: ['reason_code'],
    owner: 'render-worker',
    source: 'supplementary',
    note: 'R-42：21.3 的字体故障告警条件写的是「日志出现 CJK_FONT_UNAVAILABLE」，而 Prometheus 不看日志。把渲染失败原因计成指标，那条告警才有可判定的对象',
  },
  {
    name: 'travel_export_total',
    kind: 'counter',
    labels: ['format', 'scope', 'outcome', 'user_type'],
    owner: 'render-worker',
    source: 'design-21.3',
    note: '设计稿写 status，同 R-39 用 outcome；user_type 由 R-13 追加',
  },
  {
    name: 'travel_export_duration_seconds',
    kind: 'histogram',
    labels: ['format', 'scope', 'outcome'],
    owner: 'render-worker',
    source: 'supplementary',
    note: '21.2 的分环节导出目标（单页 PNG < 8 秒、PDF < 10 秒、14 页合并 < 15 秒）',
  },

  // ── 身份（api）────────────────────────────────────────────
  {
    name: 'travel_identity_total',
    kind: 'counter',
    labels: ['event', 'outcome'],
    owner: 'api',
    source: 'design-21.3',
  },
  {
    name: 'travel_feature_gate_total',
    kind: 'counter',
    labels: ['event', 'reason_code'],
    owner: 'api',
    source: 'supplementary',
    note: 'TP-5-10：放量期间唯一能回答「有多少用户被挡住了」的指标。reason_code 区分 disabled（运维动作）与 not_in_rollout（预期行为）',
  },
  {
    name: 'travel_identity_by_type_total',
    kind: 'counter',
    labels: ['user_type'],
    owner: 'api',
    source: 'supplementary',
    note: 'R-13 的转化观察：匿名与注册各自的请求量',
  },

  // ── 保留期（retention-worker）─────────────────────────────
  {
    name: 'travel_anon_purge_total',
    kind: 'counter',
    labels: ['outcome'],
    owner: 'retention-worker',
    source: 'design-21.3',
    note: '15.1 的合规证据：清理任务是否真的在跑，只有它能回答',
  },
  {
    name: 'travel_knowledge_rows',
    kind: 'gauge',
    labels: [],
    owner: 'retention-worker',
    source: 'design-21.3',
  },
];

/** 应用需要注册的项（排除记录规则） */
export function catalogFor(owner: MetricOwner): readonly CatalogEntry[] {
  return METRICS_CATALOG.filter((e) => e.owner === owner && e.kind !== 'recording_rule');
}

export interface CatalogDrift {
  /** 目录里有、注册表里没有 */
  readonly missing: readonly string[];
  /** 注册表里有、目录里没登记 */
  readonly unregistered: readonly string[];
  /** 标签集不一致 */
  readonly labelMismatch: readonly {
    readonly name: string;
    readonly expected: readonly string[];
    readonly actual: readonly string[];
  }[];
}

interface RegisteredMetric {
  readonly name: string;
  readonly type?: string;
  readonly aggregator?: string;
  readonly help?: string;
}

/**
 * 比对目录与实际注册表。
 *
 * `owners` 是本进程应当注册的 owner 集合 —— 因为 registry 是进程级单例，
 * 一个进程只会 import 自己那部分指标模块。传空数组表示「只检查未登记项」。
 *
 * 不直接读 prom-client 的类型：本函数由各进程的门禁测试调用，
 * 而 registry 的 JSON 形态足够（name + labels），引入 prom-client 的
 * 类型会让消费方的 .d.ts 指向本包的 node_modules（TS2742）。
 */
export function detectCatalogDrift(
  registered: readonly { readonly name: string; readonly labels: readonly string[] }[],
  owners: readonly MetricOwner[],
): CatalogDrift {
  const byName = new Map(registered.map((m) => [m.name, m]));
  const expected = METRICS_CATALOG.filter(
    (e) => owners.includes(e.owner) && e.kind !== 'recording_rule',
  );

  const missing = expected.filter((e) => !byName.has(e.name)).map((e) => e.name);

  const catalogNames = new Set(METRICS_CATALOG.map((e) => e.name));
  const unregistered = registered
    .filter((m) => m.name.startsWith('travel_') && !catalogNames.has(m.name))
    .map((m) => m.name);

  const labelMismatch: {
    name: string;
    expected: readonly string[];
    actual: readonly string[];
  }[] = [];
  for (const entry of expected) {
    const actual = byName.get(entry.name);
    if (actual === undefined) continue;
    const a = [...actual.labels].sort();
    const b = [...entry.labels].sort();
    if (a.join(',') !== b.join(',')) {
      labelMismatch.push({ name: entry.name, expected: b, actual: a });
    }
  }

  return { missing, unregistered, labelMismatch };
}

export type { RegisteredMetric };
