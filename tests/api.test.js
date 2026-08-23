import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer } from '../src/server.js';
import { TENANT_STATUS } from '../src/tenancy/tenant.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';

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

test('protected session resolves tenant only from the authenticated principal', async () => {
  const config = testConfig();
  await withServer({
    config,
    resolvePrincipal: async () => ({ userId: USER_ID, tenantId: TENANT_ID, roles: ['employee'] }),
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
    assert.deepEqual(result.body.roles, ['employee']);
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
      resolvePrincipal: async () => ({ userId: USER_ID, tenantId: TENANT_ID, roles: ['employee'] }),
      loadTenant: async () => tenantRecord,
    }, async ({ port }) => {
      const result = await request({ port, path: '/api/v1/session' });
      assert.equal(result.statusCode, 403);
      assert.equal(result.body.error.code, 'TENANT_UNAVAILABLE');
    });
  }
});

test('logs contain only bounded metadata and do not copy authorization or cookie headers', async () => {
  const config = testConfig();
  await withServer({ config }, async ({ port, logs }) => {
    await request({
      port,
      path: '/api/v1/health/live',
      headers: {
        Authorization: 'Bearer super-secret-token-value',
        Cookie: 'session=super-secret-session-value',
      },
    });
    const output = logs.join('');
    assert.doesNotMatch(output, /super-secret-token-value/);
    assert.doesNotMatch(output, /super-secret-session-value/);
    assert.match(output, /request_completed/);
  });
});
