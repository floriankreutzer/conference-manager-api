import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { runBookingLoadJourney } from './booking-load-journey.mjs';
import { requestLoadDraft } from './booking-load-draft.mjs';
import { loadTargetScope } from './target-load-guard.mjs';
import { validateTargetLoadManifest } from './target-load-manifest.mjs';

const PROFILES = Object.freeze({ sample10: { count: 10, intervalMs: 0 }, target200: { count: 200, intervalMs: 4500 } });
function valid(value) { if (!value) throw new Error('LOAD_TARGET_CAMPAIGN_FAILED'); }

// Closed choreography and arrival schedule, with four bounded journey workers.
// Lag remains observable if a slow server prevents the intended open arrival rate.
// This function has no database, setup, provider allocation or retry authority.
export async function runTargetBookingCampaign({ values, manifest, transport, profile = 'target200', slotOffset = 0,
  clock = Date.now, monotonic = performance.now.bind(performance), sleep = wait, journey = runBookingLoadJourney } = {}) {
  const abort = new AbortController(); let timer;
  try {
    const scope = loadTargetScope(values, clock()); const data = validateTargetLoadManifest(manifest, values, clock());
    valid(Object.hasOwn(PROFILES, profile) && typeof transport?.exchange === 'function'
      && Number.isSafeInteger(slotOffset) && slotOffset >= 0 && slotOffset <= 100);
    const { count, intervalMs } = PROFILES[profile];
    valid(profile !== 'target200' || data.employees.length >= 1000);
    const deadlineMs = (count - 1) * intervalMs + 60_000;
    valid(clock() + deadlineMs < scope.expiresMs - 60_000);
    timer = setTimeout(() => abort.abort(), deadlineMs);
    const started = monotonic(); valid(Number.isFinite(started)); let previous = started;
    function elapsed() {
      const now = monotonic(); valid(Number.isFinite(now) && now >= previous); previous = now; return now - started;
    }
    const startsAt = Math.ceil(clock() / 86400000) * 86400000 + 7 * 86400000 + 9 * 3600000;
    const results = Array(count); let next = 0; let failed = false;
    const workers = Array.from({ length: 4 }, async () => {
      while (!failed && next < count) {
        const index = next++; const scheduledAtMs = index * intervalMs;
        try {
          abort.signal.throwIfAborted();
          while (elapsed() < scheduledAtMs) await sleep(Math.ceil(scheduledAtMs - elapsed()), undefined, { signal: abort.signal });
          abort.signal.throwIfAborted(); loadTargetScope(values, clock()); const actualStartMs = elapsed();
          const tenantIndex = index % 10; const configuration = data.configurations[tenantIndex];
          const outcome = await journey({ exchange: input => transport.exchange(input), employee: data.employees[index],
            manager: data.managers[tenantIndex], context: configuration.context,
            expectedRooms: data.expectedRooms[tenantIndex], images: Array(3).fill(data.images[tenantIndex]),
            draft: requestLoadDraft({ title: `Synthetic target journey ${slotOffset}-${index}`,
              startsAt: new Date(startsAt + (slotOffset + Math.floor(index / 10)) * 7200000).toISOString(),
              configurationRevisions: configuration.revisions }), signal: abort.signal });
          abort.signal.throwIfAborted(); loadTargetScope(values, clock());
          valid(Array.isArray(outcome.observations) && outcome.observations.length === 16);
          results[index] = { requestId: outcome.requestId, tenantId: data.tenants[tenantIndex],
            actorUserId: data.managers[tenantIndex].userId, scheduledAtMs, actualStartMs,
            scheduleLagMs: actualStartMs - scheduledAtMs, completedAtMs: elapsed(), observations: outcome.observations };
        } catch { failed = true; abort.abort(); throw new Error('LOAD_TARGET_CAMPAIGN_FAILED'); }
      }
    });
    const settled = await Promise.allSettled(workers);
    valid(settled.every(result => result.status === 'fulfilled') && results.filter(Boolean).length === count);
    return { schemaVersion: 1, runId: scope.runId, releaseSha: scope.releaseSha, profile,
      retainedEmployees: data.employees.length, participatingEmployees: count, participatingManagers: 10,
      intendedArrivalIntervalMs: intervalMs, durationMs: elapsed(), results };
  } catch { abort.abort(); throw new Error('LOAD_TARGET_CAMPAIGN_FAILED'); }
  finally { clearTimeout(timer); }
}
