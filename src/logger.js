const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

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
    requestCompleted({ requestId, method, path, statusCode, durationMs }) {
      emit({ level: 'info', event: 'request_completed', requestId, method, path, statusCode, durationMs });
    },
    unhandledError({ requestId, errorName }) {
      emit({ level: 'error', event: 'unhandled_error', requestId, errorName });
    },
    lifecycle({ event }) {
      emit({ level: 'info', event });
    },
  });
}
