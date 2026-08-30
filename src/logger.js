import { assertTelemetryRouteKey } from './observability/route-vocabulary.js';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const HEALTH_STATES = new Set(['ready', 'degraded', 'not_ready']);
const SECURITY_CATEGORIES = new Set(['authentication', 'authorization']);
const OUTPUT_WRITERS = new WeakMap();

function nonAuthoritativeOutputWriter(output) {
  if (!output || typeof output.write !== 'function' || typeof output.on !== 'function') {
    throw new TypeError('INVALID_LOG_OUTPUT');
  }

  const existing = OUTPUT_WRITERS.get(output);
  if (existing) return existing;

  const state = { failed: false };
  output.on('error', () => {
    state.failed = true;
  });

  const writer = (line) => {
    if (state.failed) return;
    try {
      output.write(line, (error) => {
        if (error) state.failed = true;
      });
    } catch {
      state.failed = true;
    }
  };
  OUTPUT_WRITERS.set(output, writer);
  return writer;
}

function assertEnum(value, allowed, code) {
  if (!allowed.has(value)) throw new TypeError(code);
  return value;
}

export function createLogger({ write, output = process.stdout, level = 'info' } = {}) {
  if (!LEVELS.has(level)) throw new TypeError('INVALID_LOG_LEVEL');
  const writeLine = write ?? nonAuthoritativeOutputWriter(output);

  function emit(entry) {
    const safeEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    writeLine(`${JSON.stringify(safeEntry)}\n`);
  }

  return Object.freeze({
    requestCompleted({ requestId, method, route, statusCode, durationMs }) {
      emit({
        level: 'info',
        event: 'request_completed',
        requestId,
        method,
        route: assertTelemetryRouteKey(route, 'LOG_ROUTE_INVALID'),
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
