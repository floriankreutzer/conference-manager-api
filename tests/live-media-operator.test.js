import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';
import { LIVE_MEDIA_TARGET, loadLiveMediaRecord, loadLiveMediaOperation, sha256 } from '../scripts/support/live-media-operator-config.mjs';
import { runLiveMediaOperation, parseLiveMediaBatch } from '../scripts/support/live-media-operator-run.mjs';
import { assertLiveRuntimesClosed } from '../scripts/support/live-media-operator-http.mjs';
import { assertOperatorIdentity } from '../scripts/support/live-media-operator-db.mjs';
import { assertLiveMediaSourceBinding } from '../scripts/support/live-media-source-binding.mjs';

const NOW = Date.parse('2026-10-11T18:00:00.000Z');
const SOURCE = 'a'.repeat(40);
const MANIFEST = 'b'.repeat(64);
const BYTES = Buffer.from('synthetic operator image');
const REFERENCE = mediaObjectReference({ tenantId: '11111111-1111-4111-8111-111111111111',
  assetId: '22222222-2222-4222-8222-222222222222', kind: 'room', sha256: sha256(BYTES),
  byteLength: BYTES.length, contentType: 'image/webp' });

function setup(action = 'copy', overrides = {}) {
  const record = { schemaVersion: 1, operationId: 'c'.repeat(32), direction: 'copy', sourceSha: SOURCE,
    ...LIVE_MEDIA_TARGET, issuedAt: '2026-10-11T17:59:00.000Z', expiresAt: '2026-10-11T18:59:00.000Z',
    manifestSha256: MANIFEST, externalEvidenceSha256: 'd'.repeat(64), recoveryEvidenceSha256: 'e'.repeat(64),
    customerDeploymentId: 'dep-abcdefghij123', platformDeploymentId: 'dep-abcdefghij456', ...overrides };
  const raw = JSON.stringify(record);
  return { LIVE_MEDIA_ACTION: action, LIVE_MEDIA_KIND: ['copy', 'rollback'].includes(action) ? 'room' : 'none',
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api',
    GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: 'floriankreutzer',
    GITHUB_TRIGGERING_ACTOR: 'floriankreutzer', GITHUB_RUN_ID: '123', GITHUB_SHA: SOURCE,
    LIVE_MEDIA_OPERATION_JSON: raw, LIVE_MEDIA_RECORD_SHA256: sha256(raw),
    CM_NEON_LIVE_OPERATOR_DATABASE_URL: 'postgresql://cm_demo_migration:synthetic-database-password@'
      + LIVE_MEDIA_TARGET.databaseHost + '/' + LIVE_MEDIA_TARGET.databaseName,
    CM_NEON_LIVE_OPERATOR_ACCESS_KEY_ID: 'synthetic-live-access',
    CM_NEON_LIVE_OPERATOR_SECRET_ACCESS_KEY: 'synthetic-live-secret-not-a-real-key' };
}
const load = (env) => loadLiveMediaOperation(env, { now: NOW, sourceSha: SOURCE });

function inventory({ external = false, bytes = true, valid = true, manifest = MANIFEST } = {}) {
  return { references: [{ reference: REFERENCE, objectKey: external ? REFERENCE.key : null,
    hasBytes: bytes, bytesValid: bytes && valid }], manifestSha256: manifest, room: 1, catalogue: 0,
  bytes: BYTES.length, postgresOnly: external ? 0 : 1, external: external ? 1 : 0,
  postgresBytes: bytes ? 1 : 0, invalidPostgresBytes: bytes && !valid ? 1 : 0, otherCustody: 0 };
}

function ports(snapshots = [inventory()], changes = {}) {
  const calls = [];
  let index = 0;
  const result = {
    now: () => NOW,
    processDeadline: NOW + 180_000,
    identity: async () => { calls.push('identity'); },
    closed: async () => { calls.push('closed'); },
    quiescent: async () => { calls.push('quiescent'); },
    inventory: async () => { calls.push('inventory'); return snapshots[Math.min(index++, snapshots.length - 1)]; },
    get: async () => { calls.push('get'); return BYTES; },
    persist: (report) => { calls.push('persist:' + report.mutationOutcome); },
    batch: async () => { calls.push('batch'); return JSON.stringify({ status: 'incomplete', phase: 'copy', kind: 'room',
      inspected: 1, changed: 1, byteLength: BYTES.length, hasMore: true, restoreEvidenceSha256: null }); },
    ...changes,
  };
  return { calls, value: result };
}

test('Live operator binds immutable record, exact source/target and explicit owner dispatch', () => {
  const operation = load(setup());
  assert.equal(operation.record.branchId, LIVE_MEDIA_TARGET.branchId);
  assert.equal(operation.record.operatorRole, 'cm_demo_migration');
  for (const [key, value] of Object.entries({ GITHUB_REF: 'refs/heads/unreviewed', GITHUB_ACTOR: 'another-user',
    GITHUB_TRIGGERING_ACTOR: 'another-user', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: 'invalid-sha', RUNNER_DEBUG: '1', ACTIONS_STEP_DEBUG: 'true', NODE_OPTIONS: '--inspect',
    DATABASE_URL: 'unscoped', MEDIA_OPERATOR_ACCESS_KEY_ID: 'unscoped', CM_NEON_RECOVERY_ACCESS_KEY_ID: 'unscoped',
    DEMO_MEDIA_STORAGE_ACCESS_KEY_ID: 'unscoped', LIVE_MEDIA_ACTION: 'purge', LIVE_MEDIA_KIND: 'all' })) {
    assert.throws(() => load({ ...setup(), [key]: value }), /^Error: LIVE_MEDIA_[A-Z_]+$/);
  }
  for (const override of [{ branchId: 'br-foreign' }, { operatorRole: 'cm_demo_reset' }, { operatorRole: 'another_operator' },
    { sourceSha: 'f'.repeat(40) }, { unexpected: true }, { customerDeploymentId: 'dep-abcdefghij456' },
    { manifestSha256: null }, { issuedAt: '2026-10-11T18:01:00.000Z' }, { expiresAt: '2026-10-11T18:00:10.000Z' },
    { expiresAt: '2026-10-11T20:00:00.000Z' }, { direction: 'rollback' }]) {
    assert.throws(() => load(setup('copy', override)), /^Error: LIVE_MEDIA_[A-Z_]+$/);
  }
  assert.equal(load(setup('preflight', { manifestSha256: null })).action, 'preflight');
  const advanced = load({ ...setup(), GITHUB_SHA: 'f'.repeat(40) });
  assert.equal(advanced.controllerSha, 'f'.repeat(40));
  assert.equal(advanced.record.sourceSha, SOURCE);
});

test('record rejects duplicate keys, whitespace, digest drift, URL credentials scope and queries', () => {
  for (const transform of [(raw) => raw + '\n', (raw) => raw.replace('{', '{"schemaVersion":1,'),
    (raw) => raw.replace('"direction":"copy"', '"direction":"rollback"')]) {
    const env = setup();
    env.LIVE_MEDIA_OPERATION_JSON = transform(env.LIVE_MEDIA_OPERATION_JSON);
    assert.throws(() => load(env));
  }
  for (const transform of [(url) => url + '?sslmode=require', (url) => url.replace('ep-solitary-thunder', 'ep-other'),
    (url) => url.replace('cm_demo_migration:', 'neondb_owner:'), (url) => url.replace('postgresql:', 'http:')]) {
    const env = setup();
    env.CM_NEON_LIVE_OPERATOR_DATABASE_URL = transform(env.CM_NEON_LIVE_OPERATOR_DATABASE_URL);
    assert.throws(() => load(env), /LIVE_MEDIA_DATABASE_INVALID/);
  }
});

test('preflight makes no mutation or closure claim and reports zero unexercised provider reads', async () => {
  const fixture = ports();
  const report = await runLiveMediaOperation(load(setup('preflight', { manifestSha256: null })), fixture.value);
  assert.equal(report.status, 'preflight_only');
  assert.equal(report.complete, false);
  assert.equal(report.providerReads, 0);
  assert.equal(report.providerReadVerified, false);
  assert.deepEqual(fixture.calls, ['identity', 'inventory']);
});

test('one copy batch preserves incomplete status; only separate full reconciliation completes', async () => {
  const fixture = ports([inventory(), inventory({ external: true })]);
  const report = await runLiveMediaOperation(load(setup()), fixture.value);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.complete, false);
  assert.equal(report.batch.hasMore, true);
  assert.equal(report.mutationOutcome, 'observed');
  assert.equal(fixture.calls.filter((call) => call === 'batch').length, 1);
  assert.ok(fixture.calls.indexOf('persist:unknown') < fixture.calls.indexOf('batch'));
  const final = ports([inventory({ external: true })]);
  const reconciled = await runLiveMediaOperation(load(setup('reconcile')), final.value);
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(reconciled.complete, true);
  assert.equal(reconciled.providerReads, 1);
  assert.equal(final.calls.includes('batch'), false);
});

test('incomplete reconciliation never claims completion', async () => {
  const fixture = ports();
  const report = await runLiveMediaOperation(load(setup('reconcile')), fixture.value);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.complete, false);
});

test('failed/invalid child outcomes remain unknown and never retry or log raw errors', async () => {
  for (const child of [async () => { throw new Error('password=private; https://signed.invalid/?token=secret'); },
    async () => 'private unexpected stdout', async () => JSON.stringify({ status: 'completed' })]) {
    const fixture = ports([inventory()], { batch: child });
    const report = await runLiveMediaOperation(load(setup()), fixture.value);
    assert.equal(report.status, 'failed');
    assert.equal(report.mutationOutcome, 'unknown');
    assert.equal(report.complete, false);
    assert.doesNotMatch(JSON.stringify(report), /password|signed\.invalid|token=|private unexpected/);
  }
});

test('closure, quiescence, manifest drift and reserve failure all stop before mutation', async () => {
  for (const changes of [{ closed: async () => { throw new Error('private response'); } },
    { quiescent: async () => { throw new Error('private SQL'); } },
    { inventory: async () => inventory({ manifest: 'f'.repeat(64) }) },
    { now: () => NOW + 59 * 60_000 - 30_000 }]) {
    const fixture = ports([inventory()], changes);
    const report = await runLiveMediaOperation(load(setup()), fixture.value);
    assert.equal(report.status, 'failed');
    assert.equal(report.mutationOutcome, 'not_started');
    assert.equal(fixture.calls.includes('batch'), false);
  }
});

test('forward copy rejects missing/corrupt retained bytes and loss during final snapshot', async () => {
  for (const snapshot of [inventory({ external: true, bytes: false }), inventory({ valid: false })]) {
    const fixture = ports([snapshot]);
    assert.equal((await runLiveMediaOperation(load(setup()), fixture.value)).status, 'failed');
    assert.equal(fixture.calls.includes('batch'), false);
  }
  const fixture = ports([inventory({ external: true }), inventory({ external: true }),
    inventory({ external: true, bytes: false })]);
  const report = await runLiveMediaOperation(load(setup('reconcile')), fixture.value);
  assert.equal(report.status, 'failed');
  assert.equal(report.complete, false);
});

test('provider byte corruption cannot satisfy reconciliation', async () => {
  const fixture = ports([inventory({ external: true })], { get: async () => Buffer.alloc(BYTES.length) });
  const report = await runLiveMediaOperation(load(setup('reconcile')), fixture.value);
  assert.equal(report.status, 'failed');
  assert.equal(report.complete, false);
  assert.equal(report.providerReads, 0);
});

test('rollback can repair stale retained bytes from current provider revision and requires final PG bytes', async () => {
  const fixture = ports([inventory({ external: true, valid: false }), inventory()], {
    batch: async () => JSON.stringify({ status: 'completed', phase: 'rollback', kind: 'room', inspected: 1,
      changed: 1, byteLength: BYTES.length, hasMore: false, restoreEvidenceSha256: null }),
  });
  const report = await runLiveMediaOperation(load(setup('rollback', { direction: 'rollback' })), fixture.value);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.mutationOutcome, 'observed');
  const final = ports([inventory()]);
  assert.equal((await runLiveMediaOperation(load(setup('reconcile', { direction: 'rollback' })), final.value)).complete, true);
});

test('strict batch schema rejects contradictory status, extra fields, counters and phase', () => {
  const operation = load(setup());
  const valid = { status: 'incomplete', phase: 'copy', kind: 'room', inspected: 1, changed: 1,
    byteLength: BYTES.length, hasMore: true, restoreEvidenceSha256: null };
  for (const override of [{ status: 'completed' }, { phase: 'purge' }, { kind: 'catalogue' },
    { inspected: 11 }, { changed: 2 }, { byteLength: -1 }, { rawError: 'private' }, { hasMore: 'false' }]) {
    assert.throws(() => parseLiveMediaBatch(JSON.stringify({ ...valid, ...override }), operation), /OUTCOME_UNKNOWN/);
  }
});

test('workflow exposes only manual enums and three dedicated secrets after install', () => {
  const workflow = readFileSync(new URL('../.github/workflows/live-media-operator.yml', import.meta.url), 'utf8');
  assert.match(workflow, /options: \[preflight, reconcile, copy, rollback\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.equal((workflow.match(/secrets\./g) || []).length, 3);
  assert.ok(workflow.indexOf('npm ci --ignore-scripts') < workflow.indexOf('secrets.CM_NEON_LIVE'));
  assert.ok(workflow.indexOf('scripts/live-media-operator-source.mjs') < workflow.indexOf('ref: ${{ steps.source.outputs.source_sha }}'));
  assert.ok(workflow.indexOf('Verify selected checkout') < workflow.indexOf('npm ci --ignore-scripts'));
  assert.match(workflow, /fetch-depth: 0/);
  assert.doesNotMatch(workflow, /fromJSON|GITHUB_SHA:/);
  assert.doesNotMatch(workflow, /schedule:|workflow_run:|pull_request:|contents: write|id-token: write/);
  const entry = readFileSync(new URL('../scripts/live-media-operator.mjs', import.meta.url), 'utf8');
  assert.match(entry, /stdio: \['ignore', 'pipe', 'ignore'\]/);
  assert.match(entry, /child\?\.kill\('SIGKILL'\)/);
  assert.match(entry, /client\.on\('error', abort\)/);
  const http = readFileSync(new URL('../scripts/support/live-media-operator-http.mjs', import.meta.url), 'utf8');
  assert.match(http, /redirect: 'error'/);
  assert.doesNotMatch(entry, /shell: true|console\.(?:log|error)|process\.stderr\.write/);
});

test('trusted controller validates the record without operator credentials and rejects digest drift', () => {
  const env = setup();
  for (const key of Object.keys(env).filter((key) => key.startsWith('CM_NEON_LIVE_OPERATOR_'))) delete env[key];
  assert.equal(loadLiveMediaRecord(env, { now: NOW }).record.sourceSha, SOURCE);
  assert.throws(() => loadLiveMediaRecord({ ...env, LIVE_MEDIA_RECORD_SHA256: '0'.repeat(64) }, { now: NOW }), /RECORD_INVALID/);
  assert.throws(() => loadLiveMediaOperation(setup(), { now: NOW, sourceSha: 'f'.repeat(40) }), /SOURCE_INVALID/);
});

test('real Git binding accepts advanced main but rejects unmerged, side-parent and wrong checkouts', (t) => {
  const repository = mkdtempSync(join(tmpdir(), 'cm-live-source-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env,
      GIT_AUTHOR_NAME: 'Synthetic test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
  const commit = (name) => {
    writeFileSync(join(repository, name), name + '\n');
    git(['add', name]); git(['commit', '--quiet', '-m', name]);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '--quiet', '--initial-branch=main']);
  const sourceSha = commit('accepted-source');
  git(['checkout', '--quiet', '-b', 'side']);
  const side = commit('side-change');
  git(['checkout', '--quiet', 'main']);
  commit('main-advance');
  git(['merge', '--quiet', '--no-ff', '-m', 'accepted-merge', 'side']);
  const controllerSha = git(['rev-parse', 'HEAD']);
  assert.equal(assertLiveMediaSourceBinding({ sourceSha, controllerSha, expectedHead: controllerSha, repository }), controllerSha);
  assert.throws(() => assertLiveMediaSourceBinding({ sourceSha: side, controllerSha, expectedHead: controllerSha, repository }),
    /LIVE_MEDIA_SOURCE_INVALID/);
  git(['checkout', '--quiet', '--detach', sourceSha]);
  const foreign = commit('unmerged-change');
  git(['checkout', '--quiet', 'main']);
  for (const invalid of [foreign, 'f'.repeat(40), '--unsafe']) {
    assert.throws(() => assertLiveMediaSourceBinding({ sourceSha: invalid, controllerSha, expectedHead: controllerSha, repository }),
      /LIVE_MEDIA_SOURCE_INVALID/);
  }
  assert.throws(() => assertLiveMediaSourceBinding({ sourceSha, controllerSha, expectedHead: sourceSha, repository }),
    /LIVE_MEDIA_SOURCE_INVALID/);
  git(['checkout', '--quiet', '--detach', sourceSha]);
  assert.equal(assertLiveMediaSourceBinding({ sourceSha, controllerSha, expectedHead: sourceSha, repository }), sourceSha);
});

test('closed runtime requires exact bounded gate bodies, not status-only dependency failures', async () => {
  const gate = (url, overrides = {}) => new Response(JSON.stringify(url.endsWith('/health/deploy')
    ? { status: 'deployment_ready', trafficMode: 'closed', requestId: 'discarded', ...overrides }
    : { error: { code: 'DEMO_TRAFFIC_CLOSED' }, requestId: 'discarded', ...overrides }),
  { status: url.endsWith('/health/deploy') ? 200 : 503, headers: { 'content-type': 'application/json' } });
  let calls = 0;
  await assertLiveRuntimesClosed(async (url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'error');
    return gate(url);
  });
  assert.equal(calls, 6);
  for (const fetcher of [async (url) => gate(url, { trafficMode: 'open' }),
    async (url) => gate(url, { trafficMode: 'expired' }),
    async (url) => gate(url, { status: 'ready' }),
    async (url) => url.endsWith('/health/deploy') ? gate(url) : gate(url, { error: { code: 'DATABASE_UNAVAILABLE' } }),
    async () => new Response('malformed', { headers: { 'content-type': 'application/json' } }),
    async () => new Response(' '.repeat(1025), { headers: { 'content-type': 'application/json' } }),
    async () => new Response('{}', { status: 302, headers: { location: 'https://example.invalid' } }),
    async () => { throw new Error('private network details'); }]) {
    await assert.rejects(assertLiveRuntimesClosed(fetcher), /^Error: LIVE_MEDIA_RUNTIME_NOT_CLOSED$/);
  }
});

test('identity and closure time consume one process deadline and late batch cannot start', async () => {
  for (const slowPort of ['identity', 'closed']) {
    let now = NOW;
    const fixture = ports([inventory()], { now: () => now,
      [slowPort]: async () => { now += slowPort === 'closed' ? 60_000 : 110_000; } });
    const report = await runLiveMediaOperation(load(setup()), fixture.value);
    assert.equal(report.status, 'failed');
    assert.equal(report.mutationOutcome, 'not_started');
    assert.equal(fixture.calls.includes('batch'), false);
  }
});

test('preflight blocks bad copy source bytes without allocating provider reads', async () => {
  const fixture = ports([inventory({ valid: false })]);
  const report = await runLiveMediaOperation(load(setup('preflight', { manifestSha256: null })), fixture.value);
  assert.equal(report.status, 'failed');
  assert.equal(fixture.calls.includes('get'), false);
});

test('SQL identity requires exact role/schema/sentinel and every individual mutation privilege', async () => {
  const grants = ['inventory_select', 'inventory_insert', 'inventory_update', 'inventory_delete',
    'room_select', 'room_update', 'catalogue_select', 'catalogue_update'];
  const row = { database: LIVE_MEDIA_TARGET.databaseName, role: LIVE_MEDIA_TARGET.operatorRole,
    schema_version: 51, overlay_version: 17, sentinel_count: '1', bounded_role: true,
    ...Object.fromEntries(grants.map((key) => [key, true])) };
  let query;
  const client = (result) => ({ query: async (sql) => { query = sql; return { rows: result }; } });
  await assertOperatorIdentity(client([row]), LIVE_MEDIA_TARGET.operatorRole);
  assert.equal((query.match(/has_table_privilege\(current_user,'[^']+','(?:SELECT|INSERT|UPDATE|DELETE)'\)/g) || []).length, 8);
  for (const key of grants) {
    for (const value of [false, null, undefined]) {
      await assert.rejects(assertOperatorIdentity(client([{ ...row, [key]: value }]), LIVE_MEDIA_TARGET.operatorRole),
        /LIVE_MEDIA_IDENTITY_INVALID/);
    }
  }
  for (const override of [{ database: 'foreign_database' }, { role: 'cm_demo_reset' },
    { schema_version: 43 }, { overlay_version: 8 }, { sentinel_count: '0' }, { bounded_role: false }]) {
    await assert.rejects(assertOperatorIdentity(client([{ ...row, ...override }]), LIVE_MEDIA_TARGET.operatorRole),
      /LIVE_MEDIA_IDENTITY_INVALID/);
  }
  await assert.rejects(assertOperatorIdentity(client([]), LIVE_MEDIA_TARGET.operatorRole), /LIVE_MEDIA_IDENTITY_INVALID/);
  await assert.rejects(assertOperatorIdentity(client([row, row]), LIVE_MEDIA_TARGET.operatorRole), /LIVE_MEDIA_IDENTITY_INVALID/);
});

test('a late final inventory or preflight cannot report success after the fixed deadline', async () => {
  for (const action of ['preflight', 'reconcile']) {
    let now = NOW;
    let reads = 0;
    const fixture = ports([inventory({ external: true })], { now: () => now, inventory: async () => {
      reads += 1;
      if (reads === (action === 'preflight' ? 1 : 3)) now += 61 * 60_000;
      return inventory({ external: true });
    } });
    const report = await runLiveMediaOperation(load(setup(action)), fixture.value);
    assert.equal(report.status, 'failed');
    assert.equal(report.complete, false);
  }
});
