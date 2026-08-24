const ROUTES = new Set([
  'health_live',
  'health_ready',
  'health_status',
  'session',
  'audit',
  'request',
  'request_transition',
  'not_found',
  'invalid_request',
]);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BOOKING_OPERATIONS = new Set(['availability', 'reservation_validation', 'create', 'update', 'cancel']);
const OUTCOMES = new Set(['success', 'failure', 'denied']);
const DEPENDENCY_STATES = new Set(['healthy', 'degraded', 'unavailable']);
const MAX_DURATION_MS = 120_000;

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

export function createMetricsRegistry() {
  const counters = new Map();
  const durations = new Map();

  function increment(metric, labels) {
    const key = labelsKey(metric, labels);
    const current = counters.get(key) || { metric, labels: Object.freeze({ ...labels }), value: 0 };
    counters.set(key, { ...current, value: current.value + 1 });
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
  }

  return Object.freeze({
    recordApiRequest({ route, method, statusCode, durationMs }) {
      const labels = Object.freeze({
        route: assertEnum(route, ROUTES, 'METRIC_ROUTE_INVALID'),
        method: assertEnum(method, METHODS, 'METRIC_METHOD_INVALID'),
        status: statusClass(statusCode),
      });
      increment('api_requests_total', labels);
      observe('api_request_duration_ms', labels, durationMs);
    },

    recordAuthenticationFailure() {
      increment('authentication_failures_total', Object.freeze({ reason: 'unauthorized' }));
    },

    recordAuthorizationDenied() {
      increment('authorization_denials_total', Object.freeze({ reason: 'forbidden' }));
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
