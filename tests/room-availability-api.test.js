import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { SiteTimeZoneRequiredError } from '../src/application/production-application-service.js';
import { RoomAvailabilityUnavailableError } from '../src/application/room-availability-service.js';
import { PERMISSION, TENANT_ROLE } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer } from '../src/server.js';
import { TENANT_STATUS } from '../src/tenancy/tenant.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CSRF_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const BODY = Object.freeze({
  roomId: 'room-a',
  startsAt: '2026-09-01T10:00:00.000Z',
  endsAt: '2026-09-01T11:00:00.000Z',
});

function request({ port, method = 'POST', headers = {}, body = BODY }) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/application/room-availability',
      method,
      headers: {
        Host: `localhost:${port}`,
        ...(encoded === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded),
        }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    outgoing.on('error', reject);
    if (encoded !== undefined) outgoing.write(encoded);
    outgoing.end();
  });
}

async function withServer(productionApplicationService, run) {
  const config = {
    ...loadConfig({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://localhost:3000',
      RATE_LIMIT_MAX: '50',
    }),
  };
  const logger = createLogger({ write() {} });
  const principal = {
    userId: USER_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'test_oidc', reference: 'subject-123' },
    roles: [TENANT_ROLE.EMPLOYEE],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-24T06:00:00.000Z',
      expiresAt: '2026-08-24T14:00:00.000Z',
      securityVersion: 1,
    },
  };
  const server = createHttpServer({
    config,
    logger,
    productionApplicationService,
    resolvePrincipal: async () => principal,
    verifyCsrf: async (incoming) => incoming.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async (tenantId) => tenantId === TENANT_ID
      ? {
        id: TENANT_ID,
        displayName: 'Tenant',
        status: TENANT_STATUS.ACTIVE,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }
      : null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  config.publicOrigin = `http://localhost:${port}`;
  try {
    await run(port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('room availability POST requires CSRF and rejects authority-shaped input', async () => {
  const calls = [];
  await withServer({
    async checkRoomAvailability(values) {
      calls.push(values);
      return { available: true, conflictCount: 0 };
    },
  }, async (port) => {
    const noCsrf = await request({ port });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.body.error.code, 'CSRF_INVALID');

    const manipulated = await request({
      port,
      headers: { 'X-CSRF-Token': CSRF_TOKEN },
      body: { ...BODY, tenantId: TENANT_ID },
    });
    assert.equal(manipulated.statusCode, 400);
    assert.equal(manipulated.body.error.code, 'VALIDATION_FAILED');
    assert.equal(calls.length, 0);
  });
});

test('room availability response is versioned, minimized and server-context bound', async () => {
  const calls = [];
  await withServer({
    async checkRoomAvailability(values) {
      calls.push(values);
      return { available: false, conflictCount: 1 };
    },
  }, async (port) => {
    const result = await request({ port, headers: { 'X-CSRF-Token': CSRF_TOKEN } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      schemaVersion: 1,
      availability: { available: false, conflictCount: 1 },
    });
    assert.equal(calls[0].principal.tenantId, TENANT_ID);
    assert.equal(calls[0].tenantContext.tenantId, TENANT_ID);
    assert.deepEqual(calls[0].query, BODY);
  });
});

test('provider/configuration unavailability has a stable presentation-safe response', async () => {
  await withServer({
    async checkRoomAvailability() {
      throw new RoomAvailabilityUnavailableError();
    },
  }, async (port) => {
    const result = await request({ port, headers: { 'X-CSRF-Token': CSRF_TOKEN } });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error.code, 'ROOM_AVAILABILITY_UNAVAILABLE');
  });
});

test('missing authoritative Site time zone has a stable conflict response', async () => {
  await withServer({
    async checkRoomAvailability() {
      throw new SiteTimeZoneRequiredError();
    },
  }, async (port) => {
    const result = await request({ port, headers: { 'X-CSRF-Token': CSRF_TOKEN } });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'SITE_TIME_ZONE_REQUIRED');
  });
});
