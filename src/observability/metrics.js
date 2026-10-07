import { assertTelemetryRouteKey } from './route-vocabulary.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER']);
const BOOKING_OPERATIONS = new Set(['availability', 'reservation_validation', 'create', 'update', 'cancel']);
const OUTCOMES = new Set(['success', 'failure', 'denied']);
const DEPENDENCY_STATES = new Set(['healthy', 'degraded', 'unavailable']);
const MAX_DURATION_MS = 120_000;
const PAYLOAD_CLASSES = new Set(['json', 'image', 'other', 'empty']);

function assertEnum(value, allowed, code) {
  if (!allowed.has(value)) throw new TypeError(code);
  return value;
}

function statusClass(statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new TypeError('METRIC_STATUS_INVALID');
  }
  return `${Math.floor(statusCode / 100)}xx`;
}

function boundedDuration(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('METRIC_DURATION_INVALID');
  return Math.min(Math.round(value), MAX_DURATION_MS);
}

function labelsKey(metric, labels) {
  return `${metric}:${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',')}`;
}

export function createMetricsRegistry({
  write = null,
  assertRouteKey = (route) => assertTelemetryRouteKey(route, 'METRIC_ROUTE_INVALID'),
} = {}) {
  if (write !== null && typeof write !== 'function') throw new TypeError('METRIC_WRITER_INVALID');
  if (typeof assertRouteKey !== 'function') throw new TypeError('METRIC_ROUTE_VALIDATOR_INVALID');
  const counters = new Map();
  const durations = new Map();

  function emit(sample) {
    if (!write) return;
    write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'metric_sample',
      ...sample,
    })}\n`);
  }

  function increment(metric, labels, amount = 1) {
    const key = labelsKey(metric, labels);
    const current = counters.get(key) || { metric, labels: Object.freeze({ ...labels }), value: 0 };
    const value = current.value + amount;
    if (!Number.isSafeInteger(value)) throw new TypeError('METRIC_COUNTER_OVERFLOW');
    counters.set(key, { ...current, value });
    emit({ metric, labels, value: amount });
  }

  function observe(metric, labels, durationMs) {
    const key = labelsKey(metric, labels);
    const current = durations.get(key) || {
      metric,
      labels: Object.freeze({ ...labels }),
      count: 0,
      sumMs: 0,
      maxMs: 0,
    };
    const duration = boundedDuration(durationMs);
    durations.set(key, {
      ...current,
      count: current.count + 1,
      sumMs: current.sumMs + duration,
      maxMs: Math.max(current.maxMs, duration),
    });
    emit({ metric, labels, valueMs: duration });
  }

  return Object.freeze({
    recordApiRequest({ route, method, statusCode, durationMs }) {
      const labels = Object.freeze({
        route: assertRouteKey(route),
        method: assertEnum(method, METHODS, 'METRIC_METHOD_INVALID'),
        status: statusClass(statusCode),
      });
      increment('api_requests_total', labels);
      observe('api_request_duration_ms', labels, durationMs);
    },

    recordAuthenticationFailure() {
      increment('authentication_failures_total', Object.freeze({ reason: 'unauthorized' }));
    },

    recordResponsePayload({ route, method, statusCode, payloadClass, bytes }) {
      const labels = Object.freeze({
        route: assertRouteKey(route),
        method: assertEnum(method, METHODS, 'METRIC_METHOD_INVALID'),
        status: statusClass(statusCode),
        payload: assertEnum(payloadClass, PAYLOAD_CLASSES, 'METRIC_PAYLOAD_CLASS_INVALID'),
      });
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('METRIC_BYTES_INVALID');
      increment('api_response_payload_bytes_total', labels, bytes);
      increment('api_response_payload_observations_total', labels);
    },

    recordAuthorizationDenied() {
      increment('authorization_denials_total', Object.freeze({ reason: 'forbidden' }));
    },

    recordProjectionBatch({ refreshedCount = 0, retryCount = 0, poisonCount = 0, reconciliationCount = null }) {
      const mode = reconciliationCount === null ? 'event' : 'reconciliation';
      const counts = { refreshed: reconciliationCount ?? refreshedCount, retry: retryCount, poison: poisonCount };
      if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100)) {
        throw new TypeError('METRIC_PROJECTION_COUNT_INVALID');
      }
      increment('platform_projection_batches_total', Object.freeze({ mode }));
      for (const [outcome, count] of Object.entries(counts)) {
        increment('platform_projection_outcomes_total', Object.freeze({ mode, outcome }), count);
      }
    },

    recordBookingOperation({ operation, outcome }) {
      increment('booking_operations_total', Object.freeze({
        operation: assertEnum(operation, BOOKING_OPERATIONS, 'METRIC_BOOKING_OPERATION_INVALID'),
        outcome: assertEnum(outcome, OUTCOMES, 'METRIC_OUTCOME_INVALID'),
      }));
    },

    recordIntegrationCall({ operation, outcome, retryable, durationMs }) {
      if (typeof retryable !== 'boolean') throw new TypeError('METRIC_RETRYABLE_INVALID');
      const labels = Object.freeze({
        operation: assertEnum(operation, BOOKING_OPERATIONS, 'METRIC_INTEGRATION_OPERATION_INVALID'),
        outcome: assertEnum(outcome, OUTCOMES, 'METRIC_OUTCOME_INVALID'),
        retryable: retryable ? 'true' : 'false',
      });
      increment('integration_calls_total', labels);
      observe('integration_call_duration_ms', labels, durationMs);
    },

    recordDependencyState({ state, required }) {
      if (typeof required !== 'boolean') throw new TypeError('METRIC_DEPENDENCY_REQUIRED_INVALID');
      increment('dependency_health_observations_total', Object.freeze({
        state: assertEnum(state, DEPENDENCY_STATES, 'METRIC_DEPENDENCY_STATE_INVALID'),
        required: required ? 'true' : 'false',
      }));
    },

    snapshot() {
      return Object.freeze({
        counters: Object.freeze([...counters.values()]
          .sort((left, right) => labelsKey(left.metric, left.labels).localeCompare(labelsKey(right.metric, right.labels)))
          .map((entry) => Object.freeze({ ...entry }))),
        durations: Object.freeze([...durations.values()]
          .sort((left, right) => labelsKey(left.metric, left.labels).localeCompare(labelsKey(right.metric, right.labels)))
          .map((entry) => Object.freeze({ ...entry }))),
      });
    },
  });
}
