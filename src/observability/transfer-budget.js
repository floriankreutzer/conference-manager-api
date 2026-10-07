const SOURCES = Object.freeze({
  database_transfer: 'bytes',
  application_egress: 'bytes',
  object_storage_egress: 'bytes',
  ci_runtime: 'seconds',
});
const THRESHOLDS = Object.freeze([50, 70, 85, 95]);

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('TRANSFER_BUDGET_SCHEMA_INVALID');
  }
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TRANSFER_BUDGET_AMOUNT_INVALID');
  return value;
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError('TRANSFER_BUDGET_TIME_INVALID');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError('TRANSFER_BUDGET_TIME_INVALID');
  }
  return time;
}

function percentage(amount, limit) {
  return Math.round((amount / limit) * 10_000) / 100;
}

function evaluateSource(entry, elapsedFraction) {
  exactObject(entry, ['source', 'unit', 'used', 'limit']);
  if (typeof entry.source !== 'string' || !Object.hasOwn(SOURCES, entry.source) || SOURCES[entry.source] !== entry.unit) {
    throw new TypeError('TRANSFER_BUDGET_SOURCE_INVALID');
  }
  const used = nonNegativeInteger(entry.used);
  const limit = nonNegativeInteger(entry.limit);
  if (limit === 0) throw new TypeError('TRANSFER_BUDGET_LIMIT_REQUIRED');
  const projected = Math.ceil(used / elapsedFraction);
  if (!Number.isSafeInteger(projected)) throw new TypeError('TRANSFER_BUDGET_PROJECTION_OVERFLOW');
  return Object.freeze({
    source: entry.source,
    unit: entry.unit,
    used,
    limit,
    utilizationPercent: percentage(used, limit),
    crossedThresholds: Object.freeze(THRESHOLDS.filter((threshold) => used / limit >= threshold / 100)),
    exhausted: used >= limit,
    projected,
    projectedUtilizationPercent: percentage(projected, limit),
    projectedExhaustion: projected >= limit,
  });
}

// Pure operator-side evaluation of externally collected billing-window totals.
// It does not fetch accounts, set quotas, block business traffic or charge resources.
export function evaluateTransferBudget(input) {
  exactObject(input, ['schemaVersion', 'periodStart', 'periodEnd', 'observedAt', 'measurements']);
  if (input.schemaVersion !== 1) throw new TypeError('TRANSFER_BUDGET_VERSION_INVALID');
  const start = instant(input.periodStart);
  const end = instant(input.periodEnd);
  const observed = instant(input.observedAt);
  if (end <= start || end - start > 32 * 86_400_000 || observed <= start || observed > end) {
    throw new TypeError('TRANSFER_BUDGET_WINDOW_INVALID');
  }
  if (!Array.isArray(input.measurements) || input.measurements.length < 1 || input.measurements.length > 4) {
    throw new TypeError('TRANSFER_BUDGET_MEASUREMENTS_INVALID');
  }
  const measurements = input.measurements.map((entry) => evaluateSource(entry, (observed - start) / (end - start)));
  if (new Set(measurements.map(({ source }) => source)).size !== measurements.length) {
    throw new TypeError('TRANSFER_BUDGET_DUPLICATE_SOURCE');
  }
  return Object.freeze({
    schemaVersion: 1,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    observedAt: input.observedAt,
    forecastMethod: 'linear_elapsed_window',
    measurements: Object.freeze(measurements.sort((left, right) => left.source.localeCompare(right.source))),
  });
}
