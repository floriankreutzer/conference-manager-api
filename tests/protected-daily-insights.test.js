import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedDailyInsights } from '../src/observability/protected-daily-insights.js';
import { LIVE_METRICS } from '../src/observability/live-metrics-contract.js';
import { compileProductDeliveryReport } from '../src/observability/product-delivery-report.js';
import { loadProtectedDailyInsightConfig } from '../src/protected-platform-insight-config.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const DAY = 86400000;
function fixture() {
  const iso = new Date(NOW).toISOString();
  return { schemaVersion: 1, environment: 'demo', observedAt: iso,
    measurements: Object.keys(LIVE_METRICS).map(id => ({ id, value: id === 'tenants' ? 3 : null,
      observedAt: id === 'tenants' ? iso : null, periodStart: null, periodEnd: null, sampleAt: null })),
    providerSnapshot: null,
    productSnapshot: compileProductDeliveryReport({ schemaVersion: 1, environment: 'demo', observedAt: iso,
      periodStart: '2026-10-03T00:00:00.000Z', periodEnd: '2026-10-31T00:00:00.000Z',
      productComplete: false, productEvents: [], deliveryComplete: { application: false, api: true, website: false },
      deployments: [{ source: 'render', sourceId: 'synthetic-receipt', component: 'api', artifactCommit: 'a'.repeat(40),
        changes: [], deployedAt: '2026-10-30T12:00:00.000Z', outcome: 'unknown', failureAt: null, recoveredAt: null, rework: null }],
      feedbackSource: 'not_configured', feedbackComplete: false, feedback: [] }) };
}

test('protected daily reader admits global Delivery facts but excludes every seeded activity dimension and Demo authority', async () => {
  let calls = 0;
  const source = createProtectedDailyInsights({ accessMode: 'microsoft_mfa', clock: () => NOW,
    storage: { async read() { calls++;return JSON.stringify(fixture()); } } });
  assert.equal(calls, 0);
  const result = await source.read();
  assert.equal(result.measurements.length, 11);
  assert.ok(result.measurements.every(row => LIVE_METRICS[row.id][0] === 'providers'));
  assert.equal(result.providerUsage, null);
  assert.equal(result.productDelivery.environment, 'production');
  assert.equal(result.productDelivery.accessMode, 'microsoft_mfa');
  assert.ok(result.productDelivery.product.every(row => row.value === null));
  assert.equal(result.productDelivery.delivery[1].buckets[3].metrics[1].value, 1);
  assert.equal(result.productDelivery.delivery[0].buckets[3].metrics[1].value, null);
});

test('daily reads coalesce, load newer stored bytes after five minutes, and never rewrite original observation clocks', async () => {
  let now = NOW, calls = 0, release;
  const value = fixture();
  const source = createProtectedDailyInsights({ accessMode: 'application_passkey', clock: () => now,
    storage: { async read() { calls++;await new Promise(resolve => { release = resolve; });return JSON.stringify(value); } } });
  const first = source.read(), second = source.read();release();
  await Promise.all([first, second]);assert.equal(calls, 1);
  now += 299999;
  assert.equal((await source.read()).metadata.observedAt, value.observedAt);assert.equal(calls, 1);
  now++;value.observedAt = new Date(now).toISOString();
  const next = source.read();release();
  const result = await next;assert.equal(calls, 2);
  assert.equal(result.metadata.observedAt, value.observedAt);
  assert.equal(result.productDelivery.observedAt, new Date(NOW).toISOString());
});

test('failed, malformed, future and rollback uploads retain last good clocks; retry is bounded and expiry removes data', async () => {
  let now = NOW, calls = 0, raw = JSON.stringify(fixture());
  const source = createProtectedDailyInsights({ accessMode: 'microsoft_mfa', clock: () => now,
    storage: { async read() { calls++;if (raw === null) throw new Error('private upstream error');return raw; } } });
  await source.read();
  for (const next of [null, '{', JSON.stringify({ ...fixture(), observedAt: new Date(NOW + DAY).toISOString() }),
    JSON.stringify({ ...fixture(), observedAt: new Date(NOW - 1).toISOString() })]) {
    raw = next;now += 300000;
    const result = await source.read();
    assert.equal(result.metadata.sourceState, 'last_good');
    assert.equal(result.metadata.observedAt, new Date(NOW).toISOString());
    const count = calls;now += 59999;await source.read();assert.equal(calls, count);
  }
  now = NOW + DAY;raw = null;
  assert.equal((await source.read()).metadata.freshness, 'stale');
  now = NOW + 30 * DAY;assert.equal(await source.read(), null);
  now--;await assert.rejects(source.read());
});

test('closed source rejects identity fields, other environments and invented Product/feedback outcomes', async () => {
  for (const mutate of [
    x => { x.accountId = 'private'; }, x => { x.environment = 'production'; },
    x => { x.measurements[0].secret = 'private'; }, x => { x.measurements[0].value = 0; },
    x => { x.productSnapshot.product[0].value = 1;x.productSnapshot.product[0].reason = 'available'; },
    x => { x.productSnapshot.feedback.total = 0; }, x => { x.providerSnapshot = { token: 'private' }; },
  ]) {
    const input = fixture();mutate(input);
    const source = createProtectedDailyInsights({ accessMode: 'microsoft_mfa', clock: () => NOW,
      storage: { async read() { return JSON.stringify(input); } } });
    assert.equal(await source.read(), null);
  }
});

test('daily configuration requires separate credentials, exact existing database host, active INT and explicit enablement', () => {
  const host = 'ep-example-12345.c-5.eu-central-1.aws.neon.tech';
  const profile = { environment: 'int', database: {
    databaseUrl: `postgresql://cm_protected_int_platform:password@${host}/conference_manager_demo_shared` } };
  const options = { profile, assuranceMode: 'microsoft_mfa', forbiddenSecrets: ['a'.repeat(32)],
    values: ['true', 'br-example-12345', host, 'read-key-1234', 's'.repeat(32)] };
  assert.equal(loadProtectedDailyInsightConfig(options).bucket, 'conference-manager-media');
  assert.equal(loadProtectedDailyInsightConfig({ ...options, values: [undefined] }), null);
  for (const change of [
    { values: ['false', ...options.values.slice(1)] }, { values: ['yes', ...options.values.slice(1)] },
    { values: ['true', 'br-example-12345', 'evil.example', ...options.values.slice(3)] },
    { values: [...options.values.slice(0, 4), 'a'.repeat(32)] },
    { profile: { ...profile, environment: 'prod' } }, { assuranceMode: 'passkey_setup' },
  ]) assert.throws(() => loadProtectedDailyInsightConfig({ ...options, ...change }));
});
