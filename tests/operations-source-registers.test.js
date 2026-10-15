import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeOperationsSource, operationsSourceDigest, compileOperationsSources,
  OPERATIONS_SOURCE_KEYS } from '../src/observability/operations-source-contract.js';
import { createOperationsSources, operationsSourcesEnabled } from '../src/demo/platform-operations-sources.js';
import { createOperationsSourceStorage } from '../src/demo/platform-operations-source-storage.js';
import { createOperationsSourceProjection } from '../src/demo/platform-operations-source-projection.js';
import { createDemoPlatformHttpServer } from '../src/demo/platform-server.js';
import { createDemoPlatformAccessGate } from '../src/demo/platform-access-gate.js';
import { createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { trafficFixture, listen, request } from './support/demo-traffic-gate-fixture.js';

const NOW = Date.parse('2026-10-15T13:00:00.000Z');
const fixture = JSON.parse(await readFile(new URL('./support/product-delivery-source-fixture.json', import.meta.url)));
const manual = () => ({ ...structuredClone(fixture), feedbackSource: 'not_configured', feedbackComplete: false, feedback: [] });
const feedback = () => ({ observedAt: fixture.observedAt, periodStart: fixture.periodStart, periodEnd: fixture.periodEnd,
  feedbackSource: 'protected_operator_registry', feedbackComplete: false, feedback: [] });
function envelope(kind, source) {
  return { schemaVersion: 1, environment: 'demo', kind, operatorId: 'owner', recordedAt: new Date(NOW).toISOString(), source };
}
const config = { endpoint: 'https://br-fixture.storage.c-5.eu-central-1.aws.neon.tech', region: 'eu-central-1',
  bucket: 'conference-manager-media', accessKeyId: 'fixture-reader', secretAccessKey: 'fixture-secret-not-a-real-key' };

test('register reads default off and require the existing validated private read-only storage boundary', () => {
  assert.equal(operationsSourcesEnabled({}, null), false);
  assert.equal(operationsSourcesEnabled({ DEMO_OPERATIONS_SOURCES_ENABLED: 'false' }, config), false);
  assert.equal(operationsSourcesEnabled({ DEMO_OPERATIONS_SOURCES_ENABLED: 'true' }, config), true);
  for (const env of [{ DEMO_OPERATIONS_SOURCES_ENABLED: 'yes' }, { DEMO_OPERATIONS_SOURCES_KEY: 'arbitrary' }]) {
    assert.throws(() => operationsSourcesEnabled(env, config));
  }
  assert.throws(() => operationsSourcesEnabled({ DEMO_OPERATIONS_SOURCES_ENABLED: 'true' }, null));
});

test('operator sources reuse closed compiler facts and reject KPI edits, identities, malformed clocks and oversized records', () => {
  const good = envelope('manual', manual());
  assert.equal(normalizeOperationsSource(good, 'manual', NOW).source.deployments.length, 1);
  assert.equal(operationsSourceDigest(good), operationsSourceDigest(Object.fromEntries(Object.entries(good).reverse())));
  for (const mutate of [
    (x) => { x.kpi = 0; }, (x) => { x.source.delivery = []; },
    (x) => { x.source.environment = 'production'; },
    (x) => { x.recordedAt = '2026-10-16T00:00:00.000Z'; },
    (x) => { x.recordedAt = '2026-09-01T00:00:00.000Z'; },
    (x) => { x.source.observedAt = '2026-10-15T14:00:00.000Z'; },
    (x) => { x.operatorId = 'person@example.invalid'; },
    (x) => { x.source.deployments[0].outcome = 'impaired'; },
    (x) => { x.source.productEvents = Array.from({ length: 2001 }, () => x.source.productEvents[0]); },
  ]) {
    const input = structuredClone(good); mutate(input);
    assert.throws(() => normalizeOperationsSource(input, 'manual', NOW));
  }
  const minimal = envelope('feedback', feedback());
  assert.equal(normalizeOperationsSource(minimal, 'feedback', NOW).source.feedbackComplete, false);
  for (const field of ['email', 'text', 'evidenceUrl', 'tenantId', 'payload']) {
    const bad = structuredClone(minimal);
    bad.source.feedback = [{ ...fixture.feedback[0], [field]: 'forbidden' }];
    assert.throws(() => normalizeOperationsSource(bad, 'feedback', NOW));
  }
  const tooMany = structuredClone(minimal);
  tooMany.source.feedback = Array.from({ length: 201 }, () => fixture.feedback[0]);
  assert.throws(() => normalizeOperationsSource(tooMany, 'feedback', NOW));
});

function memoryStorage() {
  const objects = new Map();
  return { objects,
    async read(kind) { return objects.get(kind) ?? null; },
    async write(kind, text, expected) {
      if ((objects.get(kind)?.version ?? null) !== expected) throw new Error('OPERATIONS_SOURCE_CONFLICT');
      const version = `"${createHash('md5').update(text).digest('hex')}"`;
      objects.set(kind, { text, version });
      return { version };
    },
  };
}

test('CAS preserves competing updates, rejects stale versions and makes identical submissions idempotent', async () => {
  let now = NOW;
  const storage = memoryStorage();
  const owner = createOperationsSources({ storage, operatorId: 'owner', clock: () => now });
  await assert.rejects(owner.write('feedback', { ...feedback(), feedbackComplete: true }, null), /NEW_REGISTER_INCOMPLETE/);
  const initial = await owner.write('feedback', feedback(), null);
  assert.equal(initial.duplicate, false);
  assert.equal((await owner.write('feedback', feedback(), null)).duplicate, true);
  const first = feedback(); first.feedback = structuredClone(fixture.feedback);
  const second = structuredClone(first); second.feedback[0].state = 'resolved';
  now += 1000;
  const outcomes = await Promise.allSettled([
    owner.write('feedback', first, initial.version), owner.write('feedback', second, initial.version),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected')[0].reason.message, 'OPERATIONS_SOURCE_CONFLICT');
  assert.equal((await owner.read('feedback')).envelope.source.feedback[0].state, 'open');
  now += 1000;
  await assert.rejects(owner.write('feedback', second, initial.version), /CONFLICT/);
  const before = storage.objects.get('feedback');
  const invalid = feedback(); invalid.feedback = [{ ...fixture.feedback[0], text: 'private' }];
  await assert.rejects(owner.write('feedback', invalid, before.version));
  assert.deepEqual(storage.objects.get('feedback'), before);
});

test('source read failures, rollback and malformed replacements retain last good clocks and expire honestly', async () => {
  let now = NOW;
  const storage = memoryStorage();
  const owner = createOperationsSources({ storage, operatorId: 'owner', clock: () => now });
  await owner.write('manual', manual(), null);
  const good = await owner.read('manual');
  const rollback = structuredClone(good.envelope);
  rollback.recordedAt = '2026-10-15T12:59:59.000Z';
  storage.objects.set('manual', { text: JSON.stringify(rollback), version: good.version });
  assert.equal((await owner.read('manual')).sourceState, 'last_good');
  const equivocation = structuredClone(good.envelope);
  equivocation.source.deployments[0].rework = true;
  storage.objects.set('manual', { text: JSON.stringify(equivocation), version: good.version });
  assert.equal((await owner.read('manual')).sourceState, 'last_good');
  storage.objects.set('manual', { text: '{"secret":"not-a-source"}', version: '"bad"' });
  now += 1000;
  const retained = await owner.read('manual');
  assert.equal(retained.sourceState, 'last_good');
  assert.equal(retained.digest, good.digest);
  assert.equal(retained.envelope.recordedAt, good.envelope.recordedAt);
  assert.ok(!JSON.stringify(retained).includes('not-a-source'));
  now = NOW + 30 * 86_400_000;
  await assert.rejects(owner.read('manual'));
  now = NOW;
  await assert.rejects(owner.read('manual'), /CLOCK_INVALID/);
});

test('manual enrichments never replace known automatic facts or erase complete inventories', () => {
  const auto = manual();
  auto.productEvents = []; auto.productComplete = false;
  auto.deployments[0].outcome = 'unknown'; auto.deployments[0].rework = null;
  auto.deployments[0].changes = [];
  const result = compileOperationsSources(auto, envelope('manual', manual()), envelope('feedback', feedback()), NOW);
  assert.throws(() => compileOperationsSources({ ...auto, environment: 'production' },
    envelope('manual', manual()), envelope('feedback', feedback()), NOW));
  assert.equal(result.snapshot.delivery[1].buckets[3].metrics[3].value, 0);
  assert.equal(result.snapshot.feedback.total, null);
  assert.equal(result.sources.length, 2);
  assert.equal(result.snapshot.observedAt, auto.observedAt);
  const contradictory = manual(); contradictory.deployments[0].artifactCommit = 'b'.repeat(40);
  assert.throws(() => compileOperationsSources(auto, envelope('manual', contradictory), null, NOW));
  const missing = manual(); missing.deployments = [];
  assert.throws(() => compileOperationsSources(auto, envelope('manual', missing), null, NOW));
  const newer = manual(); newer.deployments[0].rework = true;
  assert.throws(() => compileOperationsSources(newer, envelope('manual', manual()), null, NOW));
  const duplicateAuthority = structuredClone(fixture);
  assert.throws(() => compileOperationsSources(duplicateAuthority, null, envelope('feedback', feedback()), NOW));
});

test('storage is key confined, read-only by default, bounded and conditional for both creation and replacement', async () => {
  const commands = [];
  let fail = false;
  let response = { ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', ContentType: 'application/json', ContentLength: 2 };
  const storage = createOperationsSourceStorage(config, { writable: true, clientFactory: (options) => {
    assert.equal(options.maxAttempts, 1); assert.equal(options.followRegionRedirects, false);
    assert.equal(options.forcePathStyle, true);
    return { destroy() {}, async send(command) {
      commands.push(command);
      if (fail) throw { $metadata: { httpStatusCode: 412 }, message: 'private-provider-secret' };
      return { ...response, Body: Readable.from([Buffer.from('{}')]) };
    } };
  } });
  assert.equal((await storage.read('manual')).text, '{}');
  assert.equal(commands[0].input.Key, OPERATIONS_SOURCE_KEYS.manual);
  await storage.write('feedback', '{}', null);
  assert.equal(commands[1].input.IfNoneMatch, '*');
  await storage.write('feedback', '{}', '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
  assert.equal(commands[2].input.IfMatch, '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
  for (const kind of ['daily', '../media', 'operations/metrics/daily-v1.json', 'toString']) {
    await assert.rejects(storage.read(kind));
    await assert.rejects(storage.write(kind, '{}', null));
  }
  await assert.rejects(storage.write('manual', 'x'.repeat(256001), null));
  await assert.rejects(storage.write('manual', '{}', '*'));
  fail = true;
  await assert.rejects(storage.write('feedback', '{}', null), { message: 'OPERATIONS_SOURCE_CONFLICT' });
  fail = false;
  for (const mutate of [
    (value) => { value.ContentType = 'text/html'; }, (value) => { value.ContentLength = 256001; },
    (value) => { value.ContentLength = 3; }, (value) => { value.ETag = 'invalid'; },
  ]) {
    const previous = response; response = { ...previous }; mutate(response);
    await assert.rejects(storage.read('manual'), { message: 'OPERATIONS_SOURCE_UNAVAILABLE' });
    response = previous;
  }
  storage.close(); await assert.rejects(storage.read('manual'));
  const reader = createOperationsSourceStorage(config, { clientFactory: () => ({ destroy() {} }) });
  await assert.rejects(reader.write('feedback', '{}', null)); reader.close();
});

test('projection coalesces reads, emits only aggregates and keeps independent source clocks and unknown feedback', async () => {
  let now = NOW;
  let calls = 0;
  let fail = false;
  const storage = memoryStorage();
  const sources = createOperationsSources({ storage, operatorId: 'owner', clock: () => now });
  await sources.write('manual', manual(), null);
  await sources.write('feedback', feedback(), null);
  const projection = createOperationsSourceProjection({ clock: () => now, sources: { async read(kind) {
    calls += 1; if (fail) throw new Error('private-secret'); return sources.read(kind);
  } } });
  const reports = await Promise.all([projection.read(), projection.read(), projection.read()]);
  assert.equal(calls, 2);
  assert.equal(reports[0].sources[0].observedAt, fixture.observedAt);
  assert.equal(reports[0].sources[1].snapshot.feedback.total, null);
  assert.ok(!JSON.stringify(reports[0]).includes('tenantId'));
  assert.ok(!JSON.stringify(reports[0]).includes('operatorId'));
  now += 86_400_000;
  assert.equal((await projection.read()).sources[0].freshness, 'stale');
  fail = true; now += 300_000;
  const unavailable = await projection.read();
  assert.equal(unavailable.sources[0].snapshot, null);
  assert.equal(unavailable.sources[0].freshness, 'unknown');
  assert.ok(!JSON.stringify(unavailable).includes('private-secret'));
});

test('real HTTP gates precede reads and reject selectors, write methods and role spoofing', async (t) => {
  const password = randomBytes(32).toString('base64url');
  const settings = { mode: 'password', passwordHash: createHash('sha256')
    .update('conference-manager:demo-platform-access:v1:').update(password).digest('hex') };
  const headers = { authorization: `Basic ${Buffer.from(`ops:${password}`).toString('base64')}` };
  const context = trafficFixture('platform', 'open');
  let reads = 0; let closed = false; let fail = false;
  const server = createDemoPlatformHttpServer({ config: createDemoPlatformRuntimeConfig(context.config),
    persistence: { pool: {} }, demoRuntimeGatePool: { connect() { throw new Error('NO_SQL'); } },
    accessGate: createDemoPlatformAccessGate({ settings, publicOrigin: context.config.origins.platform }),
    trafficGate: { handle(req, res) { if (!closed) return false; res.statusCode = 503; res.end(); return true; } },
    operationsSources: { async read() {
      reads += 1; if (fail) throw new Error('private-secret'); return { schemaVersion: 1 };
    } },
    routeModules: [], platformSessionService: {
      resolvePrincipal() { throw new Error('NO_SESSION'); }, verifyCsrf() { throw new Error('NO_CSRF'); },
    },
    platformAuditService: { createDeniedEvent() {}, createUnmappedAuthenticationFailure() {}, async record() {} },
  });
  const port = await listen(t, server);
  const path = '/api/v1/platform/demo/operations-sources';
  assert.equal((await request(port, 'platform', path, { 'x-demo-role': 'platform_admin' })).status, 401);
  assert.equal(reads, 0);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await request(port, 'platform', path, headers, method)).status, 405);
  }
  assert.equal((await request(port, 'platform', `${path}?kind=feedback`, headers)).status, 400);
  assert.equal(reads, 0);
  const valid = await request(port, 'platform', path, headers);
  assert.equal(valid.status, 200); assert.equal(valid.headers['cache-control'], 'no-store');
  fail = true;
  const bad = await request(port, 'platform', path, headers);
  assert.equal(bad.status, 503); assert.ok(!bad.body.includes('private-secret'));
  closed = true;
  assert.equal((await request(port, 'platform', path, headers)).status, 503);
  assert.equal(reads, 2);
});

test('Operations storage cannot enter Customer, Production or transport composition, and has no reset/delete port', async () => {
  const { moduleBoundaryViolations } = await import('../scripts/check-module-boundaries.mjs');
  for (const file of ['src/demo/platform-server.js', 'src/demo/customer-main.js', 'src/platform-main.js']) {
    const violations = moduleBoundaryViolations({
      [file]: file.startsWith('src/demo/') ? "import './platform-operations-source-storage.js';"
        : "import './demo/platform-operations-source-storage.js';",
      'src/demo/platform-operations-source-storage.js': 'export const storage = true;',
    });
    assert.ok(violations.some((value) => value.includes('protected Operations storage')));
  }
  const source = await readFile(new URL('../src/demo/platform-operations-source-storage.js', import.meta.url), 'utf8');
  assert.ok(!/DeleteObject|ListObjects/.test(source));
  assert.ok(Object.values(OPERATIONS_SOURCE_KEYS).every((key) => key.startsWith('operations/')));
});

test('protected compiler CLI accepts normalized facts only and never echoes rejected private input', async () => {
  const { spawnSync } = await import('node:child_process');
  const invoke = (input, args = []) => spawnSync(process.execPath, ['scripts/compile-operations-sources.mjs', ...args], {
    input, encoding: 'utf8', timeout: 10_000,
  });
  const current = new Date();
  const end = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const source = { schemaVersion: 1, environment: 'demo', observedAt: current.toISOString(),
    periodStart: new Date(end - 28 * 86_400_000).toISOString(), periodEnd: new Date(end).toISOString(),
    productComplete: false, productEvents: [], deliveryComplete: { application: false, api: false, website: false },
    deployments: [], feedbackSource: 'not_configured', feedbackComplete: false, feedback: [] };
  const valid = invoke(JSON.stringify({ automatic: source, manual: null, feedback: null }));
  assert.equal(valid.status, 0); assert.equal(JSON.parse(valid.stdout).snapshot.feedback.total, null);
  for (const [input, args] of [['private-source-secret', []], [' '.repeat(768001), []],
    [JSON.stringify({ automatic: source, manual: null, feedback: null }), ['--url=https://untrusted.invalid']]]) {
    const result = invoke(input, args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'OPERATIONS_SOURCE_COMPILATION_FAILED\n');
  }
});
