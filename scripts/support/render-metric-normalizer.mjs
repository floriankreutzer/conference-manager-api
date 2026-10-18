import {
  DAY_MS, exactProductObject, productInstant, requireProductCondition,
} from '../../src/observability/product-delivery-contract.js';

const HOUR_MS = 3_600_000;
const TYPES = Object.freeze({
  memory_usage: { suffix: 'memory', unit: 'bytes', resolutionSeconds: 300, maxSeries: 32, maxSamples: 2000 },
  bandwidth_usage: { suffix: 'bandwidth', unit: 'mb', resolutionSeconds: 3600, maxSeries: 1, maxSamples: 25 },
});

function metricType(type) {
  requireProductCondition(Object.hasOwn(TYPES, type));
  return TYPES[type];
}

// No transport or credentials: the connected collector supplies the fixed provider response.
export function renderMetricQuery(metricTypeName, queriedAt) {
  const type = metricType(metricTypeName);
  const time = productInstant(queriedAt);
  const end = metricTypeName === 'memory_usage' ? time : Math.floor(time / HOUR_MS) * HOUR_MS;
  return Object.freeze({
    metricTypes: [metricTypeName], resolution: type.resolutionSeconds,
    startTime: new Date(end - DAY_MS).toISOString(), endTime: new Date(end).toISOString(),
  });
}

function unavailable(id, reason) {
  return Object.freeze({
    measurement: Object.freeze({ id, value: null, observedAt: null, periodStart: null, periodEnd: null, sampleAt: null }),
    reason,
  });
}

function sampleInstant(value) {
  // Render uses RFC3339 seconds; normalize precision without changing the instant.
  requireProductCondition(typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value));
  const normalized = new Date(value).toISOString();
  requireProductCondition(normalized.slice(0, 19) === value.slice(0, 19));
  return productInstant(normalized);
}

export function normalizeRenderMetric(input) {
  exactProductObject(input, ['surface', 'metricType', 'queriedAt', 'observedAt', 'response']);
  requireProductCondition(['customer', 'operations'].includes(input.surface));
  const type = metricType(input.metricType);
  const id = `render_${input.surface}_${type.suffix}`;
  const query = renderMetricQuery(input.metricType, input.queriedAt);
  const observed = productInstant(input.observedAt);
  const queried = productInstant(input.queriedAt);
  requireProductCondition(observed >= queried && observed - queried <= 300_000);
  if (input.metricType === 'bandwidth_usage' && Math.floor(observed / HOUR_MS) !== Math.floor(queried / HOUR_MS)) {
    return unavailable(id, 'query_window_changed');
  }
  try {
    const metrics = input.response?.metrics;
    requireProductCondition(Array.isArray(metrics) && metrics.length <= 11);
    const groups = metrics.filter((item) => item?.type === input.metricType);
    if (!groups.length) return unavailable(id, 'no_samples');
    requireProductCondition(groups.length === 1);
    const series = groups[0].data;
    requireProductCondition(Array.isArray(series) && series.length <= type.maxSeries);
    let latest = null;
    let value = null;
    let conflicting = false;
    let sampleCount = 0;
    for (const row of series) {
      requireProductCondition(row?.unit === type.unit && Array.isArray(row.values));
      sampleCount += row.values.length;
      requireProductCondition(sampleCount <= type.maxSamples);
      for (const sample of row.values) {
        requireProductCondition(typeof sample?.value === 'number' && Number.isFinite(sample.value)
          && sample.value >= 0 && sample.value <= Number.MAX_SAFE_INTEGER
          && (input.metricType === 'bandwidth_usage' || Number.isSafeInteger(sample.value)));
        const time = sampleInstant(sample.timestamp);
        requireProductCondition(time >= productInstant(query.startTime) && time <= productInstant(query.endTime));
        if (latest === null || time > latest) {
          latest = time; value = sample.value; conflicting = false;
        } else if (time === latest && value !== sample.value) conflicting = true;
      }
    }
    if (latest === null) return unavailable(id, 'no_samples');
    if (conflicting) return unavailable(id, 'conflicting_latest_samples');
    return Object.freeze({
      measurement: Object.freeze({ id, value, observedAt: input.observedAt,
        periodStart: query.startTime, periodEnd: query.endTime, sampleAt: new Date(latest).toISOString() }),
      reason: null,
    });
  } catch {
    return unavailable(id, 'invalid_or_ambiguous_source');
  }
}
