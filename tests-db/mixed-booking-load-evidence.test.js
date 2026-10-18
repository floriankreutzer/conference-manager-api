import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformProjectionRepository } from '../src/persistence/postgres/platform-projection-repository.js';
import { createPlatformProjectionWorker } from '../src/platform/projection-worker.js';
import { AUDIT_ACTION } from '../src/audit/event.js';
import { measureSessionReads } from '../scripts/session-load-evidence.mjs';
import { runBookingLoadJourney } from '../scripts/support/booking-load-journey.mjs';
import { createLoopbackBookingExchange } from '../scripts/support/loopback-booking-exchange.mjs';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';
import { instrumentLoadPool } from './support/customer-load-fixtures.js';
import { createBookingJourneyFixture } from './support/booking-journey-fixture.js';

test('coherent confirmed-booking replay retains exact sixteen-operation mix with concurrent projection work', async (t) => {
  const fixture = await createBookingJourneyFixture(t);
  const { config, persistence, tenants, employees, managers, configurations, expectedRooms, images, calendar } = fixture;
  // Separate bounded population pulse; never count it inside the sixteen-operation booking mix.
  await measureSessionReads({ origin: config.publicOrigin, cookies: employees.map(x => x.cookie), verify(body, index) {
    assert.equal(body.user.id, employees[index].userId); assert.equal(body.tenant.id, employees[index].tenantId);
  } });
  const workerPool = createPostgresPool({ ...config, databasePoolMax: 4 });
  const workerCounters = instrumentLoadPool(workerPool); const workerResults = []; let workerErrors = 0;
  const worker = createPlatformProjectionWorker({ repository: createPostgresPlatformProjectionRepository(workerPool),
    onError() { workerErrors += 1; }, onResult(result) {
      assert.ok(workerResults.length < 100); workerResults.push(result);
    } });
  t.after(async () => { try { await worker.stop(); } finally { await workerPool.end(); } });
  await worker.start(); await worker.runOnce(); workerResults.length = 0;
  const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
  try { await Promise.all(clients.map(client => client.query('SELECT 1'))); }
  finally { clients.forEach(client => client.release()); }
  const before = fixture.counters(); const beforeWorker = workerCounters(); const beforeObjects = fixture.objectCounters();
  const started = performance.now(); const outcomes = []; const failures = []; let next = 0;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
  const exchange = createLoopbackBookingExchange(config.publicOrigin);
  const startsAt = Math.ceil(Date.now() / 86400000) * 86400000 + 7 * 86400000 + 9 * 3600000;
  const clientsCompleted = await Promise.allSettled(Array.from({ length: 16 }, async () => {
    while (next < 200) {
      signal.throwIfAborted(); const index = next++; const employee = employees[index];
      const tenantIndex = tenants.indexOf(employee.tenantId);
      try {
        outcomes[index] = await runBookingLoadJourney({ exchange, employee, manager: managers[tenantIndex],
          context: configurations[tenantIndex].context, expectedRooms: expectedRooms[tenantIndex],
          images: [images[tenantIndex], images[tenantIndex], images[tenantIndex]], signal,
          draft: requestLoadDraft({ title: `Synthetic journey ${index}`,
            startsAt: new Date(startsAt + Math.floor(index / 10) * 7200000).toISOString(),
            configurationRevisions: configurations[tenantIndex].revisions }) });
      } catch (error) {
        if (failures.length < 16 && ['input', 'session_read', 'room_page_read', 'media_read', 'availability_lookup',
          'request_create', 'request_read', 'request_transition'].includes(error.operation)) failures.push(error.operation);
        controller.abort(); throw new Error('MIXED_BOOKING_ACCEPTANCE_FAILED');
      }
    }
  }));
  if (failures.length) t.diagnostic(JSON.stringify({ rejectedOperations: failures }));
  assert.ok(clientsCompleted.every(row => row.status === 'fulfilled'));
  assert.equal(outcomes.length, 200); assert.ok(outcomes.every(Boolean));
  const journeyElapsedMs = performance.now() - started;
  const after = fixture.counters(); const afterObjects = fixture.objectCounters();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await worker.runOnce();
    if ((await persistence.pool.query('SELECT count(*)::int AS count FROM platform_projection_outbox')).rows[0].count === 0) break;
  }
  await worker.stop(); const afterWorker = workerCounters();
  assert.equal(workerErrors, 0); assert.ok(workerResults.length > 0 && workerResults.length < 100);
  assert.equal((await persistence.pool.query('SELECT count(*)::int AS count FROM platform_projection_outbox')).rows[0].count, 0);
  assert.equal(afterObjects.reads - beforeObjects.reads, 600);
  assert.equal(afterObjects.bytes - beforeObjects.bytes,
    employees.slice(0, 200).reduce((sum, employee) => sum + 3 * images[tenants.indexOf(employee.tenantId)].byteLength, 0));
  const observed = outcomes.flatMap(row => row.observations);
  assert.equal(observed.length, 3200);
  const counts = observed.reduce((values, row) => ({ ...values, [row.kind]: (values[row.kind] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { session_read: 400, room_page_read: 400, media_read: 600, availability_lookup: 400,
    request_create: 200, request_read: 800, request_transition: 400 });
  const requests = await persistence.pool.query('SELECT tenant_id,id,status,request_version FROM requests');
  assert.equal(requests.rowCount, 200); assert.equal(new Set(outcomes.map(row => row.requestId)).size, 200);
  const expected = new Map(outcomes.map((row, index) => [row.requestId, employees[index]]));
  for (const row of requests.rows) {
    assert.equal(row.tenant_id, expected.get(row.id).tenantId); assert.equal(row.status, 'Confirmed');
    assert.equal(Number(row.request_version), 3);
  }
  const references = await persistence.pool.query(`SELECT tenant_id,request_id,state,idempotency_key,
    provider_reference,provider_resource_reference FROM booking_provider_references`);
  assert.equal(references.rowCount, 200);
  for (const row of references.rows) {
    assert.equal(row.state, 'active'); assert.equal(row.tenant_id, expected.get(row.request_id).tenantId);
    assert.equal(row.provider_reference, `fixture-${createHash('sha256').update(row.idempotency_key).digest('hex')}`);
    assert.equal(row.provider_resource_reference, `room${tenants.indexOf(row.tenant_id)}@synthetic.invalid`);
  }
  assert.equal(calendar.snapshot().uniqueEvents, 200); assert.equal(calendar.snapshot().create, 200);
  assert.ok(calendar.snapshot().availability >= 400 && calendar.snapshot().availability <= 1200);
  assert.equal((await persistence.pool.query('SELECT count(*)::int AS count FROM request_revisions')).rows[0].count, 600);
  const audit = await persistence.pool.query(`SELECT h.tenant_id,h.request_id,h.request_version,h.actor_user_id,
    h.actor_role_at_action,h.record,a.actor_user_id AS audit_actor,a.previous_state,a.new_state,a.outcome
    FROM request_revisions h JOIN audit_events a ON a.tenant_id=h.tenant_id AND a.correlation_id=h.correlation_id
      AND a.target_id=h.request_id AND a.target_type='request' AND a.action=$1
    WHERE h.request_version IN (2,3)`, [AUDIT_ACTION.REQUEST_TRANSITION]);
  assert.equal(audit.rowCount, 400);
  for (const row of audit.rows) {
    const tenantIndex = tenants.indexOf(expected.get(row.request_id).tenantId);
    assert.equal(row.tenant_id, tenants[tenantIndex]); assert.equal(row.actor_user_id, managers[tenantIndex].userId);
    assert.equal(row.audit_actor, row.actor_user_id); assert.equal(row.actor_role_at_action, 'conference_manager');
    assert.equal(row.outcome, 'success'); assert.equal(row.record.pricing.totalMinor, 1000 + tenantIndex * 100);
    const reviewing = Number(row.request_version) === 2;
    assert.deepEqual(row.previous_state, { status: reviewing ? 'Submitted' : 'In Review' });
    assert.deepEqual(row.new_state, { status: reviewing ? 'In Review' : 'Confirmed' });
    assert.equal(row.record.status, row.new_state.status); assert.equal(row.record.version, Number(row.request_version));
  }
  const calls = calendar.snapshot();
  for (const [cookie, token, method, suffix, expectedStatus] of [
    [managers[1].cookie, null, 'GET', '', 404],
    [managers[0].cookie, null, 'POST', '/transitions', 403],
    [managers[0].cookie, fixture.managerTokens[0], 'POST', '/transitions', 409],
  ]) {
    const response = await fetch(`${config.publicOrigin}/api/v1/requests/${outcomes[0].requestId}${suffix}`, {
      method, headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: config.publicOrigin,
        'Content-Type': 'application/json', 'If-Match': '"2"', ...(token ? { 'X-CSRF-Token': token } : {}) } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ transition: 'confirm' }) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer(); assert.equal(response.status, expectedStatus);
  }
  assert.deepEqual(calendar.snapshot(), calls);
  assert.equal((await persistence.pool.query('SELECT count(*)::int AS count FROM request_revisions')).rows[0].count, 600);
  for (const tenantId of tenants) assert.equal(await persistence.auditRepository.verifyTenantChain(tenantId), true);
  function distribution(rows) {
    const times = rows.map(row => row.latencyMs).sort((a, b) => a - b);
    return Object.fromEntries([['p50', 0.5], ['p95', 0.95], ['p99', 0.99]]
      .map(([name, fraction]) => [name, Number(times[Math.ceil(times.length * fraction) - 1].toFixed(3))]));
  }
  const delta = (first, last) => Object.fromEntries(Object.keys(first).map(key => [key, last[key] - first[key]]));
  t.diagnostic(JSON.stringify({ schemaVersion: 1, environment: 'isolated-postgres18-loopback',
    workload: 'coherent-confirmed-booking-journey', bookings: 200, requests: observed.length, operations: counts,
    retainedEmployeeUsers: 1000, retainedManagerUsers: 10, participatingEmployeeUsers: 200, participatingManagerUsers: 10,
    separatePopulationPulseReads: 1000, concurrentJourneys: 16, journeyElapsedMs: Number(journeyElapsedMs.toFixed(3)),
    poolMax: config.databasePoolMax, workerPoolMax: 4, postgresVersion: fixture.postgresVersion, nodeVersion: process.version,
    latencyMs: distribution(observed), perOperationLatencyMs: Object.fromEntries(Object.keys(counts)
      .map(kind => [kind, distribution(observed.filter(row => row.kind === kind))])),
    payloadBytes: observed.reduce((sum, row) => sum + row.payloadBytes, 0),
    requestPayloadBytes: observed.reduce((sum, row) => sum + row.requestPayloadBytes, 0),
    customerPostgresProtocol: delta(before, after), workerPostgresProtocolThroughDrain: delta(beforeWorker, afterWorker),
    workerDispatchObservations: workerResults.length, fixtureObjectTraffic: delta(beforeObjects, afterObjects),
    simulatedCalendar: calendar.snapshot(), providerEgressMeasured: false, productionCapacityProven: false,
    realGraphAcceptance: false, pacedFifteenMinutePeak: false, thousandSimultaneouslyActiveUsersProven: false,
    workerProcessCpuAttributed: false, coldStartMeasured: false, cacheMixApproved: false }));
});
