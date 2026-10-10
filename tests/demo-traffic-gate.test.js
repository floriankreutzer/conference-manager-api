import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadDemoTrafficGateConfig } from '../src/demo/traffic-gate-config.js';
import { createDemoTrafficGate, DEMO_ACCEPTANCE_HEADER } from '../src/demo/traffic-gate.js';
import { createDemoCustomerHttpServer } from '../src/demo/customer-server.js';
import { createDemoPlatformHttpServer } from '../src/demo/platform-server.js';
import { createDemoCustomerRuntimeConfig, createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { createHealthMonitor } from '../src/observability/health.js';
import { platformHealthRoutes } from '../src/platform/http/health-routes.js';
import { platformSessionRoutes } from '../src/platform/http/session-routes.js';
import { trafficFixture, NOW, listen, request, authenticatedPrincipal } from './support/demo-traffic-gate-fixture.js';

function gate(fixture, clock = () => NOW) {
  return createDemoTrafficGate({ ...fixture, clock,
    settings: loadDemoTrafficGateConfig(fixture.env, { ...fixture, now: clock() }) });
}

for (const surface of ['customer', 'platform']) {
  test(`${surface} traffic configuration rejects unsafe or ambiguous acceptance settings`, () => {
    const fixture = trafficFixture(surface);
    const load = (overrides) => loadDemoTrafficGateConfig({ ...fixture.env, ...overrides }, { ...fixture, now: NOW });
    assert.equal(load({}).mode, 'acceptance');
    const key = `DEMO_${surface.toUpperCase()}_ACCEPTANCE_TOKEN`;
    for (const overrides of [
      { DEMO_TRAFFIC_MODE: 'opne' }, { DEMO_TRAFFIC_MODE: 'closed' },
      { [key]: 'short' }, { [key]: fixture.token.toUpperCase() },
      { DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT: '2026-10-10' },
      { DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT: new Date(NOW + 60 * 60_000 + 1).toISOString() },
      { DEMO_TRAFFIC_UNKNOWN: 'true' },
      { [`DEMO_${surface === 'customer' ? 'PLATFORM' : 'CUSTOMER'}_ACCEPTANCE_TOKEN`]: fixture.token },
    ]) assert.throws(() => load(overrides), /DEMO_TRAFFIC_/);
    assert.throws(() => loadDemoTrafficGateConfig(fixture.env, {
      ...fixture, now: NOW, config: { ...fixture.config, secrets: { aliased: fixture.token } },
    }), /SECRET_ALIAS_FORBIDDEN/);
    assert.equal(load({ DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT: new Date(NOW - 1).toISOString() }).mode, 'acceptance');
  });

  test(`${surface} closed gate blocks static, API, readiness and reset without calling application`, async (t) => {
    const fixture = trafficFixture(surface, 'closed');
    const trafficGate = gate(fixture);
    let calls = 0;
    const port = await listen(t, http.createServer((req, res) => {
      if (!trafficGate.handle(req, res)) { calls += 1; res.end('unexpected'); }
    }));
    const prefix = surface === 'customer' ? '/api/v1/' : '/api/v1/platform/';
    for (const path of ['/', '/assets/app.js', `${prefix}session`, `${prefix}health/ready`, `${prefix}demo/reset`]) {
      const result = await request(port, surface, path, {}, path.endsWith('/reset') ? 'POST' : 'GET');
      assert.equal(result.status, 503);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await request(port, surface, `${prefix}health/deploy`)).status, 200);
    assert.equal((await request(port, surface, `${prefix}health/live`)).status, 200);
    assert.equal((await request(port, surface, `${prefix}health/deploy?ready=1`)).status, 503);
    assert.equal((await request(port, surface, `${prefix}health/deploy`, {}, 'POST')).status, 503);
    assert.equal(calls, 0);
  });

  test(`${surface} acceptance strips credentials and preserves host, origin, path and expiry boundaries`, async (t) => {
    const fixture = trafficFixture(surface);
    let now = NOW;
    const trafficGate = gate(fixture, () => now);
    trafficGate.markActive();
    let calls = 0;
    const port = await listen(t, http.createServer((req, res) => {
      void req.headersDistinct;
      if (trafficGate.handle(req, res)) return;
      calls += 1;
      assert.equal(req.headers[DEMO_ACCEPTANCE_HEADER], undefined);
      assert.equal(req.headersDistinct[DEMO_ACCEPTANCE_HEADER], undefined);
      assert.ok(!req.rawHeaders.some((value) => value === fixture.token));
      assert.equal(req.headers.cookie, 'cm_session=untrusted');
      res.end('business-handler');
    }));
    const valid = { [DEMO_ACCEPTANCE_HEADER]: fixture.token, cookie: 'cm_session=untrusted' };
    assert.equal((await request(port, surface, '/', valid)).status, 200);
    for (const headers of [{}, { cookie: `cm_session=${fixture.token}` },
      { [DEMO_ACCEPTANCE_HEADER]: fixture.token.slice(0, 62) },
      { [DEMO_ACCEPTANCE_HEADER]: [fixture.token, fixture.token] }]) {
      assert.equal((await request(port, surface, '/', headers)).status, 503);
    }
    for (const [path, headers] of [['/', { ...valid, host: 'evil.invalid' }],
      ['/', { ...valid, origin: 'https://evil.invalid' }],
      ['/api/%2e%2e/private', valid], ['/'.padEnd(8_194, 'x'), valid]]) {
      assert.equal((await request(port, surface, path, headers)).status, 400);
    }
    now += 60_000;
    const prefix = surface === 'customer' ? '/api/v1/health/' : '/api/v1/platform/health/';
    assert.equal((await request(port, surface, '/', valid)).status, 503);
    assert.equal((await request(port, surface, `${prefix}deploy`)).status, 503);
    now = NOW;
    assert.equal((await request(port, surface, '/', valid)).status, 503);
    trafficGate.markQuiescent();
    const probe = await request(port, surface, `${prefix}deploy`);
    assert.equal(probe.status, 200);
    assert.equal(JSON.parse(probe.body).trafficMode, 'expired');
    assert.equal(calls, 1);
  });

  for (const mode of ['open', 'acceptance']) {
  test(`${surface} ${mode} real HTTP retains dependency readiness, authentication and CSRF`, async (t) => {
    const fixture = trafficFixture(surface, mode);
    let dependencyThrows = false;
    const readinessCheck = async () => { if (dependencyThrows) throw new Error('private dependency'); return false; };
    let gateConnections = 0;
    let observed;
    let principal = null;
    const resolvePrincipal = async (req) => { observed = req; return principal; };
    const options = {
      trafficGate: gate(fixture), persistence: { pool: {} },
      demoRuntimeGatePool: { async connect() {
        gateConnections += 1;
        return { async query() { return { rows: [] }; }, release() {} };
      } },
      logger: { requestCompleted() {}, securityOutcome() {}, unhandledError() {}, healthEvaluated() {} },
    };
    const server = surface === 'customer' ? createDemoCustomerHttpServer({ ...options,
      config: createDemoCustomerRuntimeConfig(fixture.config), resolvePrincipal, readinessChecks: [readinessCheck],
    }) : createDemoPlatformHttpServer({ ...options,
      config: createDemoPlatformRuntimeConfig(fixture.config), routeModules: [platformSessionRoutes, platformHealthRoutes],
      platformHealthMonitor: createHealthMonitor({ readinessChecks: [readinessCheck] }),
      platformSessionService: { resolvePrincipal, verifyCsrf: async () => false,
        csrfTokenForPrincipal() {}, revoke() {}, clearCookie() {} },
      platformAuditService: { createUnmappedAuthenticationFailure() { return {}; }, createDeniedEvent() {}, async record() {} },
    });
    const port = await listen(t, server);
    const prefix = surface === 'customer' ? '/api/v1/' : '/api/v1/platform/';
    if (mode === 'acceptance') {
      assert.equal((await request(port, surface, `${prefix}session`)).status, 503);
      assert.equal((await request(port, surface, `${prefix}demo/reset`, {}, 'POST')).status, 503);
      assert.equal(gateConnections, 0);
    }
    const dependencyProbe = await request(port, surface, `${prefix}health/deploy`);
    assert.equal(dependencyProbe.status, 503);
    assert.match(dependencyProbe.body, /not_ready/);
    assert.equal(gateConnections, 1);
    dependencyThrows = true;
    const throwingProbe = await request(port, surface, `${prefix}health/deploy`);
    assert.equal(throwingProbe.status, 503);
    assert.match(throwingProbe.body, /not_ready/);
    for (const [path, headers, method] of [
      [`${prefix}health/deploy`, { 'content-length': '1' }, 'GET'],
      [`${prefix}health/deploy`, {}, 'POST'], [`${prefix}health/deploy?probe=1`, {}, 'GET'],
    ]) assert.notEqual((await request(port, surface, path, headers, method)).status, 200);
    const beforeSession = gateConnections;
    const result = await request(port, surface, `${prefix}session`, { [DEMO_ACCEPTANCE_HEADER]: fixture.token });
    assert.equal(result.status, 401);
    assert.equal(gateConnections, beforeSession + 1);
    assert.equal(observed.headers[DEMO_ACCEPTANCE_HEADER], undefined);
    assert.ok(!result.body.includes(fixture.token));
    principal = authenticatedPrincipal(surface);
    const csrfResult = await request(port, surface, `${prefix}session`, {
      [DEMO_ACCEPTANCE_HEADER]: fixture.token, origin: fixture.config.origins[surface],
    }, 'DELETE');
    assert.equal(csrfResult.status, 403);
    assert.match(csrfResult.body, /CSRF_INVALID/);
  });
  }
}
