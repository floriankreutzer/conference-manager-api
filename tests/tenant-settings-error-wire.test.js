import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { TenantSettingsConflictError } from '../src/application/tenant-settings-errors.js';
import { PERMISSION, TENANT_ROLE } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';
import { TENANT_STATUS } from '../src/tenancy/tenant.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function principal() {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'test_oidc', reference: 'subject-123' },
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_CONFIGURE],
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-26T20:00:00.000Z',
      expiresAt: '2026-09-26T20:00:00.000Z',
      securityVersion: 1,
    },
  };
}

function tenant() {
  return {
    id: TENANT_ID,
    displayName: 'Wire Test Tenant',
    status: TENANT_STATUS.ACTIVE,
    createdAt: '2026-08-26T20:00:00.000Z',
    updatedAt: '2026-08-26T20:00:00.000Z',
  };
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: `localhost:${port}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ statusCode: response.statusCode, body });
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('Tenant settings conflicts expose only the safe current revision context on the HTTP wire', async (t) => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:3000',
    RATE_LIMIT_MAX: '50',
  });
  const server = createHttpServer({
    config,
    resolvePrincipal: async () => principal(),
    loadTenant: async () => tenant(),
    productionApplicationService: {
      async getConfiguration() {
        throw new TenantSettingsConflictError(9);
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  config.publicOrigin = `http://localhost:${address.port}`;

  const result = await request(address.port, '/api/v1/application/configuration');
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.code, 'TENANT_SETTINGS_REVISION_CONFLICT');
  assert.equal(result.body.error.currentRevision, 9);
  assert.match(result.body.error.requestId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(
    Object.keys(result.body.error).sort(),
    ['code', 'currentRevision', 'requestId'],
  );
});
