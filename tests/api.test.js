import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequestService } from '../src/application/request-service.js';
import {
  CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
  createCodeShippedManagedBrandPolicy,
} from '../src/application/managed-brand-preset-policy.js';
import { createTenantPresentationService } from '../src/application/tenant-presentation-service.js';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../src/audit/event.js';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
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
import { createAuditHarness } from './support/audit-harness.js';

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
    schemaVersion: 1,
    version: 1,
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
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  return createRequestService({
    authorizationPolicy,
    auditService: audit.service,
    finalRoomConfirmationService: {
      async confirm({ principal: actor, tenantContext }) {
        const decision = authorizationPolicy.authorizeRequestTransition(
          actor,
          tenantContext,
          record,
          REQUEST_TRANSITION.CONFIRM,
          undefined,
        );
        record = {
          ...record,
          status: decision.nextStatus,
          statusReason: decision.reason,
          statusChangedAt: '2026-08-24T09:00:00.000Z',
          updatedAt: '2026-08-24T09:00:00.000Z',
        };
        return record;
      },
    },
    clock: () => Date.parse('2026-08-24T09:00:00.000Z'),
    repository: {
      async findByTenantIdAndId(tenantId, requestId) {
        if (!record || record.tenantId !== tenantId || record.id !== requestId) return null;
        return record;
      },
      async listHistoryPageByTenantIdAndId(tenantId, requestId, { limit }) {
        if (!record || record.tenantId !== tenantId || record.id !== requestId) return [];
        return [{
          version: 1,
          schemaVersion: 1,
          operation: 'migrated_legacy',
          capturedAt: record.updatedAt,
          request: {
            schemaVersion: 1,
            version: 1,
            id: record.id,
            details: null,
            pricing: null,
            configurationRevisions: null,
            policy: null,
            allocations: null,
          },
        }].slice(0, limit);
      },
      async transitionByTenantIdAndId({
        tenantId,
        requestId,
        expectedStatus,
        nextStatus,
        reason,
        changedAt,
      }) {
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

function auditQueryServiceFor(audit, authorizationPolicy) {
  return createTenantAuditQueryService({
    queryRepository: {
      async listByTenantId({ tenantId, limit, beforeId }) {
        return audit.repository.listByTenantId(tenantId, { limit, beforeId });
      },
    },
    integrityRepository: audit.repository,
    authorizationPolicy,
    auditService: audit.service,
    clock: () => Date.parse('2026-08-24T09:00:00.000Z'),
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

test('liveness remains available after the application rate-limit bucket is exhausted', async () => {
  const config = { ...testConfig(), rateLimitMax: 1 };
  await withServer({ config }, async ({ port }) => {
    const first = await request({ port, path: '/api/v1/health/ready' });
    assert.equal(first.statusCode, 200);
    const limited = await request({ port, path: '/api/v1/health/ready' });
    assert.equal(limited.statusCode, 429);
    const invalidMethod = await request({
      port,
      path: '/api/v1/health/live',
      method: 'POST',
    });
    assert.equal(invalidMethod.statusCode, 429);
    const live = await request({ port, path: '/api/v1/health/live' });
    assert.equal(live.statusCode, 200);
    assert.equal(live.body.status, 'ok');
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

test('Tenant presentation is integrated as an authenticated Tenant-derived all-role read', async () => {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  let loadedTenantId = null;
  const tenantPresentationService = createTenantPresentationService({
    repository: {
      async loadCurrent(tenantId) {
        loadedTenantId = tenantId;
        return {
          revision: 4,
          organization: {
            displayName: 'Presented Tenant',
            businessMetadata: {
              legalName: 'Private Legal Name',
              registrationNumber: 'PRIVATE-123',
              countryCode: 'DE',
            },
            presentation: { defaultLocale: 'de-DE', defaultCurrency: 'EUR' },
            branding: {
              logoAssetRef: CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
              accentToken: 'default',
            },
          },
        };
      },
    },
    authorizationPolicy,
    auditService: audit.service,
    managedBrandPolicy: createCodeShippedManagedBrandPolicy(),
  });
  await withServer({
    config: testConfig(),
    authorizationPolicy,
    auditService: audit.service,
    tenantPresentationService,
    resolvePrincipal: async () => principal(),
    loadTenant: async (tenantId) => tenantId === TENANT_ID ? tenant() : null,
  }, async ({ port, logs }) => {
    const result = await request({ port, path: '/api/v1/tenant/presentation' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.revision, 4);
    assert.equal(result.body.presentation.displayName, 'Presented Tenant');
    assert.equal(result.body.presentation.branding.logoPreset, 'conference-manager-mark');
    assert.equal(result.body.businessMetadata, undefined);
    assert.equal(JSON.stringify(result.body).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(result.body).includes('managed-brand:'), false);
    assert.equal(loadedTenantId, TENANT_ID);
    assert.equal(JSON.parse(logs.at(-1)).route, 'tenant_presentation');

    const manipulated = await request({
      port,
      path: `/api/v1/tenant/presentation?tenantId=${OTHER_TENANT_ID}`,
    });
    assert.equal(manipulated.statusCode, 400);
    assert.equal(manipulated.body.error.code, 'VALIDATION_FAILED');
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

test('tenant admin audit endpoint is scoped, minimized, correlated, and permission protected', async () => {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const tenantAdmin = principal({
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_AUDIT_READ],
  });
  await audit.service.record({
    principal: tenantAdmin,
    tenantContext: { tenantId: TENANT_ID },
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant',
    targetId: TENANT_ID,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { changedFieldCount: 1 },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });

  const options = {
    config: testConfig(),
    authorizationPolicy,
    auditService: audit.service,
    tenantAuditQueryService: auditQueryServiceFor(audit, authorizationPolicy),
    resolvePrincipal: async () => tenantAdmin,
    loadTenant: async () => tenant(),
  };
  await withServer(options, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/audit?limit=10' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.events.length, 1);
    assert.equal(result.body.events[0].action, AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED);
    assert.equal(result.body.events[0].tenantId, undefined);
    assert.equal(result.body.events[0].eventHash, undefined);
    assert.equal(result.body.events[0].previousHash, undefined);
    assert.equal(result.body.events[0].integrityVersion, undefined);
    assert.match(result.body.events[0].correlationId, /^[0-9a-f-]{36}$/i);
    assert.equal(audit.events.at(-1).action, AUDIT_ACTION.AUDIT_READ);
  });

  const employee = principal();
  await withServer({ ...options, resolvePrincipal: async () => employee }, async ({ port }) => {
    const denied = await request({ port, path: '/api/v1/audit' });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
    assert.equal(audit.events.at(-1).action, AUDIT_ACTION.AUTHORIZATION_DENIED);
  });
});

test('audit endpoint rejects manipulated queries and fails closed on chain-integrity failure', async () => {
  const authorizationPolicy = createAuthorizationPolicy();
  const tenantAdmin = principal({
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_AUDIT_READ],
  });
  const validAudit = createAuditHarness({ authorizationPolicy });
  const common = {
    config: testConfig(),
    authorizationPolicy,
    resolvePrincipal: async () => tenantAdmin,
    loadTenant: async () => tenant(),
  };
  await withServer({
    ...common,
    auditService: validAudit.service,
    tenantAuditQueryService: auditQueryServiceFor(validAudit, authorizationPolicy),
  }, async ({ port }) => {
    const injected = await request({
      port,
      path: `/api/v1/audit?tenantId=${OTHER_TENANT_ID}`,
    });
    assert.equal(injected.statusCode, 400);
    assert.equal(injected.body.error.code, 'VALIDATION_FAILED');

    const duplicate = await request({ port, path: '/api/v1/audit?limit=10&limit=20' });
    assert.equal(duplicate.statusCode, 400);
  });

  const compromised = createAuditHarness({ authorizationPolicy, verifyResult: false });
  await withServer({
    ...common,
    auditService: compromised.service,
    tenantAuditQueryService: auditQueryServiceFor(compromised, authorizationPolicy),
  }, async ({ port }) => {
    const result = await request({ port, path: '/api/v1/audit' });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error.code, 'AUDIT_INTEGRITY_UNAVAILABLE');
  });
});

test('employee request endpoint returns own object and conceals another employee object', async () => {
  const baseOptions = {
    config: testConfig(),
    resolvePrincipal: async () => principal(),
    loadTenant: async () => tenant(),
  };
  await withServer({ ...baseOptions, requestService: requestServiceFor(requestRecord()) }, async ({ port }) => {
    const injectedScope = await request({
      port,
      path: `/api/v1/requests/REQ-1?tenantId=${OTHER_TENANT_ID}`,
      headers: { 'X-Tenant-Id': OTHER_TENANT_ID },
    });
    assert.equal(injectedScope.statusCode, 400);
    const own = await request({ port, path: '/api/v1/requests/REQ-1' });
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.request.id, 'REQ-1');
    assert.equal(own.body.request.status, REQUEST_STATUS.SUBMITTED);
    assert.equal(own.body.request.tenantId, undefined);
    assert.equal(own.body.request.requesterUserId, undefined);
    const history = await request({ port, path: '/api/v1/requests/REQ-1/history' });
    assert.equal(history.statusCode, 200);
    assert.equal(history.body.schemaVersion, 2);
    assert.equal(history.body.history[0].operation, 'migrated_legacy');
    assert.equal(history.body.history[0].request.details, null);
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

test('confirmed booking proposal and decision routes require CSRF and reject authority injection', async () => {
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  const calls = [];
  const requestRef = {
    id: 'REQ-1', schemaVersion: 2, version: 1, status: REQUEST_STATUS.CONFIRMED,
  };
  const bookingChangeService = {
    async findOpen() { return { change: null, requestRef }; },
    async propose(values) {
      calls.push(['propose', values]);
      return { change: {
        id: '66666666-6666-4666-8666-666666666666',
        status: 'pending',
        roomId: values.proposed.roomId,
        startsAt: values.proposed.startsAt,
        endsAt: values.proposed.endsAt,
        internalParticipants: values.proposed.internalParticipants,
        externalParticipants: values.proposed.externalParticipants,
        rejectionReason: null,
        createdAt: '2026-08-26T10:00:00.000Z',
        updatedAt: '2026-08-26T10:00:00.000Z',
        requestSchemaVersion: 2,
        baseRequestVersion: 1,
        request: values.proposed,
        proposedRequest: { id: 'REQ-1', schemaVersion: 2, version: 2 },
      }, requestRef };
    },
    async approve(values) {
      calls.push(['approve', values]);
      return { status: 'blocked', alternatives: ['room-b'], change: { status: 'pending' }, requestRef };
    },
    async reject() { throw new Error('UNEXPECTED'); },
  };
  const common = {
    config: testConfig(),
    resolvePrincipal: async () => manager,
    verifyCsrf: async (req) => req.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async () => tenant(),
    bookingChangeService,
  };
  const proposal = {
    schemaVersion: 2,
    expectedVersion: 1,
    request: {
      title: 'Updated conference',
      roomId: 'room-b',
      startsAt: '2026-09-01T12:00:00.000Z',
      endsAt: '2026-09-01T13:00:00.000Z',
      internalParticipants: 4,
      externalParticipants: 0,
      serviceIds: [],
      catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
      dietaryRequirements: null,
      specialRequirements: null,
      allocations: [],
      configurationRevisions: {
        organization: 1,
        locations: 1,
        catalogue: 1,
        bookingPolicies: 1,
        costAllocation: 1,
      },
    },
  };
  await withServer(common, async ({ port }) => {
    const missingCsrf = await request({
      port, path: '/api/v1/requests/REQ-1/booking-change', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proposal),
    });
    assert.equal(missingCsrf.statusCode, 403);
    const injected = await request({
      port, path: '/api/v1/requests/REQ-1/booking-change', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ ...proposal, tenantId: OTHER_TENANT_ID }),
    });
    assert.equal(injected.statusCode, 400);
    const accepted = await request({
      port, path: '/api/v1/requests/REQ-1/booking-change', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify(proposal),
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.body.schemaVersion, 2);
    assert.equal(accepted.body.result.change.status, 'pending');
    assert.deepEqual(Object.keys(accepted.body.result).sort(), ['change', 'requestRef']);
    assert.equal(Object.hasOwn(accepted.body.result, 'request'), false);
    const decision = await request({
      port,
      path: '/api/v1/requests/REQ-1/booking-change/66666666-6666-4666-8666-666666666666/decision',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(decision.statusCode, 200);
    assert.deepEqual(Object.keys(decision.body.result).sort(), [
      'alternatives', 'change', 'requestRef', 'status',
    ]);
  });
  assert.deepEqual(calls.map(([operation]) => operation), ['propose', 'approve']);
});

test('booking-change response keeps one full projection below the configured response bound', async () => {
  const change = {
    id: '66666666-6666-4666-8666-666666666666',
    status: 'pending',
    request: { padding: 'd'.repeat(130_000) },
    proposedRequest: { padding: 'p'.repeat(510_000) },
  };
  const requestRef = {
    id: 'REQ-1', schemaVersion: 2, version: 1, status: REQUEST_STATUS.CONFIRMED,
  };
  const result = { change, requestRef };
  const config = testConfig();
  assert.ok(Buffer.byteLength(JSON.stringify({ schemaVersion: 2, result })) < config.maxResponseBytes);
  assert.ok(Buffer.byteLength(JSON.stringify({
    schemaVersion: 2,
    result: { ...result, request: change.proposedRequest },
  })) > config.maxResponseBytes);
  await withServer({
    config,
    resolvePrincipal: async () => principal({
      roles: [TENANT_ROLE.CONFERENCE_MANAGER],
      permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
    }),
    verifyCsrf: async () => true,
    loadTenant: async () => tenant(),
    bookingChangeService: {
      async findOpen() { return result; },
      async propose() { throw new Error('UNEXPECTED'); },
      async approve() { throw new Error('UNEXPECTED'); },
      async reject() { throw new Error('UNEXPECTED'); },
    },
  }, async ({ port }) => {
    const response = await request({
      port,
      path: '/api/v1/requests/REQ-1/booking-change',
      method: 'GET',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.body.result).sort(), ['change', 'requestRef']);
    assert.equal(response.body.result.change.request.padding.length, 130_000);
    assert.equal(response.body.result.change.proposedRequest.padding.length, 510_000);
  });
});

test('Request v2 create and resubmission routes require exact versioned CSRF contracts', async () => {
  const calls = [];
  const applicationService = {
    async createRequest(values) {
      calls.push(['create', values]);
      return { schemaVersion: 2, version: 1, id: 'REQ-V2', status: 'Submitted' };
    },
    async resubmitRequest(values) {
      calls.push(['resubmit', values]);
      return { schemaVersion: 2, version: values.expectedVersion + 1, id: values.requestId, status: 'Submitted' };
    },
  };
  const draft = {
    title: 'Canonical Request',
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 0,
    serviceIds: [],
    catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: {
      organization: 1,
      locations: 1,
      catalogue: 1,
      bookingPolicies: 1,
      costAllocation: 1,
    },
  };
  await withServer({
    config: testConfig(),
    resolvePrincipal: async () => principal(),
    verifyCsrf: async (req) => req.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async () => tenant(),
    productionApplicationService: applicationService,
  }, async ({ port }) => {
    const withoutCsrf = await request({
      port,
      path: '/api/v1/application/requests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 2, request: draft }),
    });
    assert.equal(withoutCsrf.statusCode, 403);

    const injected = await request({
      port,
      path: '/api/v1/application/requests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ schemaVersion: 2, request: draft, status: 'Confirmed' }),
    });
    assert.equal(injected.statusCode, 400);

    const created = await request({
      port,
      path: '/api/v1/application/requests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ schemaVersion: 2, request: draft }),
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.request.schemaVersion, 2);
    assert.equal(created.body.schemaVersion, 2);
    assert.equal(created.body.requestId, created.body.requestId.toLowerCase());
    assert.deepEqual(Object.keys(created.body).sort(), ['request', 'requestId', 'schemaVersion']);

    const resubmitted = await request({
      port,
      path: '/api/v1/application/requests/REQ-V2/resubmissions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
      body: JSON.stringify({ schemaVersion: 2, expectedVersion: 4, request: draft }),
    });
    assert.equal(resubmitted.statusCode, 200);
    assert.equal(resubmitted.body.request.version, 5);
    assert.equal(resubmitted.body.schemaVersion, 2);
    assert.deepEqual(Object.keys(resubmitted.body).sort(), ['request', 'requestId', 'schemaVersion']);
  });
  assert.deepEqual(calls.map(([operation]) => operation), ['create', 'resubmit']);
  assert.deepEqual(calls[0][1].requestDraft, draft);
  assert.equal(calls[1][1].expectedVersion, 4);
});

test('paged catalog and Manager report routes expose exact schema-v2 query contracts', async () => {
  const calls = [];
  const applicationService = {
    async listRequests(values) {
      calls.push(['list', values]);
      return {
        schemaVersion: 2,
        asOf: '2026-08-27T12:00:00.000Z',
        requests: [],
        page: { limit: 10, complete: true, nextCursor: null },
      };
    },
    async getCatalog(values) {
      calls.push(['catalog', values]);
      return {
        schemaVersion: 2,
        configurationRevisions: {
          organization: 1, locations: 1, catalogue: 1, bookingPolicies: 1, costAllocation: 1,
        },
        bookingPolicy: { policyVersionId: 'policy-v1' },
        organization: { defaultCurrency: 'EUR' },
        costAllocation: { allocationRequired: false },
        context: 'catalog-context',
        section: values.query.section,
        entries: [],
        page: { limit: 10, complete: true, nextCursor: null },
      };
    },
    async getRequestReport(values) {
      calls.push(['report', values]);
      return {
        schemaVersion: 2,
        asOf: '2026-08-27T12:00:00.000Z',
        range: {
          field: 'startsAt',
          fromInclusive: values.query.from,
          toExclusive: values.query.to,
          timeZone: 'UTC',
        },
        requests: [],
        page: { limit: 10, complete: true, nextCursor: null },
      };
    },
  };
  const managerPrincipal = principal({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  await withServer({
    config: testConfig(),
    resolvePrincipal: async () => managerPrincipal,
    verifyCsrf: async () => true,
    loadTenant: async () => tenant(),
    productionApplicationService: applicationService,
  }, async ({ port }) => {
    const catalog = await request({
      port,
      path: '/api/v1/application/catalog?section=sites&limit=10',
    });
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.body.schemaVersion, 2);
    assert.equal(catalog.body.section, 'sites');
    assert.equal(catalog.body.catalog, undefined);

    const list = await request({
      port,
      path: '/api/v1/application/requests?limit=10',
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.schemaVersion, 2);
    assert.deepEqual(list.body.requests, []);
    assert.equal(list.body.page.complete, true);

    const report = await request({
      port,
      path: '/api/v1/application/reports/requests?from=2026-01-01T00%3A00%3A00.000Z&to=2027-01-01T00%3A00%3A00.000Z&limit=10',
    });
    assert.equal(report.statusCode, 200);
    assert.equal(report.body.schemaVersion, 2);
    assert.equal(report.body.range.timeZone, 'UTC');
    assert.equal(report.body.report, undefined);

    for (const path of [
      '/api/v1/application/catalog',
      '/api/v1/application/catalog?section=services&section=rooms',
      '/api/v1/application/catalog?section=services&tenantId=foreign',
      '/api/v1/application/requests?limit=2&limit=3',
      '/api/v1/application/requests?tenantId=foreign',
      '/api/v1/application/reports/requests?from=2026-01-01T00%3A00%3A00.000Z',
      '/api/v1/application/reports/requests?from=x&from=y&to=z',
      '/api/v1/application/reports/requests?from=x&to=y&tenantId=foreign',
    ]) {
      const invalid = await request({ port, path });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');
    }

    const wrongMethod = await request({
      port,
      path: '/api/v1/application/reports/requests?from=x&to=y',
      method: 'POST',
    });
    assert.equal(wrongMethod.statusCode, 405);
  });
  assert.deepEqual(calls.map(([name]) => name), ['catalog', 'list', 'report']);
  assert.deepEqual(calls[0][1].query, {
    section: 'sites', limit: '10', cursor: undefined, context: undefined,
  });
  assert.deepEqual(calls[1][1].query, { limit: '10', cursor: undefined });
  assert.equal(calls[2][1].query.limit, '10');
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
