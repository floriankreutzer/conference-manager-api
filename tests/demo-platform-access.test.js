import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { loadDemoPlatformAccessConfig } from '../src/demo/platform-access-config.js';
import { createDemoPlatformAccessGate } from '../src/demo/platform-access-gate.js';
import { createDemoPlatformHttpServer } from '../src/demo/platform-server.js';
import { createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { createDemoTrafficGate } from '../src/demo/traffic-gate.js';
import { loadDemoTrafficGateConfig } from '../src/demo/traffic-gate-config.js';
import { createHealthMonitor } from '../src/observability/health.js';
import { platformHealthRoutes } from '../src/platform/http/health-routes.js';
import { platformSessionRoutes } from '../src/platform/http/session-routes.js';
import { trafficFixture, NOW, listen, request, authenticatedPrincipal } from './support/demo-traffic-gate-fixture.js';

function credentials() {
  const password = randomBytes(32).toString('base64url');
  const passwordHash = createHash('sha256').update('conference-manager:demo-platform-access:v1:').update(password).digest('hex');
  const authorization = `Basic ${Buffer.from(`ops:${password}`).toString('base64')}`;
  return { password, passwordHash, authorization, settings: { mode: 'password', passwordHash } };
}

test('temporary Platform access configuration fails closed for malformed or unused credentials', () => {
  const { passwordHash } = credentials();
  assert.deepEqual(loadDemoPlatformAccessConfig({}), { mode: 'public', passwordHash: null });
  assert.equal(loadDemoPlatformAccessConfig({
    DEMO_PLATFORM_ACCESS_MODE: 'password', DEMO_PLATFORM_ACCESS_PASSWORD_SHA256: passwordHash,
  }).mode, 'password');
  for (const env of [
    { DEMO_PLATFORM_ACCESS_MODE: 'Password' }, { DEMO_PLATFORM_ACCESS_MODE: 'password' },
    { DEMO_PLATFORM_ACCESS_PASSWORD_SHA256: passwordHash },
    { DEMO_PLATFORM_ACCESS_MODE: 'password', DEMO_PLATFORM_ACCESS_PASSWORD_SHA256: '' },
    { DEMO_PLATFORM_ACCESS_MODE: 'password', DEMO_PLATFORM_ACCESS_PASSWORD_SHA256: [passwordHash] },
    { DEMO_PLATFORM_ACCESS_MODE: 'password', DEMO_PLATFORM_ACCESS_PASSWORD_SHA256: passwordHash.toUpperCase() },
    { DEMO_PLATFORM_ACCESS_MODE: 'password', DEMO_PLATFORM_ACCESS_PASSWORD_SHA256: passwordHash, DEMO_PLATFORM_ACCESS_RAW: 'x' },
  ]) assert.throws(() => loadDemoPlatformAccessConfig(env), /DEMO_PLATFORM_ACCESS_CONFIG_INVALID/);
  assert.throws(() => createDemoPlatformAccessGate({ settings: { mode: 'password' },
    publicOrigin: 'https://platform.demo.invalid' }), /DEMO_PLATFORM_ACCESS_GATE_INVALID/);
  assert.throws(() => createDemoPlatformAccessGate({ settings: { mode: 'public', passwordHash: null },
    publicOrigin: 'http://platform.demo.invalid' }), /DEMO_PLATFORM_ACCESS_GATE_INVALID/);
});

test('password gate protects all assets and APIs, strips credentials and rejects duplicate/malformed authority', async (t) => {
  const fixture = credentials();
  const gate = createDemoPlatformAccessGate({ settings: fixture.settings, publicOrigin: 'https://platform.demo.invalid' });
  let calls = 0;
  const port = await listen(t, http.createServer((req, res) => {
    if (gate.handle(req, res)) return;
    calls += 1;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headersDistinct.authorization, undefined);
    assert.ok(!req.rawHeaders.includes(fixture.authorization));
    res.end('protected-handler');
  }));
  for (const path of ['/', '/index.html', '/src/platform-admin/demo.js', '/assets/app.js',
    '/api/v1/platform/session', '/api/v1/platform/demo/persona', '/api/v1/platform/demo/reset']) {
    const result = await request(port, 'platform', path);
    assert.equal(result.status, 401);
    assert.match(result.headers['www-authenticate'], /^Basic realm=/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.ok(!result.body.includes(fixture.password));
  }
  for (const authorization of [credentials().authorization, 'Bearer arbitrary', 'Basic !!',
    fixture.authorization.slice(0, -1), [fixture.authorization, fixture.authorization],
    `Basic ${Buffer.from(`admin:${fixture.password}`).toString('base64')}`]) {
    assert.equal((await request(port, 'platform', '/', { authorization })).status, 401);
  }
  for (const [path, headers] of [
    ['/', { host: 'evil.invalid' }], ['/', { origin: 'https://evil.invalid' }],
    ['/api/%2e%2e/private', {}], ['/'.padEnd(8_194, 'x'), {}],
  ]) assert.equal((await request(port, 'platform', path, { authorization: fixture.authorization, ...headers })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request(port, 'platform', '/', { authorization: fixture.authorization })).status, 200);
  assert.equal(calls, 1);
});

test('only exact bodyless GET health probes bypass the password; failure limits are bounded and recover', async (t) => {
  const fixture = credentials();
  let now = NOW;
  const gate = createDemoPlatformAccessGate({ settings: fixture.settings, publicOrigin: 'https://platform.demo.invalid',
    clock: () => now });
  const port = await listen(t, http.createServer((req, res) => {
    if (!gate.handle(req, res)) res.end('handler');
  }));
  for (const name of ['live', 'ready', 'deploy']) {
    const path = `/api/v1/platform/health/${name}`;
    assert.equal((await request(port, 'platform', path)).status, 200);
    assert.equal((await request(port, 'platform', `${path}?bypass=true`)).status, 401);
    assert.equal((await request(port, 'platform', path, {}, 'POST')).status, 401);
    assert.equal((await request(port, 'platform', path, { 'content-length': '1' })).status, 401);
  }
  for (let index = 0; index < 21; index += 1) assert.equal((await request(port, 'platform', '/')).status, 401);
  const limited = await request(port, 'platform', '/');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await request(port, 'platform', '/', { authorization: fixture.authorization })).status, 200);
  now += 60_000;
  assert.equal((await request(port, 'platform', '/')).status, 401);
});

test('real Demo server checks password before static/database access and preserves session, CSRF and closed traffic', async (t) => {
  const credential = credentials();
  const fixture = trafficFixture('platform', 'open');
  let gateConnections = 0;
  let openedFiles = 0;
  let principal = null;
  let observed;
  const trafficGate = createDemoTrafficGate({ ...fixture,
    settings: loadDemoTrafficGateConfig(fixture.env, { ...fixture, now: NOW }), clock: () => NOW });
  const server = createDemoPlatformHttpServer({
    config: { ...createDemoPlatformRuntimeConfig(fixture.config), staticRoot: 'fixture' },
    accessGate: createDemoPlatformAccessGate({ settings: credential.settings, publicOrigin: fixture.config.origins.platform }),
    trafficGate, persistence: { pool: {} },
    demoRuntimeGatePool: { async connect() {
      gateConnections += 1;
      return { async query() { return { rows: [] }; }, release() {} };
    } },
    staticFileAdapter: { async open() { openedFiles += 1; return { kind: 'file', size: 2 }; },
      async pipe(file, response) { response.end('ok'); } },
    routeModules: [platformSessionRoutes, platformHealthRoutes],
    platformHealthMonitor: createHealthMonitor({ readinessChecks: [async () => false] }),
    platformSessionService: { async resolvePrincipal(req) { observed = req; return principal; },
      verifyCsrf: async () => false, csrfTokenForPrincipal() {}, revoke() {}, clearCookie() {} },
    platformAuditService: { createUnmappedAuthenticationFailure() { return {}; }, createDeniedEvent() {}, async record() {} },
    logger: { requestCompleted() {}, securityOutcome() {}, unhandledError() {}, healthEvaluated() {} },
  });
  const port = await listen(t, server);
  assert.equal((await request(port, 'platform', '/')).status, 401);
  assert.equal((await request(port, 'platform', '/api/v1/platform/session')).status, 401);
  assert.equal((await request(port, 'platform', '/api/v1/platform/demo/reset', {}, 'POST')).status, 401);
  assert.equal(gateConnections, 0);
  assert.equal(openedFiles, 0);
  const authorized = { authorization: credential.authorization };
  assert.equal((await request(port, 'platform', '/', authorized)).status, 200);
  assert.equal(openedFiles, 1);
  const missingSession = await request(port, 'platform', '/api/v1/platform/session', authorized);
  assert.equal(missingSession.status, 401);
  assert.equal(missingSession.headers['www-authenticate'], undefined);
  assert.equal(observed.headers.authorization, undefined);
  assert.equal((await request(port, 'platform', '/api/v1/platform/health/deploy')).status, 503);
  principal = authenticatedPrincipal('platform');
  const missingCsrf = await request(port, 'platform', '/api/v1/platform/session', {
    ...authorized, origin: fixture.config.origins.platform,
  }, 'DELETE');
  assert.equal(missingCsrf.status, 403);
  assert.match(missingCsrf.body, /CSRF_INVALID/);
  trafficGate.close();
  assert.equal((await request(port, 'platform', '/', authorized)).status, 503);
});
