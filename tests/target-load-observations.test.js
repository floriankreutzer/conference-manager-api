import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateTargetObservation, targetObservationDelta, summarizeTargetCampaign }
  from '../scripts/support/target-load-observations.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';

const values = targetScopeValues(targetLoadSetupEnvironment());
function snapshot(surface = 'customer') {
  return { schemaVersion: 1, runId: values.runId, surface, releaseSha: values.releaseSha, bootId: randomUUID(),
    startedAt: new Date(NOW - 500).toISOString(), observedAt: new Date(NOW).toISOString(), expiresAt: values.expiresAt,
    limits: { rateLimitMax: 1000, rateLimitWindowMs: 60_000, databasePoolMax: surface === 'customer' ? 10 : 4 },
    uptimeMs: 500, cpu: { userMicros: 1, systemMicros: 1 },
    postgres: { queries: 1, bytesRead: 1, bytesWritten: 1 },
    memory: { rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 },
    metricTotals: Object.fromEntries(['api_requests_total', 'api_response_payload_bytes_total',
      'api_response_payload_observations_total', 'authentication_failures_total', 'authorization_denials_total',
      'platform_projection_batches_total', 'platform_projection_outcomes_total', 'booking_operations_total',
      'integration_calls_total', 'dependency_health_observations_total'].map(key => [key, 0])),
    activity: { workerFailures: 0, storageReads: 0, storageReadBytes: 0, storageWrites: 0,
      storageWriteBytes: 0, storageDeletes: 0, storageFailures: 0 },
    ...(surface === 'customer' ? { simulatedCalendar: { availability: 0, create: 0, update: 0, cancel: 0, uniqueEvents: 0 } } : {}) };
}

test('observer reader rejects source, clock, secret fields, reset counters and changed boot/limit identity', () => {
  const before = validateTargetObservation(snapshot(), values, 'customer', NOW);
  const after = structuredClone(before); after.uptimeMs += 100; after.observedAt = new Date(NOW + 100).toISOString();
  after.cpu.userMicros += 10; after.activity.storageReads += 3; after.postgres.queries += 2;
  const checked = validateTargetObservation(after, values, 'customer', NOW + 100);
  assert.equal(targetObservationDelta(before, checked).cpu.userMicros, 10);
  assert.equal(targetObservationDelta(before, checked).activity.storageReads, 3);
  assert.equal(targetObservationDelta(before, checked).postgres.queries, 2);
  for (const mutate of [row => { row.cookie = 'private'; }, row => { row.metricTotals.labels = {}; },
    row => { row.runId = 'f'.repeat(16); }, row => { row.observedAt = new Date(NOW - 20_000).toISOString(); },
    row => { row.limits.databasePoolMax = 100; }, row => { row.activity.workerFailures = 1; }]) {
    const row = structuredClone(before); mutate(row);
    assert.throws(() => validateTargetObservation(row, values, 'customer', NOW), /^Error: LOAD_TARGET_OBSERVATION_FAILED$/);
  }
  for (const mutate of [row => { row.bootId = randomUUID(); }, row => { row.cpu.userMicros = 0; },
    row => { row.limits.rateLimitMax = 120; }, row => { row.postgres.bytesRead = 0; }]) {
    const row = structuredClone(after); mutate(row); assert.throws(() => targetObservationDelta(before, row));
  }
  const platform = snapshot('platform'); validateTargetObservation(platform, values, 'platform', NOW);
  platform.activity.storageReads = 1;
  assert.throws(() => validateTargetObservation(platform, values, 'platform', NOW));
});

test('campaign summaries preserve real latency/schedule failure and never leak outcome IDs', () => {
  const campaign = { profile: 'target200', retainedEmployees: 10_000, participatingEmployees: 200, participatingManagers: 10,
    intendedArrivalIntervalMs: 4500, durationMs: 901_000, results: Array.from({ length: 200 }, (_, index) => ({
      requestId: 'private-request', tenantId: 'private-tenant', actorUserId: 'private-actor', scheduleLagMs: index,
      completedAtMs: index === 199 ? 901_000 : index * 4500 + 1000,
      observations: Object.entries({ session_read: 2, room_page_read: 2, media_read: 3, availability_lookup: 2,
        request_create: 1, request_read: 4, request_transition: 2 }).flatMap(([kind, count]) =>
        Array.from({ length: count }, () => ({ kind, latencyMs: 2100, payloadBytes: 10, requestPayloadBytes: 0 }))),
    })) };
  const result = summarizeTargetCampaign(campaign);
  assert.equal(result.requests, 3200); assert.equal(result.warmObjectivesMet, false);
  assert.equal(result.completeWithinFifteenMinutes, false); assert.equal(result.thousandSimultaneouslyActiveUsersProven, false);
  assert.equal(result.payloadBytes, 32_000); assert.equal(JSON.stringify(result).includes('private'), false);
});
