import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from 'prom-client';
import { assertAllowedLabels, type ValidLabel } from './labels.js';

/**
 * 对外暴露的最小指标接口。
 *
 * 不直接返回 prom-client 的 `Counter` 等类型，原因有两个：
 *   1. prom-client 是本包的依赖而非消费方的依赖，返回它的类型会让消费方
 *      的 `.d.ts` 引用 `../../packages/observability/node_modules/prom-client`
 *      这种不可移植的路径（TS2742）；
 *   2. 收窄接口能阻止消费方绕过本包直接操作 registry —— 那会绕开标签白名单。
 */
export interface Labels {
  readonly [label: string]: string | number;
}

/**
 * `labels` 一律必填（即使某个指标没有标签也要传 `{}`）。
 *
 * prom-client 允许省略它，但省略会产出一条标签全空的时间序列，
 * 与「按标签细分的序列」混在同一个指标名下，读图时极易误判。
 * 强制必填让「这个指标有哪些维度」在调用点就是显式的。
 */
export interface CounterMetric {
  inc(labels: Labels, value?: number): void;
}

export interface GaugeMetric {
  set(labels: Labels, value: number): void;
  inc(labels: Labels, value?: number): void;
  dec(labels: Labels, value?: number): void;
}

export interface HistogramMetric {
  observe(labels: Labels, value: number): void;
  startTimer(labels: Labels): (labels?: Labels) => number;
}

/**
 * Prometheus 指标注册与工厂（TP-0-05，设计稿 21.3）。
 *
 * P0 只建立注册表与受约束的工厂；21.3 的 18 个业务指标随各自功能在
 * P1～P5 逐步注册（各阶段任务已在实施计划中列明），此处不预先声明空指标 ——
 * 空指标会让「指标存在」与「指标有数据」混淆，反而削弱可观测性。
 */

export const registry = new Registry();

let defaultsRegistered = false;

/** 进程级默认指标（CPU、内存、事件循环延迟、GC） */
export function registerDefaultMetrics(serviceName: string): void {
  if (defaultsRegistered) return;
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  defaultsRegistered = true;
}

/**
 * 标签名数组的类型约束。
 * 传入 'user_id' 会得到一条明确的编译错误而不是难读的联合类型不匹配。
 */
type LabelNames<T extends readonly string[]> = {
  [K in keyof T]: T[K] extends string ? ValidLabel<T[K]> : never;
};

interface MetricSpec<T extends readonly string[]> {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: LabelNames<T>;
}

/**
 * 本进程已注册的指标及其标签集。
 *
 * prom-client 的 `getMetricsAsJSON()` 只给出**已有样本**的标签值，
 * 拿不到声明的 `labelNames` —— 而一个刚注册、还没 inc 过的 Counter 在那里
 * 是一条空 values 的记录。因此「注册了哪些标签」必须由我们自己的工厂记下来，
 * 否则 TP-5-01 的目录比对只能在指标有数据之后才生效，而那时漂移已经上线了。
 */
const registeredLabels = new Map<string, readonly string[]>();

function validate(name: string, labelNames: readonly string[] | undefined): string[] {
  const labels = [...(labelNames ?? [])];
  assertAllowedLabels(name, labels);
  registeredLabels.set(name, labels);
  return labels;
}

/** 本进程注册的指标清单，供 21.3 目录比对（见 catalog.ts 的 detectCatalogDrift） */
export function registeredMetrics(): readonly { name: string; labels: readonly string[] }[] {
  return [...registeredLabels].map(([name, labels]) => ({ name, labels }));
}

export function createCounter<const T extends readonly string[]>(
  spec: MetricSpec<T>,
): CounterMetric {
  const labelNames = validate(spec.name, spec.labelNames);
  const config: CounterConfiguration<string> = {
    name: spec.name,
    help: spec.help,
    labelNames,
    registers: [registry],
  };
  return new Counter(config);
}

export function createGauge<const T extends readonly string[]>(spec: MetricSpec<T>): GaugeMetric {
  const labelNames = validate(spec.name, spec.labelNames);
  const config: GaugeConfiguration<string> = {
    name: spec.name,
    help: spec.help,
    labelNames,
    registers: [registry],
  };
  return new Gauge(config);
}

export function createHistogram<const T extends readonly string[]>(
  spec: MetricSpec<T> & { readonly buckets?: readonly number[] },
): HistogramMetric {
  const labelNames = validate(spec.name, spec.labelNames);
  const config: HistogramConfiguration<string> = {
    name: spec.name,
    help: spec.help,
    labelNames,
    registers: [registry],
    ...(spec.buckets ? { buckets: [...spec.buckets] } : {}),
  };
  return new Histogram(config);
}

/**
 * 分段 SLA 用的时间桶（设计稿 21.2 的 T1 < 75s / T2 < 155s / T3 < 240s|420s）。
 * 桶边界围绕这几个阈值布置，否则 P95 落在过宽的桶里无法判断是否违约。
 *
 * 110 与 155 两个边界都保留：T2 目标已从 110 调到 155（多模型候选池把素材
 * 窗口从 35 秒放宽到 80 秒），而删掉 110 会让历史数据在那一档失去分辨率。
 *
 * **155 必须是一个真正的桶边界。** 它之前不是 —— 最近的边界是 150 与 200，
 * 于是 `histogram_quantile` 在一个 50 秒宽的桶里线性插值，而告警阈值恰好落在
 * 那个桶内：实际 P95 是 151 还是 199 都只能靠插值猜。这恰是本注释开头
 * 那句「否则 P95 落在过宽的桶里无法判断是否违约」要防的情形。
 */
export const SLA_BUCKETS = [
  0.5, 1, 2, 5, 10, 20, 30, 45, 60, 75, 90, 110, 150, 155, 200, 240, 300, 420, 600,
] as const;

/** 亚秒级操作用的时间桶（素材检索 < 800ms、标准化 < 500ms 等） */
export const FAST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1.5, 3, 5] as const;

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
