import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { normalizeRuntimeObservationSelection, normalizeRuntimeObservationPlan,
  normalizeRuntimeVerificationSelection, PROTECTED_OBSERVATION_ORIGINS, OBSERVATION_FRONTEND_COMMIT }
  from '../scripts/support/protected-runtime-observation-plan.mjs';
import { collectProtectedRuntimeObservation, readCollectedRuntimeObservation, verifyProtectedRuntimeArtifacts }
  from '../scripts/support/protected-runtime-observation-collector.mjs';
import { runtimeObservationFixture } from './support/runtime-observation-fixture.js';
import { frontendArtifactDigest } from './support/protected-frontend-artifact-fixture.js';

function selectionOf(plan) {
  const { securityEpoch: _securityEpoch, ...selection } = plan;
  return selection;
}

async function verificationFixture(t) {
  const f = await runtimeObservationFixture(t);
  const selection = { ...selectionOf(f.plan), frontendCommit: 'b'.repeat(40) };
  for (const surface of ['customer', 'platform']) {
    const file = path.join(f.root, surface, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.frontendCommit = selection.frontendCommit;
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(file, bytes);
    selection[surface] = { ...selection[surface], frontendSha256: frontendArtifactDigest(bytes) };
  }
  return { ...f, selection };
}

const verify = f => verifyProtectedRuntimeArtifacts({ selection: f.selection,
  artifactRoot: f.root, fetchImpl: f.fetchImpl });

test('read-only verification accepts independently pinned artifacts without changing the observer allowlist', async t => {
  const f = await verificationFixture(t);
  const before = JSON.stringify(f.selection);
  assert.equal(OBSERVATION_FRONTEND_COMMIT, '28a864ea6b1d4f5ae0e0066a072f6012e059358d');
  assert.throws(() => normalizeRuntimeObservationSelection(f.selection), /OBSERVATION_REFUSED/);
  assert.throws(() => normalizeRuntimeObservationPlan({ ...f.selection, securityEpoch: f.plan.securityEpoch }), /OBSERVATION_REFUSED/);
  const report = await verify(f);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verificationOnly, true);
  assert.equal(report.selection.frontendCommit, f.selection.frontendCommit);
  assert.equal(Object.hasOwn(report.selection, 'securityEpoch'), false);
  assert.deepEqual(report.surfaces.map(row => row.optional), ['unknown', 'unknown']);
  assert.deepEqual(report.surfaces.map(row => row.required), ['ready', 'ready']);
  assert.equal(f.calls.length, f.files.size + 2);
  assert.equal(JSON.stringify(f.selection), before);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.selection));
  assert.ok(Object.isFrozen(report.surfaces));
  assert.ok(report.surfaces.every(Object.isFrozen));
  assert.throws(() => readCollectedRuntimeObservation(report), /OBSERVATION_REFUSED/);
  assert.throws(() => readCollectedRuntimeObservation(structuredClone(report)), /OBSERVATION_REFUSED/);
});

test('the original epoch-bound collector still creates its own private same-process receipt', async t => {
  const f = await runtimeObservationFixture(t);
  const receipt = await collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root, fetchImpl: f.fetchImpl });
  assert.deepEqual(receipt, {});
  const result = readCollectedRuntimeObservation(receipt);
  assert.equal(result.plan.securityEpoch, f.plan.securityEpoch);
  assert.equal(result.plan.frontendCommit, OBSERVATION_FRONTEND_COMMIT);
  assert.deepEqual(result.surfaces.map(row => row.optional), ['unknown', 'unknown']);
  assert.throws(() => readCollectedRuntimeObservation(structuredClone(receipt)), /OBSERVATION_REFUSED/);
});

test('verification only GETs the two fixed origins without cookies, redirects or business writes', async t => {
  const f = await verificationFixture(t);
  await verify(f);
  for (const { url, options } of f.calls) {
    assert.ok(Object.values(PROTECTED_OBSERVATION_ORIGINS).includes(new URL(url).origin));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.body, undefined);
    assert.deepEqual(options.headers, { Accept: '*/*' });
    assert.ok(options.signal instanceof AbortSignal);
  }
  for (const url of f.files.keys()) assert.ok(f.calls.some(call => call.url === url));
});

test('the verification schema rejects epoch, tenant, host and credential injection before any HTTP request', async t => {
  const f = await verificationFixture(t);
  for (const delta of [{ securityEpoch: f.plan.securityEpoch }, { tenantId: f.plan.securityEpoch },
    { origin: 'https://foreign.example.test' }, { authorization: 'private-value' },
    { environment: 'prod' }, { apiCommit: 'main' }, { frontendCommit: 'b'.repeat(41) },
    { customer: { ...f.selection.customer, frontendSha256: 'not-a-digest' } },
    { platform: { ...f.selection.customer } },
    { evidence: { ...f.selection.evidence, runbook: 'https://foreign.example.test' } }]) {
    await assert.rejects(() => verifyProtectedRuntimeArtifacts({ selection: { ...f.selection, ...delta },
      artifactRoot: f.root, fetchImpl: f.fetchImpl }), /OBSERVATION_REFUSED/);
  }
  assert.equal(f.calls.length, 0);
  const getter = { ...f.selection };
  Object.defineProperty(getter, 'apiCommit', { get() { assert.fail('GETTER_EXECUTED'); }, enumerable: true });
  assert.throws(() => normalizeRuntimeVerificationSelection(getter), /OBSERVATION_REFUSED/);
  assert.throws(() => normalizeRuntimeVerificationSelection(Object.create(f.selection)), /OBSERVATION_REFUSED/);
});

test('read-only verification retains every existing byte, MIME, origin, build and health check', async t => {
  const f = await verificationFixture(t);
  for (const transform of [
    row => ({ ...row, bytes: Buffer.from('<html>cold start</html>'), type: 'text/html' }),
    row => ({ ...row, url: 'https://foreign.example.test/' }),
    row => ({ ...row, status: 302 }),
    row => ({ ...row, type: 'text/plain; charset=utf-8' }),
    row => ({ ...row, bytes: Buffer.concat([row.bytes, Buffer.from('tampered')]) }),
    row => row.type.startsWith('application/json') ? { ...row, bytes: Buffer.from('{}') } : row,
    row => row.type.startsWith('application/json') ? { ...row,
      bytes: Buffer.from(row.bytes.toString().replaceAll(f.plan.apiCommit, 'c'.repeat(40))) } : row,
    row => row.url.endsWith('/assets/fixture.css') ? { ...row, status: 404 } : row,
  ]) {
    f.transform(transform);
    await assert.rejects(() => verify(f), /OBSERVATION_REFUSED/);
  }
});

test('independent manifest pins cannot be derived from a mismatching local artifact or live response', async t => {
  const f = await verificationFixture(t);
  const wrong = { ...f.selection, customer: { ...f.selection.customer, frontendSha256: 'f'.repeat(64) } };
  await assert.rejects(() => verifyProtectedRuntimeArtifacts({ selection: wrong,
    artifactRoot: f.root, fetchImpl: f.fetchImpl }), /OBSERVATION_REFUSED/);
  const different = { ...f.selection, frontendCommit: 'd'.repeat(40) };
  await assert.rejects(() => verifyProtectedRuntimeArtifacts({ selection: different,
    artifactRoot: f.root, fetchImpl: f.fetchImpl }), /OBSERVATION_REFUSED/);
});

test('degraded and not-ready health are preserved rather than turned into a healthy release', async t => {
  const f = await verificationFixture(t);
  f.transform(row => row.type.startsWith('application/json') ? { ...row, status: 503,
    bytes: Buffer.from(row.bytes.toString().replace('"ready"', '"not_ready"')) } : row);
  assert.deepEqual((await verify(f)).surfaces.map(row => row.required), ['not_ready', 'not_ready']);
  f.transform(row => row.type.startsWith('application/json') ? { ...row,
    bytes: Buffer.from(row.bytes.toString().replace('"ready"', '"degraded"')) } : row);
  assert.deepEqual((await verify(f)).surfaces.map(row => row.optional), ['degraded', 'degraded']);
});

test('read-only verification retains bounded cancellation and emits only the closed failure code', async t => {
  const f = await verificationFixture(t);
  const signals = [];
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('PRIVATE_PROVIDER_FAILURE')), { once: true });
  });
  await assert.rejects(() => verifyProtectedRuntimeArtifacts({ selection: f.selection,
    artifactRoot: f.root, fetchImpl, timeoutMs: 1000 }), error => {
    assert.equal(error.message, 'PROTECTED_RUNTIME_OBSERVATION_REFUSED');
    return true;
  });
  assert.ok(signals.length > 0);
  assert.ok(signals.every(signal => signal.aborted));
});

test('future selections, invalid roots, unbounded deadlines and stale clocks remain refused', async t => {
  const f = await verificationFixture(t);
  const options = { selection: f.selection, artifactRoot: f.root, fetchImpl: f.fetchImpl };
  for (const change of [{ artifactRoot: '.' }, { timeoutMs: 999 }, { timeoutMs: 90001 },
    { clock: () => Date.parse('2026-01-01T00:00:00.000Z') }]) {
    await assert.rejects(() => verifyProtectedRuntimeArtifacts({ ...options, ...change }), /OBSERVATION_REFUSED/);
  }
  let calls = 0;
  await assert.rejects(() => verifyProtectedRuntimeArtifacts({ ...options,
    clock: () => Date.now() + (calls++ === 0 ? 0 : 120000) }), /OBSERVATION_REFUSED/);
});

test('the native verification path is fixed-source, owner-only, read-only and never schedules or persists', async () => {
  const workflow = await readFile('.github/workflows/protected-int-runtime-verification.yml', 'utf8');
  assert.match(workflow, /github\.repository == 'floriankreutzer\/conference-manager-api'/);
  assert.match(workflow, /github\.event\.repository\.private == false/);
  assert.match(workflow, /github\.actor == 'floriankreutzer'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /permission-contents: read/);
  assert.doesNotMatch(workflow,
    /schedule:|cron:|pull_request_target:|contents: write|environment:|CM_INT_AUDIT|DATABASE_URL|SECURITY_EPOCH/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /submodules: true/);
  assert.match(workflow, /node release-source\/scripts\/render-build-protected\.mjs/);
  assert.match(workflow, /verifyProtectedRuntimeArtifacts/);
  assert.doesNotMatch(workflow, /reconcileProtectedRuntimeObservation|protected-runtime-recurring-observe|protected-runtime-observe\.mjs/);
  assert.match(workflow, /row\.required !== 'ready'/);
  assert.match(workflow, /PROTECTED_RUNTIME_VERIFICATION_REFUSED/);
  for (const literal of ['405003e9be0c386934ae02be43d57dd12a6d8d6c', '26e3a75bfa15f0a2ea1373e7f8e6ccc61a224dfc',
    '016663458140e74636a99ac2c28907aea26ab6634c92f4065181f98c145601d3',
    '0f2aae70f45ad7be5684c2864c57e9275253438d0e240b7eacf0155a564c0f9b',
    'dep-dbsoc767bikc73c1bltg', 'dep-dbsoc767bikc73c1bl00']) assert.ok(workflow.includes(literal));
});


test('native metadata names the public deployed source and maps it without changing the sealed verification contract', async () => {
  const workflow = await readFile('.github/workflows/protected-int-runtime-verification.yml', 'utf8');
  const raw = workflow.match(/INT_VERIFICATION_SELECTION: >-\n        (\{[^\n]+\})/);
  assert.ok(raw);
  const { deployedSourceCommit, ...selection } = JSON.parse(raw[1]);
  const source = workflow.match(/INT_DEPLOYED_SOURCE_COMMIT: '([a-f0-9]{40})'/)?.[1];
  assert.equal(deployedSourceCommit, source);
  assert.equal(source, workflow.match(/ref: '([a-f0-9]{40})'/)?.[1]);
  assert.equal(normalizeRuntimeVerificationSelection({ ...selection, apiCommit: deployedSourceCommit }).apiCommit, source);
  assert.equal(Object.hasOwn(selection, 'apiCommit'), false);
  assert.match(workflow, /PROTECTED_API_COMMIT: \$\{\{ env\.INT_DEPLOYED_SOURCE_COMMIT \}\}/);
  assert.match(workflow, /selection: \{ \.\.\.selection, apiCommit: deployedSourceCommit \}/);
  assert.doesNotMatch(workflow, /gitleaks:allow|GITLEAKS_ENABLE|continue-on-error/);
});
