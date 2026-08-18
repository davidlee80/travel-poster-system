export {
  ALLOWED_LABELS,
  assertAllowedLabels,
  type AllowedLabel,
  type ForbiddenLabel,
  type ValidLabel,
} from './labels.js';

export {
  METRICS_CATALOG,
  catalogFor,
  detectCatalogDrift,
  type CatalogDrift,
  type CatalogEntry,
  type MetricKind,
  type MetricOwner,
} from './catalog.js';

export {
  FAST_BUCKETS,
  SLA_BUCKETS,
  createCounter,
  createGauge,
  createHistogram,
  metricsContentType,
  metricsText,
  registerDefaultMetrics,
  registeredMetrics,
  registry,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
  type Labels,
} from './metrics.js';

export { SpanStatusCode, currentTraceId, tracer, withSpan, type Span } from './tracing.js';
