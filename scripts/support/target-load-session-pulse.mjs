import { performance } from 'node:perf_hooks';
import { setMaxListeners } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { loadTargetScope } from './target-load-guard.mjs';
import { validateTargetLoadManifest } from './target-load-manifest.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_SESSION_PULSE_FAILED'); }

// A separate descriptive read pulse: 1,000 distinct retained Employee sessions,
// one read each over sixty seconds. It establishes neither a user activity cadence
// nor simultaneous active-user or concurrent-booking capacity.
export async function runTargetSessionPulse({ values, manifest, transport, clock = Date.now,
  monotonic = performance.now.bind(performance), sleep = wait } = {}) {
  const abort = new AbortController(); let timer;
  try {
    const scope = loadTargetScope(values, clock()); const data = validateTargetLoadManifest(manifest, values, clock());
    valid(data.employees.length >= 1000 && typeof transport?.exchange === 'function' && clock() + 150_000 < scope.expiresMs);
    setMaxListeners(34, abort.signal); timer = setTimeout(() => abort.abort(), 90_000);
    const started = monotonic(); let previous = started; let next = 0; let failed = false; const results = Array(1000);
    function elapsed() {
      const now = monotonic(); valid(Number.isFinite(now) && now >= previous); previous = now; return now - started;
    }
    const workers = Array.from({ length: 16 }, async () => {
      while (!failed && next < 1000) {
        const index = next++;
        try {
          while (elapsed() < index * 60) await sleep(Math.ceil(index * 60 - elapsed()), undefined, { signal: abort.signal });
          abort.signal.throwIfAborted(); loadTargetScope(values, clock()); const at = elapsed(); const actor = data.employees[index];
          const response = await transport.exchange({ kind: 'session_read', method: 'GET', path: '/api/v1/session',
            binary: false, cookie: actor.cookie, signal: abort.signal });
          valid(response.status === 200 && response.body?.user?.id === actor.userId && response.body?.tenant?.id === actor.tenantId
            && Array.isArray(response.body.roles) && response.body.roles.length === 1 && response.body.roles[0] === 'employee'
            && /^[A-Za-z0-9_-]{43}$/.test(response.body.csrfToken)
            && Number.isSafeInteger(response.payloadBytes) && response.payloadBytes > 0 && response.payloadBytes <= 8192
            && Number.isFinite(response.latencyMs) && response.latencyMs >= 0 && response.latencyMs <= 60_000);
          results[index] = { latencyMs: response.latencyMs, payloadBytes: response.payloadBytes, scheduleLagMs: at - index * 60 };
        } catch { failed = true; abort.abort(); throw new Error('LOAD_TARGET_SESSION_PULSE_FAILED'); }
      }
    });
    const settled = await Promise.allSettled(workers);
    valid(settled.every(row => row.status === 'fulfilled') && results.filter(Boolean).length === 1000);
    loadTargetScope(values, clock());
    function percentiles(key) {
      const sorted = results.map(row => row[key]).sort((left, right) => left - right);
      return { p50: sorted[499], p95: sorted[949], p99: sorted[989] };
    }
    const latencyMs = percentiles('latencyMs');
    return { retainedEmployees: data.employees.length, distinctSessionsRead: 1000, requests: 1000,
      intendedArrivalIntervalMs: 60, durationMs: elapsed(), latencyMs,
      scheduleLagMs: percentiles('scheduleLagMs'), payloadBytes: results.reduce((sum, row) => sum + row.payloadBytes, 0),
      technicalErrors: 0, warmObjectivesMet: latencyMs.p95 <= 1000 && latencyMs.p99 <= 2000,
      thousandSimultaneouslyActiveUsersProven: false, concurrentBookingCapacityProven: false };
  } catch { abort.abort(); throw new Error('LOAD_TARGET_SESSION_PULSE_FAILED'); }
  finally { clearTimeout(timer); }
}
