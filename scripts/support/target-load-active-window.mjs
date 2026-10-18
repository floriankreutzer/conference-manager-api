import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { loadTargetScope } from './target-load-guard.mjs';
import { runTargetSessionPulse } from './target-load-session-pulse.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_ACTIVE_WINDOW_FAILED'); }

// Explicit MODEL: 1,000 already verified sessions, five-minute refresh cadence,
// ten-minute rolling activity. This is not 1,000 simultaneous HTTP requests or
// an owner-approved universal definition of an active business user.
export async function runTargetActiveSessionWindow({ values, manifest, transport, initialActivityAgeMs,
  signal, clock = Date.now, monotonic = performance.now.bind(performance), sleep = wait,
  pulse = runTargetSessionPulse } = {}) {
  try {
    const scope = loadTargetScope(values, clock());
    valid(signal instanceof AbortSignal && Number.isFinite(initialActivityAgeMs) && initialActivityAgeMs >= 0
      && initialActivityAgeMs <= 180_000 && clock() + 960_000 < scope.expiresMs);
    const started = monotonic(); let previous = started;
    function elapsed() {
      const now = monotonic(); valid(Number.isFinite(now) && now >= previous); previous = now; return now - started;
    }
    const waves = [];
    for (let wave = 0; wave < 3; wave += 1) {
      const scheduledAtMs = wave * 300_000;
      while (elapsed() < scheduledAtMs) await sleep(Math.ceil(scheduledAtMs - elapsed()), undefined, { signal });
      signal.throwIfAborted(); loadTargetScope(values, clock()); const actualStartMs = elapsed();
      const result = await pulse({ values, manifest, transport, clock, monotonic, sleep, profile: 'active200', signal });
      const completedAtMs = elapsed();
      valid(result.profile === 'active200' && result.requests === 1000 && result.distinctSessionsRead === 1000
        && result.technicalErrors === 0 && result.intendedArrivalIntervalMs === 200
        && Number.isFinite(result.durationMs) && result.durationMs >= 0 && result.durationMs <= 230_000);
      // Conservative coverage without publishing per-user timestamps: every
      // wave verified ALL the same sessions between its actual start/end.
      const maximumGapMs = wave === 0 ? initialActivityAgeMs + completedAtMs
        : completedAtMs - waves[wave - 1].actualStartMs;
      valid(maximumGapMs <= 600_000);
      waves.push({ scheduledAtMs, actualStartMs, completedAtMs, maximumGapMs, observation: result });
    }
    while (elapsed() < 900_000) await sleep(Math.ceil(900_000 - elapsed()), undefined, { signal });
    signal.throwIfAborted(); loadTargetScope(values, clock());
    valid(elapsed() - waves[2].actualStartMs <= 600_000);
    return { distinctActiveSessions: 1000, requests: 3000, intendedDurationMs: 900_000, durationMs: elapsed(),
      modeledActivityWindowMs: 600_000, refreshCadenceMs: 300_000, initialActivityAgeMs,
      fullModeledWindowCoverageMet: true, waves, technicalErrors: 0,
      warmObjectivesMet: waves.every(row => row.observation.warmObjectivesMet === true),
      businessActivityDefinitionOwnerApproved: false, simultaneousHttpConcurrencyClaim: false };
  } catch { throw new Error('LOAD_TARGET_ACTIVE_WINDOW_FAILED'); }
}
