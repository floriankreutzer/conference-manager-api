import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createBookingIntegrationService } from '../src/application/booking-integration-service.js';
import { loadConfig } from '../src/config.js';
import { CAPABILITY } from '../src/entitlements/capabilities.js';
import { RESERVATION_PHASE } from '../src/integrations/calendar-contract.js';
import { createLogger } from '../src/logger.js';
import { createHealthMonitor } from '../src/observability/health.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { createHttpServer } from '../src/server.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';

function httpRequest({ port, path }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: `localhost:${port}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function withServer(options, run) {
  const server = createHttpServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  options.config.publicOrigin = `http://localhost:${port}`;
  try {
    return await run(port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function testConfig() {
  return { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }) };
}

function bookingRequest() {
  return {
    tenantId: TENANT_ID,
    id: 'request-1',
    requesterUserId: USER_ID,
    roomId: 'room-1',
    status: 'Submitted',
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 3,
    externalParticipants: 1,
    statusChangedAt: '2026-08-24T09:00:00.000Z',
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
  };
}

test('metrics use bounded low-cardinality labels and reject arbitrary dimensions', () => {
  const metrics = createMetricsRegistry();
  metrics.recordApiRequest({ route: 'request', method: 'GET', statusCode: 200, durationMs: 17 });
  metrics.recordApiRequest({ route: 'entra_login', method: 'GET', statusCode: 302, durationMs: 4 });
  metrics.recordApiRequest({ route: 'entra_callback', method: 'GET', statusCode: 303, durationMs: 9 });
  metrics.recordAuthenticationFailure();
  metrics.recordAuthorizationDenied();
  metrics.recordDependencyState({ state: 'degraded', required: false });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.length, 6);
  assert.match(JSON.stringify(snapshot), /api_requests_total/);
  assert.match(JSON.stringify(snapshot), /entra_login/);
  assert.match(JSON.stringify(snapshot), /entra_callback/);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(TENANT_ID));
  assert.throws(
    () => metrics.recordApiRequest({ route: TENANT_ID, method: 'GET', statusCode: 200, durationMs: 1 }),
    /METRIC_ROUTE_INVALID/,
  );
  assert.throws(
    () => metrics.recordApiRequest({ route: 'request', method: 'ATTACK-METHOD', statusCode: 200, durationMs: 1 }),
    /METRIC_METHOD_INVALID/,
  );
});

test('health monitor separates required readiness from optional degradation', async () => {
  const metrics = createMetricsRegistry();
  const degraded = createHealthMonitor({
    readinessChecks: [async () => true],
    degradationChecks: [async () => false],
    timeoutMs: 20,
    metrics,
  });
  assert.deepEqual(await degraded.evaluate(), { status: 'degraded', ready: true, degraded: true });

  const unavailable = createHealthMonitor({
    readinessChecks: [async () => false],
    degradationChecks: [async () => true],
    timeoutMs: 20,
  });
  assert.deepEqual(await unavailable.evaluate(), { status: 'not_ready', ready: false, degraded: false });

  const timedOut = createHealthMonitor({
    readinessChecks: [async () => new Promise(() => {})],
    timeoutMs: 5,
  });
  assert.deepEqual(await timedOut.evaluate(), { status: 'not_ready', ready: false, degraded: false });
});

test('aggregate health status exposes support metadata but not dependency details', async () => {
  const logs = [];
  const logger = createLogger({ write: (line) => logs.push(line) });
  const metrics = createMetricsRegistry();
  const config = testConfig();
  config.serviceVersion = '1.2.3';
  config.buildId = 'build-42';

  await withServer({
    config,
    logger,
    metrics,
    readinessChecks: [async () => true],
    degradationChecks: [async () => false],
  }, async (port) => {
    const result = await httpRequest({ port, path: '/api/v1/health/status' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'degraded');
    assert.deepEqual(result.body.service, {
      version: '1.2.3',
      buildId: 'build-42',
      environment: 'test',
    });
    assert.equal(result.body.dependencies, undefined);
  });

  assert.match(logs.join(''), /health_evaluated/);
  assert.match(logs.join(''), /"status":"degraded"/);
});

test('operational logs and HTTP metrics do not contain dynamic request identifiers or credentials', async () => {
  const logs = [];
  const metrics = createMetricsRegistry();
  await withServer({
    config: testConfig(),
    logger: createLogger({ write: (line) => logs.push(line) }),
    metrics,
  }, async (port) => {
    const result = await httpRequest({ port, path: '/api/v1/requests/SECRET-OBJECT-123' });
    assert.equal(result.statusCode, 401);
  });

  const output = logs.join('');
  assert.doesNotMatch(output, /SECRET-OBJECT-123/);
  assert.match(output, /"route":"request"/);
  const snapshot = JSON.stringify(metrics.snapshot());
  assert.match(snapshot, /authentication_failures_total/);
  assert.doesNotMatch(snapshot, /SECRET-OBJECT-123/);
});

test('booking service records booking and provider outcomes without tenant or provider references', async () => {
  const metrics = createMetricsRegistry();
  let now = 1_000;
  const service = createBookingIntegrationService({
    repository: {
      async hasConflictingRequest() { return false; },
      async findProviderReferenceByRequest() { return null; },
      async createProviderReference() { throw new Error('UNUSED'); },
      async touchProviderReference() { throw new Error('UNUSED'); },
      async cancelProviderReference() { throw new Error('UNUSED'); },
    },
    provider: {
      integrationId: INTEGRATION_ID,
      async lookupAvailability() { return { available: true, conflictCount: 0 }; },
      async validateReservation() { return { valid: true, reason: 'available' }; },
      async createCalendarEvent() { return { providerReference: 'provider-secret', disposition: 'created' }; },
      async updateCalendarEvent(input) {
        return { providerReference: input.providerReference, disposition: 'updated' };
      },
      async cancelCalendarEvent(input) {
        return { providerReference: input.providerReference, disposition: 'cancelled' };
      },
    },
    entitlementService: { async requireAccess() { return true; } },
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    auditService: {
      createEvent(values) { return values; },
      async record(values) { return values; },
    },
    authorizeOperation: async () => true,
    metrics,
    clock: () => {
      now += 5;
      return now;
    },
  });

  const result = await service.lookupAvailability({
    principal: {
      userId: USER_ID,
      tenantId: TENANT_ID,
      roles: ['conference_manager'],
      permissions: ['request:read', 'request:manage'],
    },
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    request: bookingRequest(),
    correlationId: CORRELATION_ID,
    phase: RESERVATION_PHASE.PROVISIONAL,
  });
  assert.equal(result.available, true);

  const snapshot = JSON.stringify(metrics.snapshot());
  assert.match(snapshot, /booking_operations_total/);
  assert.match(snapshot, /integration_calls_total/);
  assert.doesNotMatch(snapshot, new RegExp(TENANT_ID));
  assert.doesNotMatch(snapshot, /provider-secret/);
});
