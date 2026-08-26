import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function request({ port, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { Host: `localhost:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function principal() {
  return {
    userId: ADMIN_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'microsoft_entra', reference: 'tenant:admin' },
    roles: ['employee', 'tenant_admin'],
    permissions: ['tenant:integrations:manage'],
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-25T06:00:00.000Z',
      expiresAt: '2026-08-25T14:00:00.000Z',
      securityVersion: 1,
    },
  };
}

function tenant() {
  return {
    id: TENANT_ID,
    displayName: 'Pilot Tenant',
    status: 'onboarding',
    createdAt: '2026-08-25T05:00:00.000Z',
    updatedAt: '2026-08-25T05:00:00.000Z',
  };
}

async function withServer({ authenticated = true } = {}, run) {
  const calls = [];
  const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }) };
  const server = createHttpServer({
    config,
    microsoft365ConnectionService: {
      async discoverRooms(value) {
        calls.push(value);
        return [{
          externalRoomId: 'room-1',
          displayName: 'Room 1',
          resourceAddress: 'room-1@example.invalid',
          capacity: 8,
        }];
      },
    },
    resolvePrincipal: async () => authenticated ? principal() : null,
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

test('room discovery HTTP contract derives tenant context from the authenticated principal', async () => {
  await withServer({}, async ({ port, calls }) => {
    const response = await request({ port, path: '/api/v1/integrations/microsoft365/rooms' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.rooms, [{
      externalRoomId: 'room-1',
      displayName: 'Room 1',
      resourceAddress: 'room-1@example.invalid',
      capacity: 8,
    }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tenantContext.tenantId, TENANT_ID);
    assert.equal(calls[0].principal.userId, ADMIN_ID);
    assert.match(calls[0].correlationId, /^[0-9a-f-]{36}$/i);
  });
});

test('room discovery HTTP contract rejects browser-selected tenant/query authority and unsupported methods', async () => {
  await withServer({}, async ({ port, calls }) => {
    const query = await request({
      port,
      path: `/api/v1/integrations/microsoft365/rooms?tenantId=${TENANT_ID}`,
    });
    assert.equal(query.statusCode, 400);
    assert.equal(query.body.error.code, 'VALIDATION_FAILED');

    const mutation = await request({
      port,
      path: '/api/v1/integrations/microsoft365/rooms',
      method: 'POST',
    });
    assert.equal(mutation.statusCode, 405);
    assert.equal(mutation.body.error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(calls.length, 0);
  });
});

test('room discovery HTTP contract requires authentication before provider access', async () => {
  await withServer({ authenticated: false }, async ({ port, calls }) => {
    const response = await request({ port, path: '/api/v1/integrations/microsoft365/rooms' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
    assert.equal(calls.length, 0);
  });
});

test('room discovery GET rejects a request body before provider access', async () => {
  await withServer({}, async ({ port, calls }) => {
    const response = await request({
      port,
      path: '/api/v1/integrations/microsoft365/rooms',
      headers: { 'Content-Length': '2', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'REQUEST_BODY_NOT_ALLOWED');
    assert.equal(calls.length, 0);
  });
});
