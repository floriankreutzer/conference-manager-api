import { randomUUID } from 'node:crypto';
import { applySecurityHeaders, assertRequestHost } from '../../src/security.js';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { loadObserverAuthorized, loadTargetScope } from './target-load-guard.mjs';

const COUNTERS = new Set(['api_requests_total', 'api_response_payload_bytes_total',
  'api_response_payload_observations_total', 'authentication_failures_total', 'authorization_denials_total',
  'platform_projection_batches_total', 'platform_projection_outcomes_total', 'booking_operations_total',
  'integration_calls_total', 'dependency_health_observations_total']);
const OBSERVER_PATH = '/__load/observe';
const DRAIN_RESERVE_MS = 10_000;

function valid(value) { if (!value) throw new Error('LOAD_RUNTIME_BOUNDARY_INVALID'); }
function integer(value) { valid(Number.isSafeInteger(value) && value >= 0); return value; }

function metricTotals(metrics) {
  const snapshot = metrics.snapshot();
  valid(Array.isArray(snapshot.counters) && snapshot.counters.length <= 5000);
  const totals = Object.fromEntries([...COUNTERS].map(name => [name, 0]));
  for (const row of snapshot.counters) {
    valid(COUNTERS.has(row.metric));
    totals[row.metric] = integer(totals[row.metric] + integer(row.value));
  }
  return totals;
}

function respond(response, status, body = '') {
  applySecurityHeaders(response, { mode: 'production' });
  response.writeHead(status, { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Connection': 'close' });
  response.end(body);
}

// Test-target boundary only. Replaces the single canonical request listener,
// preserving the normal HTTP configuration and every business/session handler.
// It never adds a second listener that could continue after an observer denial.
export function createLoadRuntimeBoundary({ values, metrics, limits, calendar = null, clock = Date.now,
  resources = () => ({ cpu: process.cpuUsage(), memory: process.memoryUsage() }), activity = null, bootId = randomUUID(),
  postgres = () => ({ queries: 0, bytesRead: 0, bytesWritten: 0 }) } = {}) {
  try {
    const checkedMs = clock();
    const scope = loadTargetScope(values, checkedMs);
    const publicOrigin = `https://${values.serviceName}.onrender.com`;
    valid(scope.surface !== 'setup' && typeof metrics?.snapshot === 'function'
      && typeof resources === 'function' && typeof postgres === 'function' && isInternalUuid(bootId));
    valid(limits && ['rateLimitMax', 'rateLimitWindowMs', 'databasePoolMax'].every(key =>
      Number.isSafeInteger(limits[key]) && limits[key] > 0));
    const publicLimits = Object.freeze({ rateLimitMax: limits.rateLimitMax, rateLimitWindowMs: limits.rateLimitWindowMs,
      databasePoolMax: limits.databasePoolMax });
    const startedMs = clock();
    const admissionEnd = scope.expiresMs - DRAIN_RESERVE_MS;
    valid(Number.isSafeInteger(startedMs) && startedMs >= checkedMs && startedMs < admissionEnd);
    let closed = false; let installed = false; let timer; let previousMs = startedMs;
    function admitted() {
      try {
        const now = clock();
        if (!Number.isSafeInteger(now) || now < previousMs || now < startedMs || now >= admissionEnd) closed = true;
        previousMs = now; return !closed;
      } catch { closed = true; return false; }
    }
    function observe() {
      const sample = resources();
      const memory = Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']
        .map(key => [key, integer(sample.memory[key])]));
      const cpu = { userMicros: integer(sample.cpu.user), systemMicros: integer(sample.cpu.system) };
      const value = { schemaVersion: 1, runId: scope.runId, surface: scope.surface, releaseSha: scope.releaseSha,
        bootId, startedAt: new Date(startedMs).toISOString(), observedAt: new Date(previousMs).toISOString(),
        expiresAt: scope.expiresAt, limits: publicLimits, uptimeMs: previousMs - startedMs, cpu, memory,
        metricTotals: metricTotals(metrics) };
      const database = postgres();
      value.postgres = Object.fromEntries(['queries', 'bytesRead', 'bytesWritten'].map(key => [key, integer(database[key])]));
      if (calendar !== null) {
        const snapshot = calendar.snapshot();
        value.simulatedCalendar = Object.fromEntries(['availability', 'create', 'update', 'cancel', 'uniqueEvents']
          .map(key => [key, integer(snapshot[key])]));
      }
      if (activity !== null) {
        const sample = activity();
        value.activity = Object.fromEntries(['workerFailures', 'storageReads', 'storageReadBytes',
          'storageWrites', 'storageWriteBytes', 'storageDeletes', 'storageFailures']
          .map(key => [key, integer(sample[key])]));
      }
      const body = JSON.stringify(value);
      valid(Buffer.byteLength(body) <= 8192); return body;
    }
    return Object.freeze({
      install(server) {
        valid(!installed && server?.listeners('request').length === 1);
        const [handler] = server.listeners('request');
        server.removeListener('request', handler);
        server.on('request', (request, response) => {
          if (!admitted()) { respond(response, 503); return; }
          if (typeof request.url === 'string' && request.url.startsWith('/__load')) {
            try {
              const hostCount = request.rawHeaders.reduce((count, name, index) =>
                count + (index % 2 === 0 && name.toLowerCase() === 'host' ? 1 : 0), 0);
              valid(hostCount === 1);
              assertRequestHost(request.headers, publicOrigin);
            } catch { respond(response, 404); return; }
            const authorizationCount = request.rawHeaders.reduce((count, name, index) =>
              count + (index % 2 === 0 && name.toLowerCase() === 'authorization' ? 1 : 0), 0);
            if (request.url !== OBSERVER_PATH || request.method !== 'GET' || authorizationCount !== 1
              || request.headers['transfer-encoding'] !== undefined
              || ![undefined, '0'].includes(request.headers['content-length'])
              || !loadObserverAuthorized(request.headers.authorization, scope.observerToken)) {
              respond(response, 404); return;
            }
            try { respond(response, 200, observe()); }
            catch { respond(response, 503); }
            return;
          }
          handler.call(server, request, response);
        });
        installed = true;
      },
      // Start before asynchronous provider setup, so startup time cannot renew
      // the absolute lifetime. The entrypoint retains a separate hard-exit timer.
      arm(onDrain) {
        valid(timer === undefined && typeof onDrain === 'function' && admitted());
        timer = setTimeout(() => { closed = true; onDrain(); }, Math.max(0, admissionEnd - previousMs));
        timer.unref();
      },
      close() { closed = true; clearTimeout(timer); },
    });
  } catch { throw new Error('LOAD_RUNTIME_BOUNDARY_INVALID'); }
}
