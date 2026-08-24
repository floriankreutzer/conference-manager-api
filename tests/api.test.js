import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequestService } from '../src/application/request-service.js';
import {
  PERMISSION,
  REQUEST_STATUS,
  REQUEST_TRANSITION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer } from '../src/server.js';
import { TENANT_STATUS } from '../src/tenancy/tenant.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CSRF_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function request({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: `localhost:${port}`,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(options, run) {
  const logs = [];
  const logger = createLogger({ write: (line) => logs.push(line) });
  const server = createHttpServer({ ...options, logger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  options.config.publicOrigin = `http://localhost:${port}`;
  try {
    return await run({ port, logs });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function testConfig() {
  const base = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000', RATE_LIMIT_MAX: '50' });
  return { ...base };
}

function tenant(id = TENANT_ID, status = TENANT_STATUS.ACTIVE) {
  return {
    id,
    displayName: 'Test Tenant',
    status,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function principal(overrides = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'test_oidc', reference: 'subject-123' },
    roles: [TENANT_ROLE.EMPLOYEE],
    permissions: [PERMISSION.REQUEST_READ],
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-24T06:00:00.000Z',
      expiresAt: '2026-08-24T14:00:00.000Z',
      securityVersion: 1,
    },
    ...overrides,
  };
}

function requestRecord(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'REQ-1',
    requesterUserId: USER_ID,
    roomId: 'room-a',
    status: REQUEST_STATUS.SUBMITTED,
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 5,
    externalParticipants: 1,
    statusChangedAt: '2026-08-24T08:00:00.000Z',
    createdAt: '2026-08-24T08:00:00.000Z',
    updatedAt: '2026-08-24T08:00:00.000Z',
    ...overrides,
  };
}

function requestServiceFor(initialRecord) {
  let record = initialRecord;
  return createRequestService({
    authorizationPolicy: createAuthorizationPolicy(),
    clock: () => Date.parse('2026-08-24T09:00:00.000Z'),
    repository: {
      async findByTenantIdAndId(tenantId, requestId) {
        if (!record || record.tenantId !== tenantId || record.id !== requestId) return null;
        return record;
      },
      async transitionByTenantIdAndId({ tenantId, requestId, expectedStatus, nextStatus, reason, changedAt }) {
        if (!record || record.tenantId !== tenantId || record.id !== requestId || record.status !== expectedStatus) {
          return null;
        }
        record = {
          ...record,
          status: nextStatus,
          statusReason: reason,
          statusChangedAt: changedAt.toISOString(),
          updatedAt: changedAt.toISOString(),
        };
        return record;
      },
    },
  });
}

test('liveness and readiness expose no configuration details and set security headers', async () => {
  const config = testConfig();
  await withServer({ config, readinessChecks: [async () => true] }, async ({ port }) => {
    const live = await request({ port, path: '/api/v1/health/live' });
    assert.equal(live.statusCode, 200);
    assert.equal(live.body.status, 'ok');
    assert.match(live.body.requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(live.headers['cache-control'], 'no-store');
    assert.equal(live.headers['x-content-type-options'], 'nosniff');
    assert.equal(live.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(live.headers['strict-transport-security'], undefined);
    assert.deepEqual(Object.keys(live.body).sort(), ['requestId', 'status']);

    const ready = await request({ port, path: '/api/v1/health/ready' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.status, 'ready');
  });
});

test('readiness fails closed when a dependency check fails or times out', async () => {
  const config = { ...testConfig(), readinessTimeoutMs: 20 };
  await withServer({ config, readinessChecks: [async () => false] }, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/health/ready' });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.status, 'not_ready');
  });

  const timeoutConfig = { ...testConfig(), readinessTimeoutMs: 20 };
  await withServer({
    config: timeoutConfig,
    readinessChecks: [() => new Promise(() => {})],
  }, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/health/ready' });
    assert.equal(result.statusCode, 503);
  });
});

test('cross-origin, host mismatch, traversal, and unsupported methods are rejected', async () => {
  const config = testConfig();
  await withServer({ config }, async ({ port }) => {
    const crossOrigin = await request({
      port,
      path: '/api/v1/health/live',
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(crossOrigin.body.error.code, 'ORIGIN_NOT_ALLOWED');

    const badHost = await request({
      port,
      path: '/api/v1/health/live',
      headers: { Host: 'attacker.example' },
    });
    assert.equal(badHost.statusCode, 400);
    assert.equal(badHost.body.error.code, 'HOST_NOT_ALLOWED');

    const traversal = await request({ port, path: '/api/%2e%2e/secret' });
    assert.equal(traversal.statusCode, 400);
    assert.equal(traversal.body.error.code, 'REQUEST_TARGET_INVALID');

    const trace = await request({ port, path: '/api/v1/health/live', method: 'TRACE' });
    assert.equal(trace.statusCode, 405);
    assert.equal(trace.body.error.code, 'METHOD_NOT_ALLOWED');
  });
});

test('protected session endpoint fails closed without principal', async () => {
  const config = testConfig();
  await withServer({ config }, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/session' });
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error.code, 'UNAUTHENTICATED');
  });
});

test('protected session resolves tenant only from the authenticated principal and minimizes identity output', async () => {
  const config = testConfig();
  await withServer({
    config,
    resolvePrincipal: async () => principal(),
    loadTenant: async (tenantId) => tenantId === TENANT_ID ? tenant() : null,
  }, async ({ port }) => {
    const result = await request({
      port,
      path: `/api/v1/session?tenantId=${OTHER_TENANT_ID}`,
      headers: { 'X-Tenant-Id': OTHER_TENANT_ID },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.user, { id: USER_ID });
    assert.deepEqual(result.body.tenant, { id: TENANT_ID, status: TENANT_STATUS.ACTIVE });
    assert.deepEqual(result.body.roles, [TENANT_ROLE.EMPLOYEE]);
    assert.deepEqual(result.body.permissions, [PERMISSION.REQUEST_READ]);
    assert.deepEqual(result.body.session, { expiresAt: '2026-08-24T14:00:00.000Z' });
    assert.equal(result.body.providerIdentity, undefined);
  });
});

test('session endpoint rejects unknown tenant roles and permissions', async () => {
  for (const identity of [
    principal({ roles: ['platform_admin'] }),
    principal({ permissions: [PERMISSION.REQUEST_READ, 'request:superuser'] }),
  ]) {
    await withServer({
      config: testConfig(),
      resolvePrincipal: async () => identity,
      loadTenant: async () => tenant(),
    }, async ({ port }) => {
      const result = await request({ port, path: '/api/v1/session' });
      assert.equal(result.statusCode, 403);
      assert.equal(result.body.error.code, 'FORBIDDEN');
    });
  }
});

test('session endpoint returns CSRF token and DELETE requires it before server-side revocation', async () => {
  let revoked = false;
  const sessionService = {
    resolvePrincipal: async () => principal(),
    verifyCsrf: async (req) => req.headers['x-csrf-token'] === CSRF_TOKEN,
    csrfTokenForPrincipal: () => CSRF_TOKEN,
    revoke: async () => {
      revoked = true;
      return true;
    },
    clearCookie: () => 'cm_session=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0',
  };
  const options = {
    config: testConfig(),
    sessionService,
    loadTenant: async () => tenant(),
  };
  await withServer(options, async ({ port }) => {
    const session = await request({ port, path: '/api/v1/session' });
    assert.equal(session.statusCode, 200);
    assert.equal(session.body.csrfToken, CSRF_TOKEN);

    const denied = await request({ port, path: '/api/v1/session', method: 'DELETE' });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, 'CSRF_INVALID');
    assert.equal(revoked, false);

    const logout = await request({
      port,
      path: '/api/v1/session',
      method: 'DELETE',
      headers: { 'X-CSRF-Token': CSRF_TOKEN },
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(logout.body, null);
    assert.equal(revoked, true);
    assert.match(logout.headers['set-cookie'][0], /^cm_session=;/);
    assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  });
});

test('unknown, suspended, and archived tenant contexts fail closed', async () => {
  for (const tenantRecord of [
    null,
    tenant(TENANT_ID, TENANT_STATUS.SUSPENDED),
    tenant(TENANT_ID, TENANT_STATUS.ARCHIVED),
  ]) {
    const config = testConfig();
    await withServer({
      config,
      resolvePrincipal: async () => principal(),
      loadTenant: async () => tenantRecord,
    }, async ({ port }) => {
      const result = await request({ port, path: '/api/v1/session' });
      assert.equal(result.statusCode, 403);
      assert.equal(result.body.error.code, 'TENANT_UNAVAILABLE');
    });
  }
});

test('employee request endpoint returns own object and conceals another employee object', async () => {
  const baseOptions = {
    config: testConfig(),
    resolvePrincipal: async () => principal(),
    loadTenant: async () => tenant(),
  };
  await withServer({ ...baseOptions, requestService: requestServiceFor(requestRecord()) }, async ({ port }) => {
    const own = await request({
      port,
      path: `/api/v1/requests/REQ-1?tenantId=${OTHER_TENANT_ID}`,
      headers: { 'X-Tenant-Id': OTHER_TENANT_ID },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.request.id, 'REQ-1');
    assert.equal(own.body.request.status, REQUEST_STATUS.SUBMITTED);
    assert.equal(own.body.request.tenantId, undefined);
    assert.equal(own.body.request.requesterUserId, undefined);
  });

  await withServer({
    ...baseOptions,
    requestService: requestServiceFor(requestRecord({ requesterUserId: OTHER_USER_ID })),
  }, async ({ port }) => {
    const foreign = await request({ port, path: '/api/v1/requests/REQ-1' });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.body.error.code, 'NOT_FOUND');
  });
});

test('conference manager can read tenant requests while tenant admin cannot inherit manager access', async () => {
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  await withServer({
    config: testConfig(),
    resolvePrincipal: async () => manager,
    loadTenant: async () => tenant(),
    requestService: requestServiceFor(requestRecord({ requesterUserId: OTHER_USER_ID })),
  }, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/requests/REQ-1' });
    assert.equal(result.statusCode, 200);
  });

  const tenantAdmin = principal({
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_CONFIGURE],
  });
  await withServer({
    config: testConfig(),
    resolvePrincipal: async () => tenantAdmin,
    loadTenant: async () => tenant(),
    requestService: requestServiceFor(requestRecord()),
  }, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/requests/REQ-1' });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error.code, 'FORBIDDEN');
  });
});

test('request transitions require CSRF and reject client-controlled status or owner fields', async () => {
  const employee = principal({
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
  });
  const options = {
    config: testConfig(),
    resolvePrincipal: async () => employee,
    verifyCsrf: async (req) => req.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async () => tenant(),
    requestService: requestServiceFor(requestRecord()),
  };
  await withServer(options, async ({ port }) => {
    const body = JSON.stringify({ transition: REQUEST_TRANSITION.CANCEL });
    const missingCsrf = await request({
      port,
      path: '/api/v1/requests/REQ-1/transitions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(missingCsrf.body.error.code, 'CSRF_INVALID');

    const manipulated = await request({
      port,
      path: '/api/v1/requests/REQ-1/transitions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': CSRF_TOKEN,
      },
      body: JSON.stringify({
        transition: REQUEST_TRANSITION.CANCEL,
        status: REQUEST_STATUS.CONFIRMED,
        requesterUserId: OTHER_USER_ID,
      }),
    });
    assert.equal(manipulated.statusCode, 400);
    assert.equal(manipulated.body.error.code, 'VALIDATION_FAILED');

    const cancelled = await request({
      port,
      path: '/api/v1/requests/REQ-1/transitions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': CSRF_TOKEN,
      },
      body,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.body.request.status, REQUEST_STATUS.CANCELLED);
  });
});

test('manager transition is authorized server-side while employee cannot invoke manager workflow action', async () => {
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  const common = {
    config: testConfig(),
    verifyCsrf: async () => true,
    loadTenant: async () => tenant(),
    requestService: requestServiceFor(requestRecord()),
  };
  await withServer({ ...common, resolvePrincipal: async () => manager }, async ({ port }) => {
    const confirmed = await request({
      port,
      path: '/api/v1/requests/REQ-1/transitions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ transition: REQUEST_TRANSITION.CONFIRM }),
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.body.request.status, REQUEST_STATUS.CONFIRMED);
  });

  await withServer({ ...common, resolvePrincipal: async () => principal() }, async ({ port }) => {
    const denied = await request({
      port,
      path: '/api/v1/requests/REQ-1/transitions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ transition: REQUEST_TRANSITION.CONFIRM }),
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
  });
});

test('logs contain only bounded metadata and do not copy authorization or cookie headers', async () => {
  const config = testConfig();
  await withServer({ config }, async ({ port, logs }) => {
    await request({
      port,
      path: '/api/v1/health/live',
      headers: {
        Authorization: 'Bearer super-secret-token-value',
        Cookie: 'cm_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    const output = logs.join('');
    assert.doesNotMatch(output, /super-secret-token-value/);
    assert.doesNotMatch(output, /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
    assert.match(output, /request_completed/);
  });
});
