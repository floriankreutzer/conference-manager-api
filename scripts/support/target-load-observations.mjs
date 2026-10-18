import { isInternalUuid } from '../../src/domain/identifiers.js';
import { loadTargetScope } from './target-load-guard.mjs';

const METRICS = ['api_requests_total', 'api_response_payload_bytes_total', 'api_response_payload_observations_total',
  'authentication_failures_total', 'authorization_denials_total', 'platform_projection_batches_total',
  'platform_projection_outcomes_total', 'booking_operations_total', 'integration_calls_total', 'dependency_health_observations_total'];
const ACTIVITY = ['workerFailures', 'storageReads', 'storageReadBytes', 'storageWrites', 'storageWriteBytes',
  'storageDeletes', 'storageFailures'];
const CALENDAR = ['availability', 'create', 'update', 'cancel', 'uniqueEvents'];
function valid(value) { if (!value) throw new Error('LOAD_TARGET_OBSERVATION_FAILED'); }
function fields(value, keys) {
  valid(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)));
}
function counters(value, keys) {
  fields(value, keys); valid(Object.values(value).every(number => Number.isSafeInteger(number) && number >= 0));
}

export function validateTargetObservation(value, values, surface, now = Date.now()) {
  try {
    const scope = loadTargetScope(values, now); valid(['customer', 'platform'].includes(surface));
    const keys = ['schemaVersion', 'runId', 'surface', 'releaseSha', 'bootId', 'startedAt', 'observedAt', 'expiresAt',
      'limits', 'uptimeMs', 'cpu', 'memory', 'metricTotals', 'activity', 'postgres'];
    if (surface === 'customer') keys.push('simulatedCalendar'); fields(value, keys);
    valid(value.schemaVersion === 1 && value.runId === scope.runId && value.surface === surface
      && value.releaseSha === scope.releaseSha && value.expiresAt === scope.expiresAt && isInternalUuid(value.bootId));
    const started = Date.parse(value.startedAt); const observed = Date.parse(value.observedAt);
    valid(Number.isFinite(started) && Number.isFinite(observed) && new Date(started).toISOString() === value.startedAt
      && new Date(observed).toISOString() === value.observedAt && started >= Date.parse(scope.createdAt)
      && observed >= started && observed < scope.expiresMs && observed <= now + 5000 && observed >= now - 10_000
      && value.uptimeMs === observed - started);
    fields(value.limits, ['rateLimitMax', 'rateLimitWindowMs', 'databasePoolMax']);
    valid([120, 1000].includes(value.limits.rateLimitMax) && value.limits.rateLimitWindowMs === 60_000
      && value.limits.databasePoolMax === (surface === 'customer' ? 10 : 4));
    counters(value.cpu, ['userMicros', 'systemMicros']);
    counters(value.memory, ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']);
    counters(value.metricTotals, METRICS); counters(value.activity, ACTIVITY);
    counters(value.postgres, ['queries', 'bytesRead', 'bytesWritten']);
    valid(value.activity.workerFailures === 0 && value.activity.storageFailures === 0);
    if (surface === 'customer') counters(value.simulatedCalendar, CALENDAR);
    else valid(ACTIVITY.every(key => value.activity[key] === 0));
    return structuredClone(value);
  } catch { throw new Error('LOAD_TARGET_OBSERVATION_FAILED'); }
}

export function targetObservationDelta(before, after) {
  try {
    valid(before.runId === after.runId && before.releaseSha === after.releaseSha && before.surface === after.surface
      && before.bootId === after.bootId && before.startedAt === after.startedAt && before.expiresAt === after.expiresAt
      && JSON.stringify(before.limits) === JSON.stringify(after.limits) && after.uptimeMs >= before.uptimeMs);
    const result = { windowStart: before.observedAt, windowEnd: after.observedAt,
      elapsedMs: after.uptimeMs - before.uptimeMs };
    for (const group of ['cpu', 'metricTotals', 'activity', 'postgres', ...(before.surface === 'customer' ? ['simulatedCalendar'] : [])]) {
      valid(Object.keys(before[group]).length === Object.keys(after[group]).length);
      result[group] = Object.fromEntries(Object.entries(before[group]).map(([key, value]) => {
        valid(Number.isSafeInteger(after[group][key]) && after[group][key] >= value);
        return [key, after[group][key] - value];
      }));
    }
    result.memoryBefore = before.memory; result.memoryAfter = after.memory; return result;
  } catch { throw new Error('LOAD_TARGET_OBSERVATION_FAILED'); }
}

export function summarizeTargetCampaign(campaign) {
  try {
    valid(['sample10', 'target200'].includes(campaign?.profile));
    valid(campaign?.results?.length === (campaign.profile === 'target200' ? 200 : 10));
    valid([100, 1000, 10_000].includes(campaign.retainedEmployees)
      && campaign.participatingEmployees === campaign.results.length && campaign.participatingManagers === 10
      && campaign.intendedArrivalIntervalMs === (campaign.profile === 'target200' ? 4500 : 0)
      && Number.isFinite(campaign.durationMs) && campaign.durationMs >= 0 && campaign.durationMs <= 960_000);
    const operations = campaign.results.flatMap(row => row.observations);
    valid(operations.length === campaign.results.length * 16);
    const mix = { session_read: 2, room_page_read: 2, media_read: 3, availability_lookup: 2,
      request_create: 1, request_read: 4, request_transition: 2 };
    const counts = Object.fromEntries(Object.keys(mix).map(key => [key, 0]));
    for (const row of operations) {
      valid(Object.hasOwn(mix, row.kind) && Number.isSafeInteger(row.payloadBytes) && row.payloadBytes >= 0
        && row.payloadBytes <= (row.kind === 'media_read' ? 2 * 1024 * 1024 : 8192)
        && Number.isSafeInteger(row.requestPayloadBytes) && row.requestPayloadBytes >= 0 && row.requestPayloadBytes <= 8192);
      counts[row.kind] += 1;
    }
    valid(Object.keys(mix).every(kind => counts[kind] === mix[kind] * campaign.results.length));
    function distribution(values) {
      valid(values.length > 0 && values.every(number => Number.isFinite(number) && number >= 0));
      const sorted = [...values].sort((left, right) => left - right);
      return Object.fromEntries([['p50', 0.5], ['p95', 0.95], ['p99', 0.99]]
        .map(([name, fraction]) => [name, sorted[Math.ceil(sorted.length * fraction) - 1]]));
    }
    const latencyMs = distribution(operations.map(row => row.latencyMs));
    const kinds = [...new Set(operations.map(row => row.kind))];
    const payloadBytes = operations.reduce((sum, row) => sum + row.payloadBytes, 0);
    const requestPayloadBytes = operations.reduce((sum, row) => sum + row.requestPayloadBytes, 0);
    valid(Number.isSafeInteger(payloadBytes) && Number.isSafeInteger(requestPayloadBytes));
    const completeWithinFifteenMinutes = campaign.profile !== 'target200'
      ? null : campaign.results.every(row => row.completedAtMs <= 900_000);
    return { profile: campaign.profile, retainedEmployees: campaign.retainedEmployees,
      participatingEmployees: campaign.participatingEmployees, participatingManagers: campaign.participatingManagers,
      bookings: campaign.results.length, requests: operations.length, intendedArrivalIntervalMs: campaign.intendedArrivalIntervalMs,
      durationMs: campaign.durationMs, latencyMs, scheduleLagMs: distribution(campaign.results.map(row => row.scheduleLagMs)),
      perOperationLatencyMs: Object.fromEntries(kinds.map(kind => [kind,
        distribution(operations.filter(row => row.kind === kind).map(row => row.latencyMs))])),
      payloadBytes, requestPayloadBytes, technicalErrors: 0,
      warmObjectivesMet: latencyMs.p95 <= 1000 && latencyMs.p99 <= 2000,
      completeWithinFifteenMinutes, thousandSimultaneouslyActiveUsersProven: false, realGraphAcceptance: false };
  } catch { throw new Error('LOAD_TARGET_OBSERVATION_FAILED'); }
}
