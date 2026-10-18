import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { createLoadRuntimeBoundary } from '../scripts/support/target-load-boundary.mjs';
import { targetLoopbackResponse } from './support/target-load-http.js';

const RUN = 'abcde01234567890'; const NOW = 1_800_000_000_000; const TOKEN = 'a'.repeat(43);
function values(end = NOW + 60_000) {
  return { runId: RUN, releaseSha: 'b'.repeat(40), surface: 'customer',
    createdAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(end).toISOString(),
    databaseUrl: `postgresql://saas38_load_${RUN}_customer:synthetic-password@`
      + `ep-synthetic.c-5.eu-central-1.aws.neon.tech/saas38_load_${RUN}?sslmode=verify-full`,
    expectedDatabaseHost: 'ep-synthetic.c-5.eu-central-1.aws.neon.tech', observerToken: TOKEN,
    storageBucket: `saas38-load-${RUN}`, serviceName: `cm-saas38-load-${RUN}-customer` };
}
async function fixture(t, extra = {}) {
  const metrics = createMetricsRegistry(); let business = 0; let now = NOW;
  const boundary = createLoadRuntimeBoundary({ values: values(), metrics, clock: () => now,
    limits: { rateLimitMax: 120, rateLimitWindowMs: 60_000, databasePoolMax: 10 },
    resources: () => ({ cpu: { user: 11, system: 12 }, memory: { rss: 100, heapUsed: 20, heapTotal: 30, external: 5, arrayBuffers: 2 } }),
    ...extra });
  const server = http.createServer((_request, response) => { business += 1; response.end('business'); });
  t.after(async () => { boundary.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  boundary.install(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { boundary, metrics, server, origin: `http://127.0.0.1:${server.address().port}`,
    business: () => business, time: value => { now = value; },
    async request(path, options = {}) {
      const response = await targetLoopbackResponse(server, path, `cm-saas38-load-${RUN}-customer.onrender.com`, options);
      return { status: response.status, headers: { get: name => response.headers[name] },
        text: async () => response.body.toString('utf8') };
    } };
}

test('target observer is authenticated, aggregate-only and never falls through into business handlers', async t => {
  const fixtureValue = await fixture(t); const { metrics } = fixtureValue;
  metrics.recordAuthenticationFailure(); metrics.recordProjectionBatch({ refreshedCount: 3 });
  for (const headers of [{}, { Authorization: `Bearer ${'x'.repeat(43)}` }, { Cookie: `session=${TOKEN}` }]) {
    assert.equal((await fixtureValue.request('/__load/observe', { headers })).status, 404);
  }
  const headers = { Authorization: `Bearer ${TOKEN}` };
  for (const path of ['/__load/observe?secret=private', '/__load/observe/', '/__load/unknown']) {
    assert.equal((await fixtureValue.request(path, { headers })).status, 404);
  }
  assert.equal((await fixtureValue.request('/__load/observe', { method: 'POST', headers, body: 'private' })).status, 404);
  assert.equal(fixtureValue.business(), 0);
  const response = await fixtureValue.request('/__load/observe', { headers }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const raw = await response.text(); const body = JSON.parse(raw);
  assert.equal(body.metricTotals.authentication_failures_total, 1);
  assert.equal(body.metricTotals.platform_projection_batches_total, 1);
  assert.equal(body.metricTotals.platform_projection_outcomes_total, 3);
  assert.deepEqual(body.cpu, { userMicros: 11, systemMicros: 12 });
  assert.deepEqual(body.limits, { rateLimitMax: 120, rateLimitWindowMs: 60_000, databasePoolMax: 10 });
  assert.equal(body.memory.rss, 100); assert.equal(body.surface, 'customer');
  assert.doesNotMatch(raw, /synthetic-password|Bearer|session=|secret=|pg_|csrf|labels/);
  assert.ok(Buffer.byteLength(raw) <= 8192); assert.equal(fixtureValue.business(), 0);
  assert.equal(await (await fixtureValue.request('/api/v1/session')).text(), 'business');
  assert.equal(fixtureValue.business(), 1); assert.equal(fixtureValue.server.listeners('request').length, 1);
  assert.throws(() => fixtureValue.boundary.install(fixtureValue.server), /LOAD_RUNTIME_BOUNDARY_INVALID/);
});

test('expiry, backward clock and explicit close permanently stop observer and business admission', async t => {
  for (const state of ['expiry', 'backward', 'close']) {
    await t.test(state, async child => {
      const value = await fixture(child);
      if (state === 'expiry') value.time(NOW + 50_000);
      else if (state === 'backward') value.time(NOW - 1);
      else value.boundary.close();
      assert.equal((await value.request('/api/v1/session')).status, 503);
      value.time(NOW + 1);
      assert.equal((await value.request('/__load/observe', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 503);
      assert.equal(value.business(), 0);
    });
  }
});

test('absolute drain timer starts once and does not depend on later clock progression', async t => {
  let drained; const drain = new Promise(resolve => { drained = resolve; });
  const value = await fixture(t, { values: values(NOW + 10_025) });
  value.boundary.arm(drained);
  assert.throws(() => value.boundary.arm(drained), /LOAD_RUNTIME_BOUNDARY_INVALID/);
  await drain;
  assert.equal((await value.request('/api/v1/session')).status, 503);
  assert.equal(value.business(), 0);
});

test('invalid authority and malformed resource snapshots fail with fixed errors and no detail disclosure', async t => {
  assert.throws(() => createLoadRuntimeBoundary({ values: { ...values(), surface: 'setup' },
    metrics: createMetricsRegistry(), clock: () => NOW }), /^Error: LOAD_RUNTIME_BOUNDARY_INVALID$/);
  const value = await fixture(t, { resources: () => { throw new Error('private-database-material'); } });
  const response = await value.request('/__load/observe', { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 503); assert.equal(await response.text(), '');
  assert.equal(value.business(), 0);
});


test('observer projections discard source labels and reject unknown metric dimensions', async t => {
  for (const invalid of [false, true]) await t.test(String(invalid), async child => {
    const metrics = { snapshot: () => ({ counters: [{ metric: invalid ? 'private-unknown' : 'api_requests_total',
      value: 1, labels: { cookie: 'private-session-material', tenant: 'private-tenant' } }] }) };
    const value = await fixture(child, { metrics });
    const response = await value.request('/__load/observe', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, invalid ? 503 : 200); assert.doesNotMatch(await response.text(), /private|cookie|labels|tenant/);
    assert.equal(value.business(), 0);
  });
});

test('observer preserves canonical Host binding on both surfaces before returning authenticated aggregates', async t => {
  for (const surface of ['customer', 'platform']) await t.test(surface, async child => {
    const bound = { ...values(), surface, databaseUrl: values().databaseUrl.replace('_customer:', `_${surface}:`),
      serviceName: `cm-saas38-load-${RUN}-${surface}` };
    const value = await fixture(child, { values: bound }); const host = `${bound.serviceName}.onrender.com`;
    for (const incorrect of ['127.0.0.1', 'localhost', 'alias.invalid', `${host}:443`]) {
      const response = await targetLoopbackResponse(value.server, '/__load/observe', incorrect,
        { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 404); assert.equal(response.body.length, 0);
    }
    for (const rawHeaders of [[], ['Host', host, 'Host', host]]) {
      let status; let body;
      value.server.listeners('request')[0].call(value.server, { url: '/__load/observe', method: 'GET', rawHeaders,
        headers: { host, authorization: `Bearer ${TOKEN}` } },
      { setHeader() {}, writeHead(code) { status = code; }, end(bytes) { body = bytes; } });
      assert.equal(status, 404); assert.equal(body, '');
    }
    const response = await targetLoopbackResponse(value.server, '/__load/observe', host.toUpperCase(),
      { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).surface, surface);
    assert.equal(value.business(), 0);
  });
});
