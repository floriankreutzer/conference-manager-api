import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  Microsoft365ConnectionConflictError,
} from '../src/application/microsoft365-connection-errors.js';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_TENANT_ID = '44444444-4444-4444-8444-444444444444';
const STATE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
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

function tenantContext() {
  return {
    tenantId: TENANT_ID,
    status: 'onboarding',
    tenant: tenant(),
  };
}

function connection(status = 'connected') {
  return {
    status,
    placesPermission: status === 'connected' ? 'granted' : 'unknown',
    calendarsPermission: status === 'connected' ? 'granted' : 'unknown',
    reason: null,
    lastVerifiedAt: status === 'connected' ? '2026-08-25T06:30:00.000Z' : null,
    requiredPermissions: ['Place.Read.All', 'Calendars.ReadBasic.All'],
  };
}

function options({ authenticated = true, overrides = {} } = {}) {
  const calls = [];
  const service = {
    async getConnection(value) {
      calls.push({ operation: 'read', value });
      return connection();
    },
    async startConnection(value) {
      calls.push({ operation: 'connect', value });
      return {
        authorizationUrl: `https://login.microsoftonline.com/${PROVIDER_TENANT_ID}/v2.0/adminconsent`,
        expiresAt: '2026-08-25T06:40:00.000Z',
      };
    },
    async completeConsent(value) {
      calls.push({ operation: 'callback', value });
      return connection(value.approved ? 'connected' : 'disconnected');
    },
    async verifyConnection(value) {
      calls.push({ operation: 'verify', value });
      return connection();
    },
    async disconnect(value) {
      calls.push({ operation: 'disconnect', value });
      return connection('disconnected');
    },
    ...overrides,
  };
  const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }) };
  return {
    calls,
    serverOptions: {
      config,
      microsoft365ConnectionService: service,
      resolvePrincipal: async () => authenticated ? principal() : null,
      verifyCsrf: async (requestValue) => requestValue.headers['x-csrf-token'] === CSRF_TOKEN,
      loadTenant: async (tenantId) => tenantId === TENANT_ID ? tenant() : null,
    },
  };
}

test('connection read requires an authenticated tenant and rejects browser-selected tenant authority', async () => {
  const authenticated = options();
  await withServer(authenticated.serverOptions, async (port) => {
    const response = await request({ port, path: '/api/v1/integrations/microsoft365' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.connection, connection());
    assert.equal(authenticated.calls[0].value.tenantContext.tenantId, TENANT_ID);

    const injected = await request({
      port,
      path: `/api/v1/integrations/microsoft365?tenantId=${TENANT_ID}`,
    });
    assert.equal(injected.statusCode, 400);
    assert.equal(authenticated.calls.length, 1);
  });

  const anonymous = options({ authenticated: false });
  await withServer(anonymous.serverOptions, async (port) => {
    const response = await request({ port, path: '/api/v1/integrations/microsoft365' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  });
});

test('connect, verify and disconnect require CSRF and reject request bodies', async () => {
  const value = options();
  await withServer(value.serverOptions, async (port) => {
    for (const [path, method] of [
      ['/api/v1/integrations/microsoft365/connect', 'POST'],
      ['/api/v1/integrations/microsoft365/verify', 'POST'],
      ['/api/v1/integrations/microsoft365', 'DELETE'],
    ]) {
      const missingCsrf = await request({ port, path, method });
      assert.equal(missingCsrf.statusCode, 403);
      assert.equal(missingCsrf.body.error.code, 'CSRF_INVALID');

      const withBody = await request({
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '2',
          'X-CSRF-Token': CSRF_TOKEN,
        },
        body: '{}',
      });
      assert.equal(withBody.statusCode, 400);
      assert.equal(withBody.body.error.code, 'REQUEST_BODY_NOT_ALLOWED');
    }
    assert.equal(value.calls.length, 0);
  });
});

test('authorized lifecycle mutations expose only bounded same-origin API results', async () => {
  const value = options();
  await withServer(value.serverOptions, async (port) => {
    const connect = await request({
      port,
      path: '/api/v1/integrations/microsoft365/connect',
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, 'Content-Length': '0' },
    });
    assert.equal(connect.statusCode, 200);
    assert.equal(
      connect.body.authorizationUrl,
      `https://login.microsoftonline.com/${PROVIDER_TENANT_ID}/v2.0/adminconsent`,
    );

    const verify = await request({
      port,
      path: '/api/v1/integrations/microsoft365/verify',
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, 'Content-Length': '0' },
    });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.body.connection.status, 'connected');

    const disconnect = await request({
      port,
      path: '/api/v1/integrations/microsoft365',
      method: 'DELETE',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, 'Content-Length': '0' },
    });
    assert.equal(disconnect.statusCode, 200);
    assert.equal(disconnect.body.connection.status, 'disconnected');
    assert.deepEqual(value.calls.map((entry) => entry.operation), ['connect', 'verify', 'disconnect']);
  });
});

test('successful and denied provider callbacks are authenticated, fixed-redirect and support missing error tenant', async () => {
  const value = options();
  await withServer(value.serverOptions, async (port) => {
    const success = await request({
      port,
      path: `/api/v1/integrations/microsoft365/callback?admin_consent=True&tenant=${PROVIDER_TENANT_ID}&state=${STATE}`,
    });
    assert.equal(success.statusCode, 303);
    assert.equal(success.headers.location, '/?integration=microsoft365_connected');
    assert.deepEqual(value.calls[0].value, {
      principal: principal(),
      tenantContext: tenantContext(),
      correlationId: value.calls[0].value.correlationId,
      state: STATE,
      providerTenantReference: PROVIDER_TENANT_ID,
      approved: true,
    });

    const denied = await request({
      port,
      path: `/api/v1/integrations/microsoft365/callback?error=access_denied&state=${STATE}`,
    });
    assert.equal(denied.statusCode, 303);
    assert.equal(denied.headers.location, '/?integration=microsoft365_consent_denied');
    assert.equal(value.calls[1].value.providerTenantReference, null);
    assert.equal(value.calls[1].value.approved, false);
  });
});

test('callback query pollution and provider-state conflicts fail closed without leaking provider details', async () => {
  const polluted = options();
  await withServer(polluted.serverOptions, async (port) => {
    for (const path of [
      `/api/v1/integrations/microsoft365/callback?state=${STATE}&state=${STATE}&error=access_denied`,
      `/api/v1/integrations/microsoft365/callback?state=${STATE}&error=access_denied&tenantId=${TENANT_ID}`,
      `/api/v1/integrations/microsoft365/callback?state=short&error=access_denied`,
    ]) {
      const response = await request({ port, path });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    }
    assert.equal(polluted.calls.length, 0);
  });

  const conflict = options({
    overrides: {
      async completeConsent() {
        throw new Microsoft365ConnectionConflictError('PROVIDER_SECRET_DETAIL');
      },
    },
  });
  await withServer(conflict.serverOptions, async (port) => {
    const response = await request({
      port,
      path: `/api/v1/integrations/microsoft365/callback?error=access_denied&error_description=sensitive&state=${STATE}`,
    });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/?integration=microsoft365_connection_failed');
    assert.equal(JSON.stringify(response).includes('PROVIDER_SECRET_DETAIL'), false);
    assert.equal(JSON.stringify(response).includes('sensitive'), false);
  });
});

test('unsupported methods are rejected before lifecycle service execution', async () => {
  const value = options();
  await withServer(value.serverOptions, async (port) => {
    const wrongRead = await request({
      port,
      path: '/api/v1/integrations/microsoft365',
      method: 'PATCH',
    });
    assert.equal(wrongRead.statusCode, 405);

    const wrongCallback = await request({
      port,
      path: `/api/v1/integrations/microsoft365/callback?error=access_denied&state=${STATE}`,
      method: 'POST',
    });
    assert.equal(wrongCallback.statusCode, 405);
    assert.equal(value.calls.length, 0);
  });
});
