import { DAY_MS, PRODUCT_METRIC_IDS, exactProductObject, productInstant,
  productMetric, requireProductCondition } from './product-delivery-contract.js';

export const PRODUCT_RUNTIME_MAX_EVENTS = 2000;
export const PRODUCT_RUNTIME_COVERAGE_STATES = Object.freeze(['complete', 'partial', 'not_collected']);
export const PRODUCT_RUNTIME_COVERAGE_REASONS = Object.freeze([
  'complete_window', 'retained_history', 'source_unavailable', 'source_limit',
  'integrity_failure', 'missing_attribution', 'missing_start_clock',
]);
export const PRODUCT_RUNTIME_NULL_REASONS = Object.freeze([
  'source_unavailable', 'source_limit', 'integrity_failure', 'missing_attribution',
  'missing_start_clock', 'empty_denominator',
]);

// This is a separate live Product projection. Daily delivery and feedback retain
// their own v1 contracts and observation clocks; they cannot be refreshed here.
export function normalizeRuntimeProductReport(value) {
  exactProductObject(value, ['schemaVersion', 'environment', 'collectionMode', 'accessMode',
    'observedAt', 'evaluatedAt', 'periodStart', 'periodEnd', 'freshness', 'sourceState',
    'product', 'productCoverage', 'provenance']);
  requireProductCondition(value.schemaVersion === 2 && value.environment === 'demo'
    && value.collectionMode === 'runtime_projection' && value.accessMode === 'shared_owner_password');
  const observed = productInstant(value.observedAt);
  const evaluated = productInstant(value.evaluatedAt);
  const start = productInstant(value.periodStart);
  const end = productInstant(value.periodEnd);
  requireProductCondition(end === observed && end - start === 28 * DAY_MS
    && evaluated >= observed && evaluated - observed < 30 * DAY_MS
    && ['available', 'last_good'].includes(value.sourceState)
    && value.freshness === (evaluated - observed >= DAY_MS ? 'stale' : 'fresh'));
  requireProductCondition(Array.isArray(value.product) && value.product.length === PRODUCT_METRIC_IDS.length
    && Array.isArray(value.productCoverage) && value.productCoverage.length === PRODUCT_METRIC_IDS.length);
  for (let index = 0; index < PRODUCT_METRIC_IDS.length; index += 1) {
    const id = PRODUCT_METRIC_IDS[index];
    const item = value.product[index];
    const coverage = value.productCoverage[index];
    exactProductObject(item, ['id', 'unit', 'value', 'reason']);
    exactProductObject(coverage, ['id', 'state', 'reason', 'sourcePeriodStart', 'sourcePeriodEnd']);
    requireProductCondition(item.id === id && item.unit === productMetric(id).unit
      && coverage.id === id && PRODUCT_RUNTIME_COVERAGE_STATES.includes(coverage.state)
      && PRODUCT_RUNTIME_COVERAGE_REASONS.includes(coverage.reason));
    if (coverage.state === 'not_collected') {
      requireProductCondition(coverage.sourcePeriodStart === null && coverage.sourcePeriodEnd === null
        && item.value === null && !['complete_window', 'retained_history'].includes(coverage.reason));
    } else {
      requireProductCondition(coverage.sourcePeriodStart === value.periodStart
        && coverage.sourcePeriodEnd === value.periodEnd
        && (coverage.state === 'complete'
          ? coverage.reason === 'complete_window'
          : ['retained_history', 'missing_attribution', 'missing_start_clock'].includes(coverage.reason)));
    }
    if (item.value === null) {
      requireProductCondition(PRODUCT_RUNTIME_NULL_REASONS.includes(item.reason));
    } else {
      requireProductCondition(coverage.state !== 'not_collected' && item.reason === 'available'
        && typeof item.value === 'number' && Number.isFinite(item.value) && item.value >= 0
        && (item.unit !== 'count' || (Number.isSafeInteger(item.value)
          && item.value <= PRODUCT_RUNTIME_MAX_EVENTS))
        && (item.unit !== 'milliseconds' || (item.value < 28 * DAY_MS && Number.isSafeInteger(item.value * 2)))
        && (item.unit !== 'ratio' || item.value <= 1));
    }
  }
  const metric = (id) => value.product[PRODUCT_METRIC_IDS.indexOf(id)].value;
  const countTotal = value.product.filter((item) => item.unit === 'count')
    .reduce((sum, item) => sum + (item.value ?? 0), 0);
  exactProductObject(value.provenance, ['mode', 'sourceDigest', 'eventCount', 'sourceEpoch']);
  requireProductCondition(value.provenance.mode === 'retained_runtime'
    && typeof value.provenance.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(value.provenance.sourceDigest)
    && typeof value.provenance.sourceEpoch === 'string' && /^[a-f0-9]{64}$/.test(value.provenance.sourceEpoch)
    && Number.isSafeInteger(value.provenance.eventCount)
    && value.provenance.eventCount >= countTotal
    && value.provenance.eventCount <= PRODUCT_RUNTIME_MAX_EVENTS);
  if (metric('time_to_submit') !== null) requireProductCondition(metric('request_started') > 0
    && metric('request_submitted') > 0);
  if (metric('manager_decision_time') !== null) requireProductCondition(metric('manager_decisions') > 0
    && metric('request_submitted') > 0);
  const completed = metric('recovery_completed');
  const failed = metric('recovery_failed');
  const rate = metric('recovery_failure_rate');
  if (rate !== null) requireProductCondition(completed !== null && failed !== null
    && completed + failed > 0 && rate === failed / (completed + failed));
  return Object.freeze(structuredClone(value));
}
