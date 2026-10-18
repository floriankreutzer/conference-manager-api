import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runTargetLoadController } from '../scripts/target-load-controller.mjs';
import { createLoadRuntimeBoundary } from '../scripts/support/target-load-boundary.mjs';
import { seedLoadSessions } from '../scripts/support/target-load-sessions.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { targetLoadEnvironment, targetLoadSetupEnvironment, NOW, RUN } from './support/target-load-environment.js';
import { targetLoadManifest } from './support/target-load-manifest.js';

async function fixture() {
  const env = targetLoadSetupEnvironment(); env.LOAD_EXPIRES_AT = new Date(NOW + 7_199_000).toISOString();
  let data = await targetLoadManifest({ expiresAt: env.LOAD_EXPIRES_AT }); let now = NOW;
  let closed = 0; let journalClosed = 0; let failSample = false; const phases = [];
  const calendar = { availability: 0, create: 0, update: 0, cancel: 0, uniqueEvents: 0 };
  const activity = { workerFailures: 0, storageReads: 0, storageReadBytes: 0, storageWrites: 0,
    storageWriteBytes: 0, storageDeletes: 0, storageFailures: 0 };
  const boundaries = {};
  for (const surface of ['customer', 'platform']) {
    const value = targetLoadEnvironment(surface); value.LOAD_CREATED_AT = env.LOAD_CREATED_AT;
    value.LOAD_EXPIRES_AT = env.LOAD_EXPIRES_AT;
    const server = new EventEmitter(); server.on('request', () => assert.fail('Unexpected business fall-through'));
    const boundary = createLoadRuntimeBoundary({ values: targetScopeValues(value), clock: () => now,
      limits: { rateLimitMax: 1000, rateLimitWindowMs: 60_000, databasePoolMax: surface === 'customer' ? 10 : 4 },
      metrics: createMetricsRegistry(), calendar: surface === 'customer' ? { snapshot: () => calendar } : null,
      activity: () => surface === 'customer' ? activity : Object.fromEntries(Object.keys(activity).map(key => [key, 0])) });
    boundary.install(server); boundaries[surface] = server;
  }
  function observe(surface) {
    const host = `cm-saas38-load-${RUN}-${surface}.onrender.com`; let status; let body;
    boundaries[surface].emit('request', { url: '/__load/observe', method: 'GET',
      headers: { host, authorization: `Bearer ${env.LOAD_OBSERVER_TOKEN}` },
      rawHeaders: ['Host', host, 'Authorization', `Bearer ${env.LOAD_OBSERVER_TOKEN}`] },
    { setHeader() {}, writeHead(code) { status = code; }, end(bytes) { body = JSON.parse(bytes); } });
    assert.equal(status, 200); return { status, body, latencyMs: 1 };
  }
  const transport = {
    async coldObserve(surface) { phases.push(`probe-${surface}`); return observe(surface); },
    async observe(surface) { return observe(surface); },
    async exchange(input) {
      const manager = data.managers.find(row => row.cookie === input.cookie); assert.ok(manager);
      return { status: 200, body: { user: { id: manager.userId }, tenant: { id: manager.tenantId },
        roles: ['conference_manager'], csrfToken: 'c'.repeat(43) } };
    },
    async negativeProbe(input) {
      phases.push(input.probe); return { status: ({ foreign_read: 404, missing_csrf: 403, stale_version: 409 })[input.probe] };
    },
    snapshot() { return { attempts: 4548 }; }, close() { closed += 1; },
  };
  const options = { env, clock: () => now, async sleep(ms) { now += ms; },
    async readManifest() { return structuredClone(data); },
    async journalFactory() { phases.push('journal'); return { async recordAttempt() {}, async close() { journalClosed += 1; } }; },
    transportFactory() { return transport; },
    async campaign({ profile, slotOffset }) {
      phases.push(`bookings-${data.employees.length}`); if (failSample) throw new Error('private-provider-material');
      const count = profile === 'target200' ? 200 : 10;
      calendar.availability += count * 3; calendar.create += count; calendar.uniqueEvents += count;
      activity.storageReads += count * 3; activity.storageReadBytes += count * 3 * 100;
      const results = Array.from({ length: count }, (_, index) => ({ requestId: randomUUID(), tenantId: data.tenants[index % 10],
        actorUserId: data.managers[index % 10].userId, scheduleLagMs: 0, completedAtMs: index * 4500 + 1000,
        observations: Object.entries({ session_read: 2, room_page_read: 2, media_read: 3, availability_lookup: 2,
          request_create: 1, request_read: 4, request_transition: 2 }).flatMap(([kind, amount]) =>
          Array.from({ length: amount }, () => ({ kind, latencyMs: 1, payloadBytes: 10, requestPayloadBytes: 0 }))) }));
      assert.equal(slotOffset, profile === 'target200' ? 2 : data.employees.length === 100 ? 0 : 1);
      now += profile === 'target200' ? 900_000 : 1000;
      return { profile, retainedEmployees: data.employees.length, participatingEmployees: count, participatingManagers: 10,
        intendedArrivalIntervalMs: profile === 'target200' ? 4500 : 0, durationMs: profile === 'target200' ? 900_000 : 1000, results };
    },
    async grow({ env: growthEnv, manifest }) {
      data = structuredClone(manifest); const count = Number(growthEnv.LOAD_FIXTURE_USERS); phases.push(`grow-${count}`);
      await seedLoadSessions({ async query() {} }, data.tenants, data.employees, count, { roles: ['employee'] }); return data;
    },
    async pulse() { phases.push('pulse'); now += 60_000; return { distinctSessionsRead: 1000, warmObjectivesMet: true }; },
    async reconcile({ campaigns }) { phases.push(campaigns.length ? 'reconcile-final' : 'reconcile-empty');
      return { confirmedBookings: campaigns.length ? 220 : 0 }; },
  };
  return { options, phases, closed: () => closed, journalClosed: () => journalClosed,
    fail() { failSample = true; } };
}

test('controller retains one run budget and closed phase order without inventing active-user, provider or monthly proof', async () => {
  const f = await fixture(); const result = await runTargetLoadController(f.options);
  assert.deepEqual(f.phases, ['journal', 'reconcile-empty', 'probe-customer', 'probe-platform', 'bookings-100',
    'grow-1000', 'bookings-1000', 'grow-10000', 'pulse', 'bookings-10000', 'foreign_read', 'missing_csrf',
    'stale_version', 'reconcile-final']);
  assert.equal(result.measurements.length, 3); assert.equal(result.integrity.confirmedBookings, 220);
  assert.deepEqual(result.negativeStatuses, [404, 403, 409]); assert.equal(result.warmObjectivesMet, true);
  assert.equal(result.pacedPeakCompletedWithinFifteenMinutes, true);
  for (const key of ['thousandSimultaneouslyActiveUsersProven', 'actualMonthlyCostsMeasured', 'realGraphAcceptance',
    'providerCleanupVerified', 'providerColdStateIndependentlyVerified']) assert.equal(result[key], false);
  assert.equal(JSON.stringify(result).includes('cm_session='), false);
  assert.equal(f.closed(), 1); assert.equal(f.journalClosed(), 1);
});

test('controller failure drains owned transport/journal and prevents later population growth or replay', async () => {
  const f = await fixture(); f.fail();
  await assert.rejects(runTargetLoadController(f.options), error => error.message === 'LOAD_TARGET_CONTROLLER_FAILED'
    && error.phase === 'sample100' && error.cause === undefined);
  assert.equal(f.phases.some(phase => phase.startsWith('grow-')), false);
  assert.equal(f.closed(), 1); assert.equal(f.journalClosed(), 1);
});
