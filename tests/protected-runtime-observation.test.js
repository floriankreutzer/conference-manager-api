import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeRuntimeObservationPlan, normalizeRuntimeObservationSelection, PROTECTED_OBSERVATION_ORIGINS }
  from '../scripts/support/protected-runtime-observation-plan.mjs';
import { collectProtectedRuntimeObservation, readCollectedRuntimeObservation }
  from '../scripts/support/protected-runtime-observation-collector.mjs';
import { reconcileProtectedRuntimeObservation } from '../scripts/support/protected-runtime-observation-reconciler.mjs';
import { runtimeObservationFixture } from './support/runtime-observation-fixture.js';

test('observation selection rejects selectors, arbitrary destinations, credentials, malformed and inherited/accessor input', async t => {
  const f = await runtimeObservationFixture(t);
  assert.ok(Object.isFrozen(normalizeRuntimeObservationPlan(f.plan)));
  const { securityEpoch, ...selection } = f.plan;
  assert.equal(normalizeRuntimeObservationSelection(selection).environment, 'int');
  assert.throws(() => normalizeRuntimeObservationSelection(f.plan));
  for (const delta of [{ environment: 'prod' }, { securityEpoch: 'invalid' }, { apiCommit: 'main' },
    { frontendCommit: 'a'.repeat(41) }, { tenantId: securityEpoch }, { origin: 'https://foreign.example.test' },
    { evidence: { ...f.plan.evidence, runbook: 'https://foreign.example.test' } },
    { customer: { ...f.plan.customer, deploymentReference: 'dep-../foreign' } },
    { platform: { ...f.plan.customer } }]) {
    assert.throws(() => normalizeRuntimeObservationPlan({ ...f.plan, ...delta }), /OBSERVATION_REFUSED/);
  }
  const getter = { ...f.plan };Object.defineProperty(getter, 'apiCommit', { get() { assert.fail('NO_GETTER'); }, enumerable: true });
  assert.throws(() => normalizeRuntimeObservationPlan(getter));
  assert.throws(() => normalizeRuntimeObservationPlan(Object.create(f.plan)));
});

test('collector verifies sealed bytes, exact API builds and fixed-origin requests; optional evidence remains unknown', async t => {
  assert.deepEqual(PROTECTED_OBSERVATION_ORIGINS,{ customer: 'https://app.int.pavurel.eu',
    platform: 'https://platform.int.pavurel.eu' });
  const f = await runtimeObservationFixture(t);
  const receipt = await collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root, fetchImpl: f.fetchImpl });
  assert.deepEqual(receipt, {});assert.ok(Object.isFrozen(receipt));
  const observed = readCollectedRuntimeObservation(receipt);
  assert.deepEqual(observed.surfaces.map(row => row.optional), ['unknown', 'unknown']);
  assert.deepEqual(observed.surfaces.map(row => row.apiBuildId), [f.plan.apiCommit, f.plan.apiCommit]);
  assert.equal(f.calls.length, f.files.size + 2);
  for (const { url, options } of f.calls) {
    assert.ok(Object.values(PROTECTED_OBSERVATION_ORIGINS).includes(new URL(url).origin));
    assert.equal(options.method, 'GET');assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);assert.equal(options.body, undefined);
  }
  assert.throws(() => readCollectedRuntimeObservation(structuredClone(receipt)));
  await assert.rejects(() => reconcileProtectedRuntimeObservation({}, {}), /OBSERVATION_REFUSED/);
});

test('cold HTML, redirects, foreign URLs, stale builds and tampered bytes cannot yield a persistable receipt', async t => {
  const f = await runtimeObservationFixture(t);
  const modifications = [
    row => ({ ...row, bytes: Buffer.from('<html>cold start</html>'), type: 'text/html' }),
    row => ({ ...row, url: 'https://foreign.example.test/' }),
    row => ({ ...row, url: row.url.replace('https://app.int.pavurel.eu','https://conference-manager-demo.onrender.com')
      .replace('https://platform.int.pavurel.eu','https://conference-manager-ops-demo.onrender.com') }),
    row => ({ ...row, status: 302 }),
    row => row.type.startsWith('application/json') ? { ...row, bytes: Buffer.from('{}') } : row,
    row => row.type.startsWith('application/json') ? { ...row,
      bytes: Buffer.from(row.bytes.toString().replace('{', '{"foreignSource":"injected",')) } : row,
    row => row.type.startsWith('application/json') ? { ...row,
      bytes: Buffer.from(row.bytes.toString().replaceAll(f.plan.apiCommit, 'c'.repeat(40))) } : row,
    row => ({ ...row, bytes: Buffer.concat([row.bytes, Buffer.from('tampered')]) }),
  ];
  for (const transform of modifications) {
    f.transform(transform);
    await assert.rejects(() => collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root,
      fetchImpl: f.fetchImpl }), /OBSERVATION_REFUSED/);
  }
});

test('elapsed real request cancellation aborts every outstanding source and emits no receipt', async t => {
  const f = await runtimeObservationFixture(t);const signals = [];
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);signal.addEventListener('abort', () => reject(new Error('PRIVATE_PROVIDER_FAILURE')), { once: true });
  });
  await assert.rejects(() => collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root,
    fetchImpl, timeoutMs: 1000 }), /OBSERVATION_REFUSED/);
  assert.ok(signals.length > 0);assert.ok(signals.every(signal => signal.aborted));
});

test('known not-ready health is retained as not-ready, not refreshed into success or optional healthy', async t => {
  const f = await runtimeObservationFixture(t);
  f.transform(row => row.type.startsWith('application/json') ? { ...row, status: 503,
    bytes: Buffer.from(row.bytes.toString().replace('"ready"', '"not_ready"')) } : row);
  const receipt = await collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root, fetchImpl: f.fetchImpl });
  assert.deepEqual(readCollectedRuntimeObservation(receipt).surfaces.map(row => row.required), ['not_ready', 'not_ready']);
  await assert.rejects(() => reconcileProtectedRuntimeObservation({}, receipt,
    { expectedOfflineRole: 'cm_protected_int_platform' }), /OBSERVATION_REFUSED/);
});

test('collector rejects future selection and elapsed collection rather than manufacturing a fresh observation clock', async t => {
  const f = await runtimeObservationFixture(t);
  await assert.rejects(() => collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root,
    fetchImpl: f.fetchImpl, clock: () => Date.parse('2026-01-01T00:00:00.000Z') }));
  let count = 0;
  await assert.rejects(() => collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root,
    fetchImpl: f.fetchImpl, clock: () => Date.now() + (count++ === 0 ? 0 : 120000) }), /OBSERVATION_REFUSED/);
});

test('operator workflow binds exact owner/Main/first attempt, has no schedule and allocates credentials after builds', async () => {
  const workflow = await readFile('.github/workflows/protected-int-runtime-observation.yml', 'utf8');
  assert.match(workflow, /inputs.expected_main_sha == github.sha/);
  assert.match(workflow, /github.run_attempt == 1/);
  assert.match(workflow, /github.actor == 'floriankreutzer'/);
  assert.doesNotMatch(workflow, /schedule:|cron:|pull_request_target:|contents: write/);
  assert.equal((workflow.match(/CM_INT_AUDIT_OFFLINE_DATABASE_URL/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /CM_INT_AUDIT_HMAC_SECRET|CM_INT_AUDIT_REQUEST_JSON/);
  assert.match(workflow, /3<<<"\$SELECTION_JSON"/);
  assert.match(workflow, /redirect|Collect actual fixed-origin/);
  const cli = await readFile('scripts/protected-runtime-observe.mjs', 'utf8');
  assert.match(cli, /selection.apiCommit !== process.env.GITHUB_SHA/);
  assert.doesNotMatch(cli, /rejectUnauthorized: false|console\.log|error\.message|error\.stack/);
});
