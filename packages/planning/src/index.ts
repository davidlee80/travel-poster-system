export {
  CUSTOM_TEXT_MAX_CHARS,
  DEFAULT_PACE_LEVEL,
  PACE_DEFAULTS,
  PACE_LEVELS,
  computeBudgetTotals,
  computeTotalDays,
  computeTravelerCount,
  normalizeTravelRequest,
  resolvePace,
  truncateCustomText,
} from './normalize.js';

export {
  MAX_TRIP_DAYS,
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
