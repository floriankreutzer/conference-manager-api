import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadNeonRecoveryConfig, assertNeonRecoveryIdentity, RECOVERY_ROOT,
  RECOVERY_SNAPSHOT, RECOVERY_MANIFEST } from '../scripts/support/neon-recovery-config.mjs';

const host = 'ep-recovery-test.c-5.eu-central-1.aws.neon.tech';
const branch = 'br-disposable-recovery';
const env = { NODE_ENV: 'test', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  NEON_RECOVERY_BRANCH: branch, NEON_RECOVERY_HOST: host, DEMO_DATABASE_SSL: 'verify-full',
  NEON_RECOVERY_ACCESS_KEY_ID: 'test-access', NEON_RECOVERY_SECRET_ACCESS_KEY: 'test-only-secret-material',
  DEMO_CUSTOMER_DATABASE_URL: `postgresql://cm_demo_customer:private-test-password@${host}/conference_manager_demo_shared` };

test('recovery destination guard denies preserved branches, production, insecure TLS and URL overrides', () => {
  assert.equal(loadNeonRecoveryConfig(env).storage.endpoint, `https://${branch}.storage.c-5.eu-central-1.aws.neon.tech`);
  for (const change of [{ NEON_RECOVERY_BRANCH: RECOVERY_ROOT }, { NEON_RECOVERY_BRANCH: 'br-summer-rice-b1f8voyp' },
    { NEON_RECOVERY_BRANCH: 'br-falling-glade-b17oqqiv' }, { NEON_RECOVERY_BRANCH: undefined },
    { NEON_RECOVERY_HOST: 'ep-solitary-thunder-b1ydpuiq.c-5.eu-central-1.aws.neon.tech' },
    { NEON_RECOVERY_HOST: 'attacker.invalid' }, { DEMO_DATABASE_SSL: 'disable' }, { GITHUB_REF: 'refs/heads/pull' },
    { GITHUB_ACTIONS: 'false' }, { NODE_ENV: 'demo' }, { GITHUB_SHA: undefined }]) {
    assert.throws(() => loadNeonRecoveryConfig({ ...env, ...change }));
  }
  for (const url of [env.DEMO_CUSTOMER_DATABASE_URL + '?options=host%3Devil.invalid',
    env.DEMO_CUSTOMER_DATABASE_URL + '#fragment', env.DEMO_CUSTOMER_DATABASE_URL.replace(host, '127.0.0.1'),
    env.DEMO_CUSTOMER_DATABASE_URL.replace('cm_demo_customer:', 'cm_demo_migration:'),
    env.DEMO_CUSTOMER_DATABASE_URL.replace('/conference_manager_demo_shared', '/postgres')]) {
    assert.throws(() => loadNeonRecoveryConfig({ ...env, DEMO_CUSTOMER_DATABASE_URL: url }));
  }
});

test('independent role passwords are required and errors do not contain credentials', () => {
  assert.throws(() => loadNeonRecoveryConfig({ ...env,
    DEMO_RESET_DATABASE_URL: env.DEMO_CUSTOMER_DATABASE_URL.replace('cm_demo_customer:', 'cm_demo_reset:') }),
  (error) => error.message === 'NEON_RECOVERY_DATABASE_INVALID');
});

const now = 1_000_000;
const marker = { branch_id: branch, source_branch_id: RECOVERY_ROOT, snapshot_id: RECOVERY_SNAPSHOT,
  object_manifest_sha256: RECOVERY_MANIFEST, created_at: new Date(now - 1000), expires_at: new Date(now + 59_000) };
function client(identity = { role: 'cm_demo_customer', database: 'conference_manager_demo_shared' }, rows = [marker],
  relations = [{ kind: 'v', owner: 'cm_demo_migration' }]) {
  const queries = [];
  return { queries, async query(sql) {
    queries.push(sql);
    if (sql.startsWith('SELECT current_user')) return { rows: [identity] };
    if (sql.includes('pg_catalog.pg_class')) return { rows: relations };
    return { rows };
  } };
}

test('recovery rejects non-view and foreign-owned markers before reading their contents', async () => {
  for (const relations of [[], [{ kind: 'r', owner: 'cm_demo_migration' }],
    [{ kind: 'm', owner: 'cm_demo_migration' }], [{ kind: 'f', owner: 'cm_demo_migration' }],
    [{ kind: 'v', owner: 'cm_demo_customer' }], [{ kind: 'v', owner: 'postgres' }]]) {
    const database = client(undefined, [marker], relations);
    await assert.rejects(assertNeonRecoveryIdentity(database, 'cm_demo_customer', branch, now),
      /NEON_RECOVERY_MARKER_INVALID/);
    assert.equal(database.queries.some((sql) => sql.includes('FROM public.neon_recovery_acceptance')), false);
  }
});

test('live recovery marker binds database, principal, branch, snapshot, bytes and maximum lifetime', async () => {
  assert.equal(await assertNeonRecoveryIdentity(client(), 'cm_demo_customer', branch, now), now + 59_000);
  for (const change of [{ branch_id: 'br-foreign' }, { source_branch_id: 'br-foreign' },
    { snapshot_id: 'snap-foreign' }, { object_manifest_sha256: 'b'.repeat(64) },
    { created_at: new Date(now + 1) }, { expires_at: new Date(now) },
    { expires_at: new Date(now + 60 * 60_000) }, { expires_at: 'invalid' }]) {
    await assert.rejects(assertNeonRecoveryIdentity(client(undefined, [{ ...marker, ...change }]),
      'cm_demo_customer', branch, now), /NEON_RECOVERY_MARKER_INVALID/);
  }
  await assert.rejects(assertNeonRecoveryIdentity(client(undefined, []), 'cm_demo_customer', branch, now));
  await assert.rejects(assertNeonRecoveryIdentity(client(undefined, [marker, marker]), 'cm_demo_customer', branch, now));
  await assert.rejects(assertNeonRecoveryIdentity(client({ role: 'cm_demo_migration', database: 'postgres' }),
    'cm_demo_customer', branch, now), /NEON_RECOVERY_IDENTITY_INVALID/);
});

test('invalid recovery entrypoint fails before provider allocation without printing secrets', () => {
  const result = spawnSync(process.execPath, ['scripts/neon-recovery-acceptance.mjs', 'customer'], {
    env: { ...process.env, ...env, NEON_RECOVERY_BRANCH: RECOVERY_ROOT }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'NEON_RECOVERY_ACCEPTANCE_FAILED\n');
});

test('recovery workflow preserves both immutable full browser contracts and does not reseed before preflight', async () => {
  const workflow = await readFile('.github/workflows/neon-recovery-acceptance.yml', 'utf8');
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /ref: b63d0461c857ee132242fb4509156409a37496a3/);
  assert.match(workflow,
    /node acceptance\/scripts\/copy-shared-acceptance\.mjs --source acceptance --target frontend --ref "\$ACCEPTANCE_REF"/);
  assert.doesNotMatch(workflow, /cp acceptance\/tests\/e2e-shared\/shared-demo-runtime\.spec\.js/);
  assert.equal(workflow.match(/npm run test:e2e:shared-demo/g)?.length, 2);
  assert.equal(workflow.match(/npm run test:e2e:saas37/g)?.length, 2);
  assert.match(workflow, /neon-recovery-acceptance.mjs preflight/);
  assert.match(workflow, /neon-recovery-acceptance.mjs rollback/);
  assert.match(workflow, /neon-recovery-acceptance.mjs inventory/);
  assert.match(workflow, /^            api\/neon-recovery-preflight-failure\.json$/m);
  assert.doesNotMatch(workflow, /pull_request:|push:|continue-on-error|db:migrate|provision-shared-demo-ci|\bmjs seed\b/);
});
