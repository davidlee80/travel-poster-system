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
type Labels<T extends readonly string[]> = {
  [K in keyof T]: T[K] extends string ? ValidLabel<T[K]> : never;
};

interface MetricSpec<T extends readonly string[]> {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: Labels<T>;
}

function validate(name: string, labelNames: readonly string[] | undefined): string[] {
  const labels = [...(labelNames ?? [])];
  assertAllowedLabels(name, labels);
  return labels;
}

export function createCounter<const T extends readonly string[]>(
  spec: MetricSpec<T>,
): Counter<string> {
  const labelNames = validate(spec.name, spec.labelNames);
  const config: CounterConfiguration<string> = {
    name: spec.name,
    help: spec.help,
    labelNames,
    registers: [registry],
  };
  return new Counter(config);
}

export function createGauge<const T extends readonly string[]>(spec: MetricSpec<T>): Gauge<string> {
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
): Histogram<string> {
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
 * 分段 SLA 用的时间桶（设计稿 21.2 的 T1 < 75s / T2 < 110s / T3 < 240s|420s）。
 * 桶边界围绕这几个阈值布置，否则 P95 落在过宽的桶里无法判断是否违约。
 */
export const SLA_BUCKETS = [
  0.5, 1, 2, 5, 10, 20, 30, 45, 60, 75, 90, 110, 150, 200, 240, 300, 420, 600,
] as const;

/** 亚秒级操作用的时间桶（素材检索 < 800ms、标准化 < 500ms 等） */
export const FAST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1.5, 3, 5] as const;

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
