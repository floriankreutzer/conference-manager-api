import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpServer } from '../src/server.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://security.test';
const DAST_SECRET = 'security-dast-secret-value-at-least-32-bytes';

const config = Object.freeze({
  mode: 'pilot',
  serviceVersion: '0.1.0',
  buildId: 'security-dast',
  publicOrigin: ORIGIN,
  host: '127.0.0.1',
  port: 3000,
  maxBodyBytes: 1_024,
  maxResponseBytes: 65_536,
  rateLimitMax: 1_000,
  rateLimitWindowMs: 60_000,
  requestTimeoutMs: 5_000,
  headersTimeoutMs: 5_000,
  keepAliveTimeoutMs: 1_000,
  readinessTimeoutMs: 500,
  sessionTtlSeconds: 3_600,
  csrfSecret: DAST_SECRET,
  auditHmacSecret: DAST_SECRET,
  databaseUrl: 'postgresql://security.test/conference_manager',
  databaseSsl: 'verify-full',
});

const principal = Object.freeze({
  userId: USER_ID,
  tenantId: TENANT_ID,
  providerIdentity: Object.freeze({ provider: 'test_idp', reference: 'dast-user' }),
  roles: Object.freeze(['employee']),
  permissions: Object.freeze(['request:read', 'request:cancel']),
  session: Object.freeze({
    id: SESSION_ID,
    issuedAt: '2026-08-24T10:00:00.000Z',
    expiresAt: '2026-08-24T18:00:00.000Z',
    securityVersion: 1,
  }),
});

const tenant = Object.freeze({
  id: TENANT_ID,
  displayName: 'DAST Tenant',
  status: 'active',
  createdAt: '2026-08-24T09:00:00.000Z',
  updatedAt: '2026-08-24T09:00:00.000Z',
});

const logger = Object.freeze({
  healthEvaluated() {},
  requestCompleted() {},
  securityOutcome() {},
  unhandledError() {},
});

const requestService = Object.freeze({
  async transitionRequest() {
    throw new Error('DAST_VALIDATION_BYPASSED');
  },
});

function request(serverPort, {
  method = 'GET',
  path = '/api/v1/health/live',
  host = 'security.test',
  origin,
  headers = {},
  body,
} = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { Host: host, ...headers };
    if (origin !== undefined) requestHeaders.Origin = origin;
    if (body !== undefined && requestHeaders['Content-Length'] === undefined) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const outgoing = http.request({
      hostname: '127.0.0.1',
      port: serverPort,
      method,
      path,
      headers: requestHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (rawBody) {
          try {
            json = JSON.parse(rawBody);
          } catch {
            json = null;
          }
        }
        resolve(Object.freeze({
          statusCode: response.statusCode,
          headers: response.headers,
          rawBody,
          json,
        }));
      });
    });
    outgoing.on('error', reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode);
  assert.equal(response.json?.error?.code, code);
  assert.equal(typeof response.json?.error?.requestId, 'string');
  assert.equal(response.rawBody.includes('stack'), false);
  assert.equal(response.rawBody.includes('postgresql://'), false);
  assert.equal(response.rawBody.includes('DAST_VALIDATION_BYPASSED'), false);
  assert.equal(response.rawBody.includes(DAST_SECRET), false);
}

const server = createHttpServer({
  config,
  logger,
  resolvePrincipal: async () => principal,
  verifyCsrf: async (incoming) => incoming.headers['x-csrf-token'] === 'valid-dast-csrf',
  loadTenant: async (tenantId) => (tenantId === TENANT_ID ? tenant : null),
  requestService,
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  const live = await request(port);
  assert.equal(live.statusCode, 200);
  assert.equal(live.json?.status, 'ok');
  assert.equal(live.headers['cache-control'], 'no-store');
  assert.equal(live.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(live.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(live.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(live.headers['referrer-policy'], 'no-referrer');
  assert.equal(live.headers['x-content-type-options'], 'nosniff');
  assert.equal(live.headers['x-frame-options'], 'DENY');
  assert.equal(live.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(live.headers['access-control-allow-origin'], undefined);
  assert.equal(typeof live.headers['x-request-id'], 'string');

  assertError(await request(port, { host: 'attacker.example' }), 400, 'HOST_NOT_ALLOWED');
  assertError(await request(port, { origin: 'https://attacker.example' }), 403, 'ORIGIN_NOT_ALLOWED');
  assertError(await request(port, { method: 'TRACE' }), 405, 'METHOD_NOT_ALLOWED');
  assertError(await request(port, { path: 'http://security.test/api/v1/health/live' }), 400, 'REQUEST_TARGET_INVALID');
  assertError(await request(port, { path: '/api/%2e%2e/v1/health/live' }), 400, 'REQUEST_TARGET_INVALID');

  const transitionPath = '/api/v1/requests/REQ-1/transitions';
  const validHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
  assertError(await request(port, {
    method: 'POST',
    path: transitionPath,
    headers: validHeaders,
    body: JSON.stringify({ transition: 'cancel' }),
  }), 403, 'CSRF_INVALID');

  assertError(await request(port, {
    method: 'POST',
    path: transitionPath,
    headers: { ...validHeaders, 'X-CSRF-Token': 'valid-dast-csrf' },
    body: '{not-json',
  }), 400, 'INVALID_JSON');

  assertError(await request(port, {
    method: 'POST',
    path: transitionPath,
    headers: { ...validHeaders, 'X-CSRF-Token': 'valid-dast-csrf' },
    body: JSON.stringify({ transition: 'cancel', tenantId: TENANT_ID }),
  }), 400, 'VALIDATION_FAILED');

  assertError(await request(port, {
    method: 'POST',
    path: transitionPath,
    headers: { ...validHeaders, 'X-CSRF-Token': 'valid-dast-csrf' },
    body: JSON.stringify({ transition: 'cancel', reason: 'x'.repeat(1_100) }),
  }), 413, 'BODY_TOO_LARGE');

  console.log('Live HTTP DAST security smoke gate passed.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
