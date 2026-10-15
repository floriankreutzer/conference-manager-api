import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LIVE_METRICS, normalizeLiveMeasurements } from '../src/observability/live-metrics-contract.js';
import { compileProductDeliveryReport } from '../src/observability/product-delivery-report.js';
import { createDailyLiveMetrics, normalizeDailyLiveSnapshot } from '../src/demo/platform-live-metrics.js';
import { createLiveMetricsStorage, LIVE_METRICS_OBJECT_KEY } from '../src/demo/platform-live-storage.js';
import { createDemoPlatformHttpServer } from '../src/demo/platform-server.js';
import { createDemoPlatformAccessGate } from '../src/demo/platform-access-gate.js';
import { createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { trafficFixture, listen, request } from './support/demo-traffic-gate-fixture.js';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();

export function dailyFixture() {
  return {
    schemaVersion: 1, environment: 'demo', observedAt: ISO,
    measurements: Object.keys(LIVE_METRICS).map((id) => ({ id, value: null,
      observedAt: null, periodStart: null, periodEnd: null, sampleAt: null })),
    providerSnapshot: null,
    productSnapshot: compileProductDeliveryReport({
      schemaVersion: 1, environment: 'demo', observedAt: ISO,
      periodStart: '2026-09-17T00:00:00.000Z', periodEnd: '2026-10-15T00:00:00.000Z',
      productComplete: false, productEvents: [], deliveryComplete: { application: false, api: true, website: false },
      deployments: [{ source: 'render', sourceId: 'synthetic-deploy', component: 'api',
        artifactCommit: 'a'.repeat(40), changes: [], deployedAt: '2026-10-14T12:00:00.000Z',
        outcome: 'unknown', failureAt: null, recoveredAt: null, rework: null }],
      feedbackSource: 'not_configured', feedbackComplete: false, feedback: [],
    }),
  };
}

test('closed daily measurements reject identity leakage, forged clocks, wrong dimensions and invented zero', () => {
  const source = dailyFixture();
  const normal = normalizeDailyLiveSnapshot(source);
  assert.equal(normal.product.read(NOW).delivery[1].buckets[3].metrics[1].value, 1);
  assert.ok(normal.product.read(NOW).product.every((row) => row.value === null));
  assert.equal(normal.measurements[0].value, null);
  for (const mutate of [
    (x) => { x.tenantId = 'private'; },
    (x) => { x.environment = 'production'; },
    (x) => { x.measurements[0].accountId = 'private'; },
    (x) => { x.measurements[0].id = 'custom_metric'; },
    (x) => { x.measurements.pop(); },
    (x) => { x.measurements[0].value = 0; },
    (x) => { x.productSnapshot.provenance.mode = 'not_collected'; },
  ]) {
    const input = structuredClone(source); mutate(input);
    assert.throws(() => normalizeDailyLiveSnapshot(input));
  }
  const rows = structuredClone(source.measurements);
  Object.assign(rows.find((row) => row.id === 'requests'), {
    value: 21, observedAt: ISO,
  });
  assert.equal(normalizeLiveMeasurements(rows, ISO).find((row) => row.id === 'requests').value, 21);
  rows.find((row) => row.id === 'requests').observedAt = '2026-10-16T00:00:00.000Z';
  assert.throws(() => normalizeLiveMeasurements(rows, ISO));
});

test('daily reader coalesces refreshes, preserves original clocks on failure and expires after thirty days', async () => {
  let now = NOW; let reads = 0; let fail = false;
  const source = dailyFixture();
  const metrics = createDailyLiveMetrics({ clock: () => now, storage: { async read() {
    reads += 1;
    if (fail) throw new Error('private-provider-payload');
    return JSON.stringify(source);
  } } });
  const values = await Promise.all(Array.from({ length: 8 }, () => metrics.read()));
  assert.equal(reads, 1);
  assert.ok(values.every((x) => x.observedAt === ISO && x.sourceState === 'available'));
  now += 300_000; fail = true;
  const old = await metrics.read();
  assert.equal(old.observedAt, ISO);
  assert.equal(old.sourceState, 'last_good');
  await metrics.read(); assert.equal(reads, 2);
  now = NOW + 86_400_000;
  assert.equal((await metrics.read()).freshness, 'stale');
  now = NOW + 30 * 86_400_000;
  await assert.rejects(metrics.read(), /LIVE_METRICS_UNAVAILABLE/);
  assert.ok(!JSON.stringify(old).includes('private-provider-payload'));
  const future = dailyFixture(); future.observedAt = '2026-10-16T00:00:00.000Z';
  await assert.rejects(createDailyLiveMetrics({ clock: () => NOW,
    storage: { read: async () => JSON.stringify(future) } }).read(), /UNAVAILABLE/);
});

test('fixed private S3 reader restricts key, endpoint, size, MIME, encoding and lifecycle', async () => {
  const config = { endpoint: 'https://br-fixture.storage.c-5.eu-central-1.aws.neon.tech',
    region: 'eu-central-1', bucket: 'conference-manager-media', accessKeyId: 'fixture-reader',
    secretAccessKey: 'synthetic-test-credential-value' };
  let response = { ContentType: 'application/json', ContentLength: 2, Body: Readable.from([Buffer.from('{}')]) };
  let calls = 0; let destroyed = 0;
  const storage = createLiveMetricsStorage(config, { clientFactory(options) {
    assert.equal(options.maxAttempts, 1); assert.equal(options.followRegionRedirects, false);
    return { async send(command) {
      calls += 1;
      assert.equal(command.constructor.name, 'GetObjectCommand');
      assert.equal(command.input.Key, LIVE_METRICS_OBJECT_KEY);
      assert.equal(command.input.Bucket, 'conference-manager-media');
      return response;
    }, destroy() { destroyed += 1; } };
  } });
  assert.equal(await storage.read(), '{}');
  for (const override of [{ ContentLength: 48_001 }, { ContentType: 'text/html' },
    { ContentLength: 1 }, { ContentLength: 2, Body: Readable.from([Buffer.from([0xff, 0xff])]) }]) {
    response = { ContentType: 'application/json', ContentLength: 2,
      Body: Readable.from([Buffer.from('{}')]), ...override };
    await assert.rejects(storage.read(), /LIVE_METRICS_STORAGE_UNAVAILABLE/);
  }
  storage.close(); await assert.rejects(storage.read());
  assert.equal(destroyed, 1); assert.equal(calls, 5);
  assert.throws(() => createLiveMetricsStorage({ ...config, endpoint: 'http://127.0.0.1' }));
  assert.throws(() => createLiveMetricsStorage({ ...config, bucket: 'other-bucket' }));
});

test('real private HTTP route checks owner and traffic before asynchronous storage, with bounded failures', async (t) => {
  const password = randomBytes(32).toString('base64url');
  const settings = { mode: 'password', passwordHash: createHash('sha256')
    .update('conference-manager:demo-platform-access:v1:').update(password).digest('hex') };
  const headers = { authorization: `Basic ${Buffer.from(`ops:${password}`).toString('base64')}` };
  const fixture = trafficFixture('platform', 'open');
  let reads = 0; let closed = false; let fail = false;
  const server = createDemoPlatformHttpServer({ config: createDemoPlatformRuntimeConfig(fixture.config),
    persistence: { pool: {} }, demoRuntimeGatePool: { connect() { throw new Error('NO_SQL'); } },
    accessGate: createDemoPlatformAccessGate({ settings, publicOrigin: fixture.config.origins.platform }),
    trafficGate: { handle(req, res) { if (!closed) return false; res.statusCode = 503; res.end(); return true; } },
    liveMetrics: { async read() { reads += 1; if (fail) throw new Error('secret-payload'); return { schemaVersion: 1 }; } },
    routeModules: [], platformSessionService: {
      resolvePrincipal() { throw new Error('NO_SESSION_READ'); },
      verifyCsrf() { throw new Error('NO_CSRF_READ'); },
    },
    platformAuditService: { createDeniedEvent() {}, createUnmappedAuthenticationFailure() {}, async record() {} },
  });
  const port = await listen(t, server);
  const path = '/api/v1/platform/demo/live-metrics';
  assert.equal((await request(port, 'platform', path, { 'x-demo-role': 'platform_security_admin' })).status, 401);
  assert.equal(reads, 0);
  assert.equal((await request(port, 'platform', path + '?tenant=foreign', headers)).status, 400);
  assert.equal((await request(port, 'platform', path, headers, 'POST')).status, 405);
  assert.equal(reads, 0);
  const result = await request(port, 'platform', path, headers);
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  fail = true;
  const bad = await request(port, 'platform', path, headers);
  assert.equal(bad.status, 503); assert.ok(!bad.body.includes('secret-payload'));
  closed = true;
  assert.equal((await request(port, 'platform', path, headers)).status, 503);
  assert.equal(reads, 2);
});

test('source windows retain a missing provider start and require actual hourly sample timestamps', () => {
  const input = dailyFixture();
  const row = input.measurements.find((x) => x.id === 'resend_monthly_sent');
  Object.assign(row, { value: 2, observedAt: ISO, periodEnd: '2026-11-14T12:00:00.000Z' });
  assert.equal(normalizeDailyLiveSnapshot(input).measurements.find((x) => x.id === row.id).periodStart, null);
  row.periodEnd = ISO; assert.throws(() => normalizeDailyLiveSnapshot(input));
  const render = dailyFixture();
  Object.assign(render.measurements[1], { value: 0.5, observedAt: ISO,
    periodStart: '2026-10-14T12:00:00.000Z', periodEnd: ISO });
  assert.throws(() => normalizeDailyLiveSnapshot(render));
  render.measurements[1].sampleAt = '2026-10-15T11:00:00.000Z';
  assert.equal(normalizeDailyLiveSnapshot(render).measurements[1].value, 0.5);
});

test('clock rollback during an asynchronous read fails closed', async () => {
  let now = NOW;
  const source = createDailyLiveMetrics({ clock: () => now, storage: { async read() {
    now -= 1; return JSON.stringify(dailyFixture());
  } } });
  await assert.rejects(source.read(), /LIVE_METRICS_CLOCK_INVALID/);
});

test('daily compiler is bounded, refuses arguments and never echoes malformed private input', async () => {
  const { spawnSync } = await import('node:child_process');
  const input = dailyFixture(); input.observedAt = new Date().toISOString();
  const invoke = (value, args = []) => spawnSync(process.execPath, ['scripts/compile-daily-live-metrics.mjs', ...args], {
    input: value, encoding: 'utf8', timeout: 10_000,
  });
  const valid = invoke(JSON.stringify(input));
  assert.equal(valid.status, 0); assert.deepEqual(JSON.parse(valid.stdout), input);
  for (const [value, args] of [['private-source-token', []], [' '.repeat(48_001), []],
    [JSON.stringify(input), ['--url=https://untrusted.invalid']],
    [JSON.stringify({ ...input, observedAt: new Date(Date.now() + 86_400_000).toISOString() }), []]]) {
    const result = invoke(value, args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'DAILY_LIVE_METRICS_COMPILATION_FAILED\n');
  }
});

test('concrete private reader stays exclusively in the Demo Operations composition root', async () => {
  const { moduleBoundaryViolations } = await import('../scripts/check-module-boundaries.mjs');
  for (const file of ['src/demo/platform-server.js', 'src/demo/customer-main.js', 'src/platform-main.js']) {
    const violations = moduleBoundaryViolations({
      [file]: file.startsWith('src/demo/') ? "import './platform-live-storage.js';"
        : "import './demo/platform-live-storage.js';",
      'src/demo/platform-live-storage.js': 'export const storage = true;',
    });
    assert.ok(violations.some((x) => x.includes('live-metrics storage')));
  }
});

test('independent metrics configuration preserves PostgreSQL media and rejects unsafe owner/branch/secret settings', async () => {
  const { loadDailyLiveStorageConfig } = await import('../src/demo/platform-live-config.js');
  const { demoMediaStorageEnvironment, demoMediaStorageConfig } = await import('./support/demo-media-storage-environment.js');
  const env = demoMediaStorageEnvironment('platform', 'postgres');
  const config = demoMediaStorageConfig(env, 'platform');
  assert.equal(loadDailyLiveStorageConfig(env, { config, access: { mode: 'password' } }), null);
  const enabled = { ...env, DEMO_LIVE_METRICS_ENABLED: 'true', DEMO_LIVE_METRICS_BRANCH_ID: 'br-demo-media-test',
    DEMO_LIVE_METRICS_ACCESS_KEY_ID: 'synthetic-metrics-reader',
    DEMO_LIVE_METRICS_SECRET_ACCESS_KEY: 'synthetic-metrics-reader-secret' };
  const before = JSON.stringify(enabled);
  assert.equal(loadDailyLiveStorageConfig(enabled, { config, access: { mode: 'password' } }).bucket, 'conference-manager-media');
  assert.equal(JSON.stringify(enabled), before);
  assert.equal(enabled.DEMO_MEDIA_STORAGE, 'postgres');
  assert.throws(() => loadDailyLiveStorageConfig(enabled, { config, access: { mode: 'public' } }));
  for (const change of [{ DEMO_LIVE_METRICS_ENABLED: 'false' }, { DEMO_LIVE_METRICS_BRANCH_ID: '../other' },
    { DEMO_LIVE_METRICS_ENDPOINT: 'https://untrusted.invalid' }, { DEMO_LIVE_METRICS_ENABLED: 'yes' },
    { DEMO_LIVE_METRICS_SECRET_ACCESS_KEY: config.secrets.session }]) {
    assert.throws(() => loadDailyLiveStorageConfig({ ...enabled, ...change }, { config, access: { mode: 'password' } }));
  }
});
