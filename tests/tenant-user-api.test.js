import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createTenantUserAdministrationService } from '../src/application/tenant-user-administration-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
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

function principal() {
  return {
    userId: ADMIN_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'test_oidc', reference: 'tenant:admin' },
    roles: ['employee', 'tenant_admin'],
    permissions: [
      'request:read',
      'request:cancel',
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-24T10:00:00.000Z',
      expiresAt: '2026-08-24T18:00:00.000Z',
      securityVersion: 1,
    },
  };
}

function tenant() {
  return {
    id: TENANT_ID,
    displayName: 'Pilot Tenant',
    status: 'onboarding',
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
  };
}

function service() {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  return createTenantUserAdministrationService({
    authorizationPolicy,
    auditService: audit.service,
    clock: () => Date.parse('2026-08-24T16:00:00.000Z'),
    repository: {
      async listByTenantId({ tenantId }) {
        assert.equal(tenantId, TENANT_ID);
        return [{
          tenantId: TENANT_ID,
          userId: TARGET_ID,
          displayName: 'Conference User',
          active: true,
          securityVersion: 1,
          elevatedRoles: ['conference_manager'],
        }];
      },
      async setElevatedRoles(value) {
        assert.equal(value.tenantId, TENANT_ID);
        const auditEvent = value.auditEventFor({
          previousElevatedRoles: ['conference_manager'],
          nextElevatedRoles: value.elevatedRoles,
        });
        assert.equal(auditEvent.action, 'tenant.user_permissions.changed');
        return {
          status: 'updated',
          user: {
            tenantId: TENANT_ID,
            userId: TARGET_ID,
            displayName: 'Conference User',
            active: true,
            securityVersion: 2,
            elevatedRoles: value.elevatedRoles,
          },
        };
      },
    },
  });
}

function options() {
  const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }) };
  return {
    config,
    tenantUserAdministrationService: service(),
    resolvePrincipal: async () => principal(),
    verifyCsrf: async (requestValue) => requestValue.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async (tenantId) => tenantId === TENANT_ID ? tenant() : null,
  };
}

test('Tenant Admin can list tenant users without a browser-selected tenant', async () => {
  const serverOptions = options();
  await withServer(serverOptions, async (port) => {
    const response = await request({ port, path: '/api/v1/tenant/users?limit=25' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.users, [{
      id: TARGET_ID,
      displayName: 'Conference User',
      active: true,
      roles: ['employee', 'conference_manager'],
    }]);
    assert.equal(Object.hasOwn(response.body.users[0], 'tenantId'), false);

    const injectedTenant = await request({
      port,
      path: `/api/v1/tenant/users?tenantId=${TENANT_ID}`,
    });
    assert.equal(injectedTenant.statusCode, 400);
  });
});

test('role mutation requires CSRF and accepts only elevated role identifiers', async () => {
  const serverOptions = options();
  await withServer(serverOptions, async (port) => {
    const path = `/api/v1/tenant/users/${TARGET_ID}/roles`;
    const body = JSON.stringify({ roles: ['tenant_admin'] });
    const missingCsrf = await request({
      port,
      path,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(missingCsrf.body.error.code, 'CSRF_INVALID');

    const changed = await request({
      port,
      path,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CSRF-Token': CSRF_TOKEN,
      },
      body,
    });
    assert.equal(changed.statusCode, 200);
    assert.deepEqual(changed.body.user.roles, ['employee', 'tenant_admin']);

    const invalid = JSON.stringify({ roles: ['platform_admin'] });
    const rejected = await request({
      port,
      path,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(invalid),
        'X-CSRF-Token': CSRF_TOKEN,
      },
      body: invalid,
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.error.code, 'VALIDATION_FAILED');
  });
});

test('role mutation rejects client-selected tenant and malformed user identifiers', async () => {
  const serverOptions = options();
  await withServer(serverOptions, async (port) => {
    const body = JSON.stringify({ roles: [] });
    const queryTenant = await request({
      port,
      path: `/api/v1/tenant/users/${TARGET_ID}/roles?tenantId=${TENANT_ID}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CSRF-Token': CSRF_TOKEN,
      },
      body,
    });
    assert.equal(queryTenant.statusCode, 400);

    const malformed = await request({
      port,
      path: '/api/v1/tenant/users/not-a-uuid/roles',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CSRF-Token': CSRF_TOKEN,
      },
      body,
    });
    assert.equal(malformed.statusCode, 404);
  });
});
