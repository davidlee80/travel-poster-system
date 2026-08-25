export {
  CUSTOM_TEXT_MAX_CHARS,
  DEFAULT_PACE_LEVEL,
  PACE_DEFAULTS,
  PACE_LEVELS,
  computeBudgetTotals,
  computeTotalDays,
  computeTravelerCount,
  isMultiCity,
  normalizeTravelRequest,
  planCities,
  planFlexibilityDays,
  resolvePace,
  truncateCustomText,
} from './normalize.js';

export {
  deriveConstraints,
  sortConstraints,
  type DerivedConstraints,
} from './constraints.js';

export {
  MAX_DESTINATIONS,
  MAX_FLEXIBILITY_DAYS,
  MAX_TRIP_DAYS,
  MIN_DAILY_BUDGET_PER_PERSON,
  MIN_DAILY_BUDGET_PER_PERSON_CNY,
  MIN_TRIP_DAYS,
  REQUEST_RULE_IDS,
  checkRequestConflicts,
  todayInTimezone,
  type ConflictCheckContext,
  type RequestRuleId,
  type RequestViolation,
} from './conflicts.js';

export {
  prepareTravelRequest,
  type PrepareRequestOptions,
  type PrepareRequestResult,
} from './prepare-request.js';

export { FIXTURE_TODAY, makeRequestFixture, type RequestFixtureOverrides } from './fixtures.js';

// ── 3.2.1 业务规则校验与 3.2.2 两级修复 ─────────────────────

export {
  LAST_MINUTE_OF_DAY,
  MINUTES_PER_DAY,
  addDays,
  dateForDay,
  minutesToTime,
  timeToMinutes,
} from './plan-time.js';

export {
  BUDGET_MAX_TOLERANCE_RATIO,
  BUDGET_MIN_RATIO,
  DEFAULT_LATEST_END_TIME,
  DURATION_TOLERANCE_MINUTES,
  FOOD_MAX_PER_DAY,
  FOOD_MIN_PER_DAY,
  MIN_ROUTE_NODES,
  NO_LATE_NIGHT_CODE,
  PLAN_RULES,
  PLAN_RULE_COUNT,
  PLAN_RULE_IDS,
  SENIOR_WALKING_LIMIT_KM,
  SHOULD_SATISFACTION_MIN_RATIO,
  SUBTITLE_MAX_CHARS,
  THEME_MAX_CHARS,
  TIGHTENED_LATEST_END_TIME,
  TITLE_MAX_CHARS,
  WALKING_TOLERANCE_RATIO,
  comparableTotal,
  deriveBudget,
  effectiveWalkingLimitKm,
  hasBlocking,
  latestEndTime,
  round2,
  validatePlan,
  violationsBySeverity,
  type DerivedBudget,
  type PlanRuleId,
  type PlanRuleSpec,
  type PlanValidationContext,
  type PlanViolation,
} from './plan-rules.js';

export {
  MARKDOWN_PATTERNS,
  PLACEHOLDER_PATTERN,
  cleanText,
  normalizeText,
  stripUrlAndHtml,
} from './plan-text.js';

export {
  MIN_SCHEDULE_MINUTES,
  addAssumption,
  degradeToAssumption,
  repairPlan,
  type RepairResult,
} from './repair-plan.js';

export {
  MAX_DETERMINISTIC_ROUNDS,
  MAX_REGENERATIONS,
  resolvePlan,
  type RegeneratePlan,
  type RegenerationRequest,
  type ResolvePlanObserver,
  type ResolvePlanOptions,
  type ResolvePlanResult,
  type ResolvePlanSummary,
} from './resolve-plan.js';

export {
  buildRetrievalProjection,
  normalizedRequestToEmbeddingText,
  parseRetrievalProjection,
  projectionToEmbeddingText,
} from './retrieval-projection.js';

export {
  FIXTURE_PLAN_DAYS,
  FIXTURE_PLAN_START_DATE,
  makeValidContext,
  makeValidPlan,
  makeValidRequest,
} from './plan-fixtures.js';
