const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const ROUTES = new Set([
  'health_live',
  'health_ready',
  'health_status',
  'entra_login',
  'entra_callback',
  'onboarding_start',
  'onboarding_claim',
  'session',
  'audit',
  'request',
  'request_transition',
  'not_found',
  'invalid_request',
]);
const HEALTH_STATES = new Set(['ready', 'degraded', 'not_ready']);
const SECURITY_CATEGORIES = new Set(['authentication', 'authorization']);

function assertEnum(value, allowed, code) {
  if (!allowed.has(value)) throw new TypeError(code);
  return value;
}

export function createLogger({ write = (line) => process.stdout.write(line), level = 'info' } = {}) {
  if (!LEVELS.has(level)) throw new TypeError('INVALID_LOG_LEVEL');

  function emit(entry) {
    const safeEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    write(`${JSON.stringify(safeEntry)}\n`);
  }

  return Object.freeze({
    requestCompleted({ requestId, method, route, statusCode, durationMs }) {
      emit({
        level: 'info',
        event: 'request_completed',
        requestId,
        method,
        route: assertEnum(route, ROUTES, 'LOG_ROUTE_INVALID'),
        statusCode,
        durationMs,
      });
    },
    unhandledError({ requestId, errorName }) {
      emit({ level: 'error', event: 'unhandled_error', requestId, errorName });
    },
    securityOutcome({ requestId, category }) {
      emit({
        level: 'warn',
        event: 'security_request_denied',
        requestId,
        category: assertEnum(category, SECURITY_CATEGORIES, 'LOG_SECURITY_CATEGORY_INVALID'),
      });
    },
    healthEvaluated({ requestId, status }) {
      emit({
        level: status === 'not_ready' ? 'error' : status === 'degraded' ? 'warn' : 'info',
        event: 'health_evaluated',
        requestId,
        status: assertEnum(status, HEALTH_STATES, 'LOG_HEALTH_STATUS_INVALID'),
      });
    },
    lifecycle({ event, serviceVersion, buildId, environment }) {
      emit({
        level: 'info',
        event,
        ...(serviceVersion ? { serviceVersion } : {}),
        ...(buildId ? { buildId } : {}),
        ...(environment ? { environment } : {}),
      });
    },
  });
}
