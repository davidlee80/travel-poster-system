export {
  ALLOWED_LABELS,
  assertAllowedLabels,
  type AllowedLabel,
  type ForbiddenLabel,
  type ValidLabel,
} from './labels.js';

export {
  FAST_BUCKETS,
  SLA_BUCKETS,
  createCounter,
  createGauge,
  createHistogram,
  metricsContentType,
  metricsText,
  registerDefaultMetrics,
  registry,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
  type Labels,
} from './metrics.js';

export { SpanStatusCode, currentTraceId, tracer, withSpan, type Span } from './tracing.js';
