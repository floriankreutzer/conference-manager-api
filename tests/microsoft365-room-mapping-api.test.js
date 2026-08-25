import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';

const TENANT_ID = '51515151-5151-4151-8151-515151515151';
const ADMIN_ID = '52525252-5252-4252-8252-525252525252';
const SESSION_ID = '53535353-5353-4353-8353-535353535353';

function request({ port, path, method = 'GET', body = null, csrf = null }) {
  return new Promise((resolve, reject) => {
    const rawBody = body === null ? null : JSON.stringify(body);
    const headers = { Host: `localhost:${port}` };
    if (rawBody !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    if (csrf !== null) headers['X-CSRF-Token'] = csrf;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (rawBody !== null) req.write(rawBody);
    req.end();
  });
}

function principal() {
  return {
    userId: ADMIN_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'microsoft_entra', reference: 'tenant:admin' },
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
      issuedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T20:00:00.000Z',
      securityVersion: 1,
    },
  };
}

function tenant() {
  return {
    id: TENANT_ID,
    displayName: 'Pilot Tenant',
    status: 'onboarding',
    createdAt: '2026-08-25T11:00:00.000Z',
    updatedAt: '2026-08-25T11:00:00.000Z',
  };
}

function mapping() {
  return {
    roomId: '54545454-5454-4454-8454-545454545454',
    externalRoomId: 'provider-room-1',
    resourceAddress: 'room-1@example.invalid',
    providerDisplayName: 'Provider Room 1',
    providerCapacity: 12,
    providerStatus: 'active',
    lastSeenAt: '2026-08-25T12:00:00.000Z',
    localRoom: {
      id: '54545454-5454-4454-8454-545454545454',
      siteId: 'site-a',
      name: 'Local Room',
      capacity: 10,
      active: true,
    },
  };
}

async function withServer(run) {
  const calls = [];
  const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }) };
  const server = createHttpServer({
    config,
    microsoft365ConnectionService: {
      async listRoomMappings(value) {
        calls.push({ operation: 'list', value });
        return [mapping()];
      },
      async importSelectedRooms(value) {
        calls.push({ operation: 'import', value });
        return [mapping()];
      },
      async synchronizeRoomMappings(value) {
        calls.push({ operation: 'sync', value });
        return [mapping()];
      },
    },
    resolvePrincipal: async () => principal(),
    verifyCsrf: async (req) => req.headers['x-csrf-token'] === 'valid-csrf',
    loadTenant: async (tenantId) => tenantId === TENANT_ID ? tenant() : null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  config.publicOrigin = `http://localhost:${port}`;
  try {
    await run({ port, calls });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('room mapping HTTP reads derive tenant context only from the authenticated principal', async () => {
  await withServer(async ({ port, calls }) => {
    const response = await request({
      port,
      path: '/api/v1/integrations/microsoft365/room-mappings',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.mappings.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'list');
    assert.equal(calls[0].value.principal.userId, ADMIN_ID);
    assert.equal(calls[0].value.tenantContext.tenantId, TENANT_ID);
    assert.equal('tenantId' in response.body.mappings[0], false);
  });
});

test('room mapping import requires CSRF and accepts only the exact top-level selection contract', async () => {
  await withServer(async ({ port, calls }) => {
    const selections = [{
      externalRoomId: 'provider-room-1',
      siteId: 'site-a',
      name: 'Local Room',
      capacity: 10,
    }];
    const denied = await request({
      port,
      path: '/api/v1/integrations/microsoft365/room-mappings/import',
      method: 'POST',
      body: { selections },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, 'CSRF_INVALID');
    assert.equal(calls.length, 0);

    const malformed = await request({
      port,
      path: '/api/v1/integrations/microsoft365/room-mappings/import',
      method: 'POST',
      csrf: 'valid-csrf',
      body: { selections, tenantId: TENANT_ID },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_FAILED');
    assert.equal(calls.length, 0);

    const imported = await request({
      port,
      path: '/api/v1/integrations/microsoft365/room-mappings/import',
      method: 'POST',
      csrf: 'valid-csrf',
      body: { selections },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'import');
    assert.deepEqual(calls[0].value.selections, selections);
    assert.equal(calls[0].value.tenantContext.tenantId, TENANT_ID);
  });
});

test('room mapping sync requires CSRF, rejects browser-selected authority and forbids a request body', async () => {
  await withServer(async ({ port, calls }) => {
    const query = await request({
      port,
      path: `/api/v1/integrations/microsoft365/room-mappings/sync?tenantId=${TENANT_ID}`,
      method: 'POST',
      csrf: 'valid-csrf',
    });
    assert.equal(query.statusCode, 400);
    assert.equal(query.body.error.code, 'VALIDATION_FAILED');

    const body = await request({
      port,
      path: '/api/v1/integrations/microsoft365/room-mappings/sync',
      method: 'POST',
      csrf: 'valid-csrf',
      body: { force: true },
    });
    assert.equal(body.statusCode, 400);
    assert.equal(body.body.error.code, 'REQUEST_BODY_NOT_ALLOWED');
    assert.equal(calls.length, 0);

    const synced = await request({
      port,
      path: '/api/v1/integrations/microsoft365/room-mappings/sync',
      method: 'POST',
      csrf: 'valid-csrf',
    });
    assert.equal(synced.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'sync');
    assert.equal(calls[0].value.tenantContext.tenantId, TENANT_ID);
  });
});
