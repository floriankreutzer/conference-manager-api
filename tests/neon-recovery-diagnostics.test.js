import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createNeonRecoveryPreflightDiagnostics,
  NEON_RECOVERY_PREFLIGHT_FAILURE_FILE } from '../scripts/support/neon-recovery-diagnostics.mjs';
import { verifyRestoredProviderBytes } from '../scripts/support/neon-recovery-media.mjs';
import { RECOVERY_ROOT } from '../scripts/support/neon-recovery-config.mjs';
import { recoveryReferences, recoveryBytes, recoveryProviderFixture } from './support/neon-recovery-fixture.js';

const sourceRuntimeRef = 'a'.repeat(40);
const stages = ['configuration', 'identities', 'schema', 'database-media',
  'provider-bytes', 'semantic-state', 'commit', 'report'];
const entrypoint = fileURLToPath(new URL('../scripts/neon-recovery-acceptance.mjs', import.meta.url));

test('preflight failure reports only completed gates, the exact failed stage and monotonic durations', () => {
  for (let failed = 0; failed < stages.length; failed += 1) {
    let time = 100;
    const diagnostics = createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef, now: () => time });
    for (const stage of stages.slice(1, failed + 1)) {
      time += 10;
      diagnostics.advance(stage);
    }
    time += 5.75;
    assert.deepEqual(diagnostics.failure(new Error('private-driver-details')), {
      schemaVersion: 1, scope: 'restored-pair-preflight-failure-not-acceptance', outcome: 'failed',
      sourceRuntimeRef, stage: stages[failed], code: 'UNKNOWN', completedStages: stages.slice(0, failed),
      elapsedMs: failed * 10 + 5, stageElapsedMs: 5,
    });
  }
});

test('diagnostic stages are closed and cannot skip gates or accept unvalidated source refs', () => {
  const diagnostics = createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef });
  for (const stage of ['provider-bytes', 'configuration', 'private-stage-secret', null, {}]) {
    assert.throws(() => diagnostics.advance(stage), { message: 'NEON_RECOVERY_DIAGNOSTIC_STAGE_INVALID' });
    assert.equal(diagnostics.failure(null).stage, 'configuration');
  }
  for (const stage of stages.slice(1)) diagnostics.advance(stage);
  assert.throws(() => diagnostics.advance('report'), { message: 'NEON_RECOVERY_DIAGNOSTIC_STAGE_INVALID' });
  for (const value of [undefined, 'private-ref-secret', 'A'.repeat(40), `${sourceRuntimeRef}\n`, { toString() { throw new Error(); } }]) {
    assert.equal(createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef: value }).failure(null).sourceRuntimeRef, null);
  }
});

test('only exact own allowlisted error codes survive; secrets, getters and provider serialization never do', () => {
  const diagnostics = createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef });
  const sensitive = 'private-token-cookie-dsn-provider-payload';
  let invoked = 0;
  const error = Object.assign(new Error(sensitive, { cause: new Error(sensitive) }), {
    code: 'MEDIA_STORAGE_INTEGRITY_FAILED', name: sensitive, stack: sensitive,
    $metadata: { sensitive }, $response: { sensitive }, toJSON() { invoked += 1; return { sensitive }; },
  });
  assert.equal(diagnostics.failure(error).code, 'MEDIA_STORAGE_INTEGRITY_FAILED');
  assert.equal(JSON.stringify(diagnostics.failure(error)).includes(sensitive), false);
  assert.equal(diagnostics.failure(new Error('NEON_RECOVERY_SCHEMA_INVALID')).code, 'NEON_RECOVERY_SCHEMA_INVALID');
  assert.equal(diagnostics.failure(new Error('DEMO_FIXTURE_CHECKSUM_MISMATCH')).code, 'DEMO_FIXTURE_CHECKSUM_MISMATCH');
  const getters = Object.defineProperties({}, {
    code: { get() { invoked += 1; throw new Error(sensitive); } },
    message: { get() { invoked += 1; throw new Error(sensitive); } },
  });
  for (const thrown of [null, undefined, sensitive, new Error(sensitive),
    { code: `MEDIA_STORAGE_INTEGRITY_FAILED ${sensitive}`, message: sensitive },
    { message: `NEON_RECOVERY_SCHEMA_INVALID\n${sensitive}` },
    Object.create({ code: 'MEDIA_STORAGE_INTEGRITY_FAILED' }), getters,
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(sensitive); } })]) {
    const report = diagnostics.failure(thrown);
    assert.equal(report.code, 'UNKNOWN');
    assert.equal(JSON.stringify(report).includes(sensitive), false);
  }
  assert.equal(invoked, 0);
});

test('correct restored PNG bytes with form MIME fail the unchanged adapter in provider-bytes before later gates', async () => {
  const provider = recoveryProviderFixture();
  const png = recoveryReferences.find(({ contentType }) => contentType === 'image/png');
  const diagnostics = createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef });
  try {
    assert.ok(png);
    assert.deepEqual(await provider.storage.get(png), recoveryBytes(png));
    provider.commands.length = 0;
    for (const reference of recoveryReferences) {
      const object = provider.objects.get(reference.key);
      assert.equal(object.bytes.length, reference.byteLength);
      assert.equal(createHash('sha256').update(object.bytes).digest('hex'), reference.sha256);
      object.contentType = 'application/x-www-form-urlencoded';
    }
    for (const stage of stages.slice(1, 5)) diagnostics.advance(stage);
    let laterGateRan = false;
    await assert.rejects(async () => {
      await verifyRestoredProviderBytes(provider.storage, recoveryReferences);
      diagnostics.advance('semantic-state');
      laterGateRan = true;
    }, (error) => {
      assert.equal(error.code, 'MEDIA_STORAGE_INTEGRITY_FAILED');
      const report = diagnostics.failure(error);
      assert.equal(report.outcome, 'failed');
      assert.equal(report.stage, 'provider-bytes');
      assert.equal(report.code, 'MEDIA_STORAGE_INTEGRITY_FAILED');
      assert.deepEqual(report.completedStages, stages.slice(0, 4));
      return true;
    });
    assert.equal(laterGateRan, false);
    assert.equal(provider.commands.length, 4);
    assert.ok(provider.commands.every(({ name }) => name === 'GetObjectCommand'));
    assert.equal(provider.objects.size, 34);
    for (const reference of recoveryReferences) {
      assert.deepEqual(provider.objects.get(reference.key).bytes, recoveryBytes(reference));
      assert.equal(provider.objects.get(reference.key).contentType, 'application/x-www-form-urlencoded');
    }
  } finally { provider.storage.close(); }
  assert.ok(provider.clients.every(({ destroyed }) => destroyed));
});

function rejectedPreflight(directory) {
  return spawnSync(process.execPath, [entrypoint, 'preflight'], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { NODE_ENV: 'test', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceRuntimeRef,
      NEON_RECOVERY_BRANCH: RECOVERY_ROOT, NEON_RECOVERY_HOST: 'ep-test-recovery.c-5.eu-central-1.aws.neon.tech',
      DEMO_DATABASE_SSL: 'verify-full', NEON_RECOVERY_ACCESS_KEY_ID: 'private-test-access-only',
      NEON_RECOVERY_SECRET_ACCESS_KEY: 'private-test-secret-only',
      DEMO_CUSTOMER_DATABASE_URL: 'postgresql://test:private-test-password@invalid.example/test' },
  });
}

test('actual rejected preflight retains a private separate failure artifact and remains failed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-recovery-diagnostic-'));
  try {
    const result = rejectedPreflight(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'NEON_RECOVERY_ACCEPTANCE_FAILED\n');
    assert.deepEqual(await readdir(directory), [NEON_RECOVERY_PREFLIGHT_FAILURE_FILE]);
    const file = path.join(directory, NEON_RECOVERY_PREFLIGHT_FAILURE_FILE);
    const contents = await readFile(file, 'utf8');
    const report = JSON.parse(contents);
    assert.equal(report.scope, 'restored-pair-preflight-failure-not-acceptance');
    assert.equal(report.outcome, 'failed');
    assert.equal(report.stage, 'configuration');
    assert.equal(report.code, 'NEON_RECOVERY_CONTEXT_INVALID');
    assert.equal(report.sourceRuntimeRef, sourceRuntimeRef);
    assert.deepEqual(report.completedStages, []);
    assert.ok(Number.isSafeInteger(report.elapsedMs) && report.elapsedMs >= 0);
    assert.ok(Number.isSafeInteger(report.stageElapsedMs) && report.stageElapsedMs >= 0);
    assert.equal(contents.includes('private-test'), false);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('diagnostic write failure preserves the primary preflight failure and never overwrites retained evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-recovery-diagnostic-'));
  try {
    const file = path.join(directory, NEON_RECOVERY_PREFLIGHT_FAILURE_FILE);
    await writeFile(file, 'existing-private-evidence', { mode: 0o600, flag: 'wx' });
    const result = rejectedPreflight(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'NEON_RECOVERY_ACCEPTANCE_FAILED\nNEON_RECOVERY_DIAGNOSTIC_WRITE_FAILED\n');
    assert.equal(await readFile(file, 'utf8'), 'existing-private-evidence');
    assert.deepEqual(await readdir(directory), [NEON_RECOVERY_PREFLIGHT_FAILURE_FILE]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a rejected diagnostic write cannot skip subsequent cleanup or replace its safe failure handling', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-recovery-diagnostic-'));
  try {
    await writeFile(path.join(directory, NEON_RECOVERY_PREFLIGHT_FAILURE_FILE), 'retained', { mode: 0o600, flag: 'wx' });
    const diagnosticModule = new URL('../scripts/support/neon-recovery-diagnostics.mjs', import.meta.url).href;
    const cleanupModule = new URL('../scripts/support/neon-recovery-cleanup.mjs', import.meta.url).href;
    const source = `
      import { createNeonRecoveryPreflightDiagnostics } from ${JSON.stringify(diagnosticModule)};
      import { closeNeonRecoveryResources } from ${JSON.stringify(cleanupModule)};
      const diagnostics = createNeonRecoveryPreflightDiagnostics();
      const retained = await diagnostics.retainFailure(new Error('private-primary-failure'));
      const calls = [];
      const cleaned = await closeNeonRecoveryResources([
        () => { calls.push('database'); throw new Error('private-close-failure'); },
        () => { calls.push('storage'); },
      ]);
      process.stdout.write(JSON.stringify({ retained, cleaned, calls, exitCode: process.exitCode }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'NEON_RECOVERY_DIAGNOSTIC_WRITE_FAILED\nNEON_RECOVERY_CLEANUP_FAILED\n');
    assert.deepEqual(JSON.parse(result.stdout), { retained: false, cleaned: false, calls: ['database', 'storage'], exitCode: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
