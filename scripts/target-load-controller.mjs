import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { loadTargetSetupConfig } from './support/target-load-setup-config.mjs';
import { readTargetLoadManifest } from './support/target-load-manifest.mjs';
import { createTargetLoadJournal } from './support/target-load-journal.mjs';
import { createTargetLoadTransport } from './support/target-load-transport.mjs';
import { runTargetBookingCampaign } from './support/target-load-campaign.mjs';
import { growTargetLoadPopulation } from './support/target-load-growth.mjs';
import { runTargetSessionPulse } from './support/target-load-session-pulse.mjs';
import { reconcileTargetLoad } from './support/target-load-reconciliation.mjs';
import { validateTargetObservation, targetObservationDelta, summarizeTargetCampaign }
  from './support/target-load-observations.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_CONTROLLER_FAILED'); }

export async function runTargetLoadController({ env = process.env, clock = Date.now, sleep = wait,
  exit = code => process.exit(code), readManifest = readTargetLoadManifest, journalFactory = createTargetLoadJournal,
  transportFactory = createTargetLoadTransport, campaign = runTargetBookingCampaign,
  grow = growTargetLoadPopulation, pulse = runTargetSessionPulse, reconcile = reconcileTargetLoad } = {}) {
  let journal; let transport; let timer; let phase = 'configuration';
  try {
    const { values, scope } = loadTargetSetupConfig(env, clock());
    valid(clock() + 25 * 60_000 < scope.expiresMs);
    const controllerStartedAt = new Date(clock()).toISOString();
    timer = setTimeout(() => exit(1), Math.max(0, scope.expiresMs - clock())); timer.unref();
    phase = 'manifest'; let data = await readManifest(values, { clock }); valid(data.employees.length === 100);
    phase = 'journal'; journal = await journalFactory(values, { clock });
    transport = transportFactory({ values, origins: data.origins, recordAttempt: journal.recordAttempt, clock });
    phase = 'preflight'; await reconcile({ env, manifest: data, campaigns: [], clock, exit });
    phase = 'first_probes'; const firstProbes = {}; const identity = {};
    for (const surface of ['customer', 'platform']) {
      const response = await transport.coldObserve(surface, AbortSignal.timeout(65_000));
      identity[surface] = validateTargetObservation(response.body, values, surface, clock());
      firstProbes[surface] = { latencyMs: response.latencyMs, bootId: identity[surface].bootId,
        startedAt: identity[surface].startedAt, observedAt: identity[surface].observedAt, limits: identity[surface].limits,
        providerColdStateIndependentlyVerified: false };
    }
    valid(identity.customer.limits.rateLimitMax === 1000 && identity.platform.limits.rateLimitMax === 1000);
    async function observe() {
      const result = {};
      for (const surface of ['customer', 'platform']) {
        const response = await transport.observe(surface, AbortSignal.timeout(6000));
        result[surface] = validateTargetObservation(response.body, values, surface, clock());
        targetObservationDelta(identity[surface], result[surface]);
      }
      return result;
    }
    const campaigns = []; const measurements = [];
    async function bookings(profile, slotOffset) {
      const before = await observe();
      const result = await campaign({ values, manifest: data, transport, profile, slotOffset, clock }); campaigns.push(result);
      const after = await observe(); const delta = Object.fromEntries(['customer', 'platform']
        .map(surface => [surface, targetObservationDelta(before[surface], after[surface])]));
      const count = result.results.length; const calendar = delta.customer.simulatedCalendar;
      valid(calendar.availability === count * 3 && calendar.create === count && calendar.uniqueEvents === count
        && calendar.update === 0 && calendar.cancel === 0 && delta.customer.activity.storageReads === count * 3
        && delta.customer.activity.storageWrites === 0 && delta.customer.activity.storageDeletes === 0);
      const expectedBytes = result.results.reduce((sum, _row, index) => sum + data.images[index % 10].byteLength * 3, 0);
      valid(delta.customer.activity.storageReadBytes === expectedBytes);
      measurements.push({ ...summarizeTargetCampaign(result), processes: delta });
    }
    phase = 'sample100'; await bookings('sample10', 0);
    phase = 'growth1000'; data = await grow({ env: { ...env, LOAD_FIXTURE_USERS: '1000' }, manifest: data, clock, exit });
    phase = 'sample1000'; await bookings('sample10', 1);
    phase = 'growth10000'; data = await grow({ env: { ...env, LOAD_FIXTURE_USERS: '10000' }, manifest: data, clock, exit });
    phase = 'separate_session_pulse'; await sleep(61_000);
    const beforePulse = await observe(); const sessionPulse = await pulse({ values, manifest: data, transport, clock });
    const afterPulse = await observe(); const pulseDelta = targetObservationDelta(beforePulse.customer, afterPulse.customer);
    valid(Object.values(pulseDelta.simulatedCalendar).every(count => count === 0)
      && pulseDelta.activity.storageReads === 0 && pulseDelta.activity.storageWrites === 0);
    phase = 'target200'; await sleep(61_000); await bookings('target200', 2);
    phase = 'negative_probes'; const beforeNegative = await observe(); const first = campaigns[2].results[0];
    const manager = data.managers[0];
    const session = await transport.exchange({ kind: 'session_read', method: 'GET', path: '/api/v1/session', binary: false,
      cookie: manager.cookie, signal: AbortSignal.timeout(6000) });
    valid(session.status === 200 && session.body?.user?.id === manager.userId && session.body?.tenant?.id === manager.tenantId
      && Array.isArray(session.body.roles) && session.body.roles.length === 1 && session.body.roles[0] === 'conference_manager'
      && /^[A-Za-z0-9_-]{43}$/.test(session.body.csrfToken));
    const negativeStatuses = [];
    for (const probe of ['foreign_read', 'missing_csrf', 'stale_version']) {
      const result = await transport.negativeProbe({ probe, requestId: first.requestId,
        cookie: data.managers[probe === 'foreign_read' ? 1 : 0].cookie,
        csrfToken: session.body.csrfToken, signal: AbortSignal.timeout(6000) }); negativeStatuses.push(result.status);
    }
    valid(JSON.stringify(negativeStatuses) === '[404,403,409]');
    const afterNegative = await observe(); const negativeDelta = targetObservationDelta(beforeNegative.customer, afterNegative.customer);
    valid(Object.values(negativeDelta.simulatedCalendar).every(count => count === 0)
      && negativeDelta.activity.storageReads === 0 && negativeDelta.activity.storageWrites === 0);
    phase = 'reconciliation'; const integrity = await reconcile({ env, manifest: data, campaigns, clock, exit });
    phase = 'final_observation'; const final = await observe();
    const processes = Object.fromEntries(['customer', 'platform']
      .map(surface => [surface, targetObservationDelta(identity[surface], final[surface])]));
    return { schemaVersion: 1, runId: scope.runId, releaseSha: scope.releaseSha,
      createdAt: scope.createdAt, controllerStartedAt, observedAt: new Date(clock()).toISOString(), expiresAt: scope.expiresAt,
      firstProtectedProbes: firstProbes, measurements, separateSessionPulse: sessionPulse, negativeStatuses,
      integrity, processes, transportReservations: transport.snapshot(),
      warmObjectivesMet: measurements.every(row => row.warmObjectivesMet) && sessionPulse.warmObjectivesMet === true,
      pacedPeakCompletedWithinFifteenMinutes: measurements[2].completeWithinFifteenMinutes,
      thousandSimultaneouslyActiveUsersProven: false, actualMonthlyCostsMeasured: false,
      realGraphAcceptance: false, providerCleanupVerified: false, providerColdStateIndependentlyVerified: false };
  } catch {
    const error = new Error('LOAD_TARGET_CONTROLLER_FAILED'); error.phase = phase; throw error;
  } finally {
    transport?.close();
    try { await journal?.close(); } catch { throw new Error('LOAD_TARGET_CONTROLLER_FAILED'); }
    finally { clearTimeout(timer); }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let file;
  try {
    const { scope } = loadTargetSetupConfig(process.env);
    file = await open(`/tmp/cm-saas38-load-${scope.runId}-evidence.json`, 'wx', 0o600);
    const result = await runTargetLoadController();
    await file.writeFile(JSON.stringify(result)); await file.sync(); await file.close(); file = null;
    process.stdout.write('LOAD_TARGET_CONTROLLER_MEASURED\n');
    if (!result.warmObjectivesMet || !result.pacedPeakCompletedWithinFifteenMinutes) process.exitCode = 1;
  } catch {
    if (file) {
      await file.truncate(0).catch(() => {});
      await file.write('{"status":"failed","capacityAccepted":false}', 0, 'utf8').catch(() => {});
      await file.sync().catch(() => {}); await file.close().catch(() => {});
    }
    process.stderr.write('LOAD_TARGET_CONTROLLER_FAILED\n'); process.exitCode = 1;
  }
}
