import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { loadDemoProviderUsage } from '../src/demo/platform-provider-usage.js';
import { createDemoPlatformAccessGate } from '../src/demo/platform-access-gate.js';
import { handleDemoProviderUsage, DEMO_PROVIDER_USAGE_PATH } from '../src/demo/http/platform-provider-usage-handler.js';
import { createDemoPlatformHttpServer } from '../src/demo/platform-server.js';
import { createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { trafficFixture, listen, request } from './support/demo-traffic-gate-fixture.js';

function snapshot(used = 260_000_000_000) {
  return { schemaVersion: 1, plan: 'launch_v3', referenceObservedAt: '2026-10-01T00:00:00.000Z',
    finops: { schemaVersion: 1, current: { schemaVersion: 1,
      periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
      observedAt: '2026-10-15T00:00:00.000Z',
      measurements: [{ source: 'database_transfer', unit: 'bytes', used, limit: 500_000_000_000 }] },
    history: [], rates: [] } };
}

function credential() {
  const password = randomBytes(32).toString('base64url');
  return { authorization: `Basic ${Buffer.from(`ops:${password}`).toString('base64')}`,
    settings: { mode: 'password', passwordHash: createHash('sha256')
      .update('conference-manager:demo-platform-access:v1:').update(password).digest('hex') } };
}

test('private provider configuration is default-off, bounded and requires the password perimeter', () => {
  assert.equal(loadDemoProviderUsage({}, { mode: 'public' }), null);
  const valid = snapshot();
  for (const [value, mode] of [[valid, 'public'], [{ ...valid, ownerEmail: 'private@example.invalid' }, 'password'],
    [{ ...valid, plan: 'unknown' }, 'password'], [{ ...valid, referenceObservedAt: 'bad' }, 'password'],
    [{ ...valid, finops: { ...valid.finops, rates: [{}] } }, 'password']]) {
    assert.throws(() => loadDemoProviderUsage({ DEMO_PROVIDER_USAGE_SNAPSHOT: JSON.stringify(value) }, { mode }));
  }
  for (const env of [{ DEMO_PROVIDER_USAGE_SNAPSHOT: [] }, { DEMO_PROVIDER_USAGE_SNAPSHOT: 'x'.repeat(24_001) },
    { DEMO_PROVIDER_USAGE_SNAPSHOT: '{' }, { DEMO_PROVIDER_USAGE_TOKEN: 'unused' }]) {
    assert.throws(() => loadDemoProviderUsage(env, { mode: 'password' }));
  }
});

test('report reuses transfer-budget policy, retains unknowns and ages without inventing live collection', () => {
  const usage = loadDemoProviderUsage({ DEMO_PROVIDER_USAGE_SNAPSHOT: JSON.stringify(snapshot()) }, { mode: 'password' });
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  const report = usage.read(now);
  assert.equal(report.neon.utilizationPercent, 52);
  assert.deepEqual(report.neon.crossedThresholds, [50]);
  assert.equal(report.neon.projectedExhaustion, true);
  assert.equal(report.neon.anomalyState, 'insufficient_baseline');
  assert.equal(report.render.usageState, 'unknown_monthly_usage');
  assert.equal(report.github.usageState, 'unknown_billing_usage');
  assert.equal(report.costState, 'unknown');
  assert.equal(report.alertDelivery, 'not_configured');
  assert.equal(report.freshness, 'fresh');
  assert.equal(usage.read(now + 86_400_000).freshness, 'stale');
  assert.throws(() => usage.read(Date.parse('2026-10-14T00:00:00.000Z')));
});

test('private-read capability cannot be forged, inherited from health or granted by public/demo-role headers', async (t) => {
  const c = credential();
  const usage = loadDemoProviderUsage({ DEMO_PROVIDER_USAGE_SNAPSHOT: JSON.stringify(snapshot()) }, c.settings);
  const gate = createDemoPlatformAccessGate({ settings: c.settings, publicOrigin: 'https://platform.demo.invalid' });
  const port = await listen(t, http.createServer((req, res) => {
    if (gate.handle(req, res)) return;
    if (req.url === '/api/v1/platform/health/live') assert.equal(gate.hasPrivateReadAccess(req), false);
    if (!handleDemoProviderUsage({ request: req, response: res, accessGate: gate,
      providerUsage: { read: () => usage.read(Date.parse('2026-10-15T12:00:00.000Z')) } })) res.end('health');
  }));
  const forged = await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH, { 'x-demo-role': 'platform_security_admin' });
  assert.equal(forged.status, 401);
  assert.equal((await request(port, 'platform', '/api/v1/platform/health/live')).status, 200);
  assert.equal(gate.hasPrivateReadAccess({ headers: { authorization: c.authorization } }), false);
  const ok = await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH, { authorization: c.authorization });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(ok.body).neon.usedBytes, 260_000_000_000);
  const queried = await request(port, 'platform', `${DEMO_PROVIDER_USAGE_PATH}?tenant=other`, { authorization: c.authorization });
  assert.equal(queried.status, 400);
  const body = await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH, { authorization: c.authorization, 'content-length': '1' });
  assert.equal(body.status, 400);
  assert.equal((await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH, { authorization: c.authorization }, 'POST')).status, 405);
  const publicGate = createDemoPlatformAccessGate({ settings: { mode: 'public', passwordHash: null },
    publicOrigin: 'https://platform.demo.invalid' });
  const publicPort = await listen(t, http.createServer((req, res) => {
    publicGate.handle(req, res);
    handleDemoProviderUsage({ request: req, response: res, accessGate: publicGate, providerUsage: usage });
  }));
  assert.equal((await request(publicPort, 'platform', DEMO_PROVIDER_USAGE_PATH, { authorization: c.authorization })).status, 404);
});

test('real Demo provider route runs after both gates and never reads tenant persistence', async (t) => {
  const c = credential();
  const fixture = trafficFixture('platform', 'open');
  let closed = false;
  let reads = 0;
  const server = createDemoPlatformHttpServer({ config: createDemoPlatformRuntimeConfig(fixture.config),
    persistence: { pool: {} }, demoRuntimeGatePool: { async connect() { throw new Error('UNEXPECTED_DATABASE_READ'); } },
    accessGate: createDemoPlatformAccessGate({ settings: c.settings, publicOrigin: fixture.config.origins.platform }),
    trafficGate: { handle(req, res) { if (!closed) return false; res.statusCode = 503; res.end('closed'); return true; } },
    providerUsage: { read() { reads += 1; return { private: 'bounded-test' }; } }, routeModules: [],
    platformSessionService: { async resolvePrincipal() { throw new Error('UNEXPECTED_SESSION_READ'); },
      async verifyCsrf() { throw new Error('UNEXPECTED_CSRF_READ'); } },
    platformAuditService: { createDeniedEvent() {}, createUnmappedAuthenticationFailure() {}, async record() {} },
  });
  const port = await listen(t, server);
  assert.equal((await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH)).status, 401);
  assert.equal(reads, 0);
  assert.equal((await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH, { authorization: c.authorization })).status, 200);
  assert.equal(reads, 1);
  closed = true;
  assert.equal((await request(port, 'platform', DEMO_PROVIDER_USAGE_PATH, { authorization: c.authorization })).status, 503);
  assert.equal(reads, 1);
});
