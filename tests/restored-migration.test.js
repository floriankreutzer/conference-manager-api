import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { restoredMigrationEnvironment, runRestoredMigration } from '../scripts/support/restored-migration-environment.mjs';

const sourceHost = 'ep-source-unit.eu-central-1.aws.neon.tech';
const targetHost = 'ep-restored-unit.c-5.eu-central-1.aws.neon.tech';
const request = { sourceSha: 'a'.repeat(40), sourceBranchId: 'br-source-unit', targetBranchId: 'br-restored-unit',
  sourceHost, targetHost, snapshotId: 'snap-restored-unit', servicesClosed: true };
const receipt = { schemaVersion: 1, operation: 'provider_metrics_migration', canonicalVersion: 66, demoVersion: 29,
  resetPerformed: false, retainedCountsMatch: true };
const urlKeys = ['DEMO_CUSTOMER_DATABASE_URL', 'DEMO_PLATFORM_DATABASE_URL',
  'DEMO_RESET_DATABASE_URL', 'DEMO_MIGRATION_DATABASE_URL'];
function context() {
  const env = { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'floriankreutzer', GITHUB_TRIGGERING_ACTOR: 'floriankreutzer',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: request.sourceSha, EXPECTED_MAIN_SHA: request.sourceSha,
    GITHUB_WORKFLOW_REF: 'floriankreutzer/conference-manager-api/.github/workflows/protected-int-restore-migrate.yml@refs/heads/main',
    CM_INT_RESTORE_REQUEST_JSON: JSON.stringify(request), NODE_ENV: 'test', DEMO_RUNTIME: 'shared-postgres-v1',
    DEMO_SEED_VERSION: 'saas-3.7-three-demo-customers-v1', DEMO_DATABASE_SSL: 'verify-full',
    DEMO_CUSTOMER_ORIGIN: 'https://customer.demo.invalid', DEMO_PLATFORM_ORIGIN: 'https://platform.demo.invalid' };
  for (const [index, key] of urlKeys.entries()) {
    env[key] = `postgres://demo_role_${index}:database-password-${index}@${sourceHost}/conference_manager_demo_test`;
  }
  return env;
}

test('restore transport retargets all four existing roles without mutating credentials or the source configuration', () => {
  const env = context(), original = structuredClone(env);
  const prepared = restoredMigrationEnvironment(env);
  for (const key of urlKeys) {
    const before = new URL(env[key]), after = new URL(prepared[key]);
    assert.equal(after.hostname, targetHost);
    for (const field of ['protocol', 'port', 'username', 'password', 'pathname', 'search', 'hash']) {
      assert.equal(after[field], before[field]);
    }
  }
  const parserSecrets = Object.entries(prepared).filter(([key]) => /(?:SESSION_SECRET|CSRF_SECRET|AUDIT_HMAC_SECRET)$/.test(key));
  assert.equal(parserSecrets.length, 5);
  assert.equal(new Set(parserSecrets.map(([, value]) => value)).size, 5);
  assert.equal(prepared.CM_INT_RESTORE_REQUEST_JSON, undefined);
  assert.deepEqual(env, original);
});

test('restore refuses other actors, reruns, source/debug overrides and malformed configuration before executing any child', () => {
  const invalid = [{ GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'other' }, { GITHUB_SHA: '' }, { EXPECTED_MAIN_SHA: 'b'.repeat(40) }, { RUNNER_DEBUG: '1' },
    { ACTIONS_STEP_DEBUG: 'true' }, { ACTIONS_RUNNER_DEBUG: 'true' }, { NODE_OPTIONS: '--inspect' }, { PGSSLMODE: 'disable' },
    { DEMO_DATABASE_SSL: 'disable' }, { CM_INT_RESTORE_REQUEST_JSON: 'PRIVATE_PAYLOAD' },
    { CM_INT_RESTORE_REQUEST_JSON: 'a'.repeat(2049) }, { DEMO_MIGRATION_DATABASE_URL: 'PRIVATE_CREDENTIAL' },
    { DEMO_CUSTOMER_DATABASE_URL: context().DEMO_CUSTOMER_DATABASE_URL + '?sslmode=disable' }];
  for (const patch of invalid) {
    let invoked = false;
    assert.throws(() => runRestoredMigration({ ...context(), ...patch }, () => { invoked = true; }),
      { message: 'RESTORED_MIGRATION_REFUSED' });
    assert.equal(invoked, false);
  }
});

test('restore refuses the same endpoint through aliases, foreign regions, arbitrary destinations and ambiguous private bindings', () => {
  for (const patch of [{ sourceSha: 'b'.repeat(40) }, { extra: true }, { servicesClosed: false },
    { targetBranchId: request.sourceBranchId }, { targetBranchId: [request.targetBranchId] }, { snapshotId: null },
    { sourceHost: 'ep-other-source.eu-central-1.aws.neon.tech' }, { targetHost: sourceHost },
    { targetHost: 'ep-source-unit.c-5.eu-central-1.aws.neon.tech' }, { targetHost: '127.0.0.1' },
    { targetHost: 'ep-restored-unit.eu-west-1.aws.neon.tech' }, { targetHost: targetHost + '.evil.invalid' },
    { targetHost: targetHost + ':5432' }, { targetHost: targetHost.toUpperCase() },
    { targetHost: 'ep-restored-unit-pooler.c-5.eu-central-1.aws.neon.tech' }]) {
    assert.throws(() => restoredMigrationEnvironment({ ...context(),
      CM_INT_RESTORE_REQUEST_JSON: JSON.stringify({ ...request, ...patch }) }), { message: 'RESTORED_MIGRATION_REFUSED' });
  }
});

test('restore delegates only to the canonical bounded migration and accepts only its exact no-reset success receipt', () => {
  let called = false;
  runRestoredMigration(context(), (command, args, options) => {
    called = true;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['scripts/migrate-demo-provider-metrics.mjs']);
    assert.equal(options.timeout, 120_000);
    assert.equal(options.maxBuffer, 16_384);
    assert.equal(options.env.DEMO_DATABASE_SSL, 'verify-full');
    assert.equal(new URL(options.env.DEMO_MIGRATION_DATABASE_URL).hostname, targetHost);
    assert.match(options.cwd, /\/$/);
    return { status: 0, stdout: JSON.stringify(receipt), stderr: 'PRIVATE_CHILD_DETAIL' };
  });
  assert.equal(called, true);
  for (const result of [{ status: 1, stderr: 'PRIVATE_DRIVER_DETAIL' }, { error: new Error('PRIVATE_CREDENTIAL') },
    { status: 0, signal: 'SIGTERM' }, { status: 0, stdout: 'PRIVATE_PAYLOAD' }, { status: 0, stdout: 'null' },
    ...[{ retainedCountsMatch: false }, { resetPerformed: true }, { canonicalVersion: 65 }, { demoVersion: 28 },
      { extra: 'PRIVATE_DETAIL' }].map(patch => ({ status: 0, stdout: JSON.stringify({ ...receipt, ...patch }) }))]) {
    assert.throws(() => runRestoredMigration(context(), () => result), { message: 'RESTORED_MIGRATION_REFUSED' });
  }
});

test('restore CLI emits only fixed refusal and workflow allocates no database secrets during install', () => {
  for (const env of [{ ...context(), GITHUB_RUN_ATTEMPT: '2' }, { ...context(), CM_INT_RESTORE_REQUEST_JSON: 'PRIVATE_DETAIL' }]) {
    const result = spawnSync(process.execPath, ['scripts/restored-migration.mjs'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'RESTORED_MIGRATION_REFUSED\n');
  }
  const workflow = readFileSync('.github/workflows/protected-int-restore-migrate.yml', 'utf8');
  assert.ok(workflow.indexOf('npm ci --ignore-scripts') < workflow.indexOf('secrets.HOSTED_DEMO_MIGRATION_DATABASE_URL'));
  assert.doesNotMatch(workflow, /pull_request_target:|GITHUB_ENV|GITHUB_OUTPUT|upload-artifact|vars\.CM_INT_RESTORE/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /group: hosted-shared-demo-database-initialize/);
  assert.match(workflow, /name: hosted-demo-initialize/);
});
