import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadNeonBrowserStorageConfig } from '../scripts/support/neon-browser-config.mjs';
import { ACCEPTANCE_BRANCH } from '../scripts/support/neon-acceptance-probe.mjs';

const env = { NODE_ENV: 'test', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  NEON_ACCEPTANCE_CONFIRM_BRANCH: ACCEPTANCE_BRANCH, NEON_ACCEPTANCE_ACCESS_KEY_ID: 'test-access-key',
  NEON_ACCEPTANCE_SECRET_ACCESS_KEY: 'test-only-secret-material', DEMO_DATABASE_SSL: 'disable',
  DEMO_CUSTOMER_DATABASE_URL: 'postgresql://cm_demo_customer_ci:local-test-password@127.0.0.1:5432/conference_manager_demo_ci' };

test('real storage application harness permits only its disposable loopback database', () => {
  assert.equal(loadNeonBrowserStorageConfig(env).bucket, 'conference-manager-media');
  for (const url of ['postgresql://role:password@production.invalid:5432/conference_manager_demo_ci',
    'postgresql://role:password@127.0.0.1:5432/conference_manager_demo_shared',
    'postgresql://role:password@127.0.0.1:5433/conference_manager_demo_ci',
    'postgresql://role:password@127.0.0.1:5432/conference_manager_demo_ci?host=production.invalid',
    'https://127.0.0.1:5432/conference_manager_demo_ci', 'invalid']) {
    for (const key of ['DEMO_CUSTOMER_DATABASE_URL', 'DEMO_PLATFORM_DATABASE_URL',
      'DEMO_RESET_DATABASE_URL', 'DEMO_MIGRATION_DATABASE_URL']) {
      assert.throws(() => loadNeonBrowserStorageConfig({ ...env, [key]: url }), /NEON_BROWSER_DATABASE_INVALID/);
    }
  }
  assert.throws(() => loadNeonBrowserStorageConfig({ ...env, DEMO_CUSTOMER_DATABASE_URL: undefined }));
  assert.throws(() => loadNeonBrowserStorageConfig({ ...env, DEMO_DATABASE_SSL: 'verify-full' }));
});

test('real application harness retains main-only branch and credential validation before provider allocation', () => {
  for (const change of [{ NODE_ENV: 'demo' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/pull' },
    { NEON_ACCEPTANCE_CONFIRM_BRANCH: 'br-production' }, { NEON_ACCEPTANCE_ACCESS_KEY_ID: undefined },
    { NEON_ACCEPTANCE_SECRET_ACCESS_KEY: undefined }]) {
    assert.throws(() => loadNeonBrowserStorageConfig({ ...env, ...change }));
  }
  const cli = spawnSync(process.execPath, ['scripts/demo-object-acceptance.mjs', 'seed'], {
    env: { ...process.env, ...env, GITHUB_REF: 'refs/heads/pull', CI_MEDIA_STORAGE_PROVIDER: 'neon' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /NEON_ACCEPTANCE_CONTEXT_INVALID/);
  assert.doesNotMatch(cli.stdout + cli.stderr, /test-only-secret-material|local-test-password/);
});

test('real browser workflow preserves both complete journeys and serializes provider custody', async () => {
  const workflow = await readFile('.github/workflows/neon-browser-acceptance.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /browser: chromium/);
  assert.match(workflow, /browser: webkit/);
  assert.match(workflow, /test:e2e:shared-demo/);
  assert.match(workflow, /test:e2e:saas37/);
  assert.match(workflow, /ref: b2ef694d68632a41ab135ce8a23749a1b9f06c4b/);
  assert.match(workflow,
    /node acceptance\/scripts\/copy-shared-acceptance\.mjs --source acceptance --target frontend --ref "\$ACCEPTANCE_REF"/);
  assert.doesNotMatch(workflow, /cp acceptance\/tests\/e2e-shared\/shared-demo-runtime\.spec\.js/);
  assert.equal(workflow.match(/CI_MEDIA_STORAGE_PROVIDER: neon/g)?.length, 2);
  assert.doesNotMatch(workflow, /pull_request:|push:|continue-on-error|createCiMediaStorageServer/);
});

test('inventory export refuses a production database and redacts invalid connection material', () => {
  const cli = spawnSync(process.execPath, ['scripts/neon-browser-inventory.mjs'], {
    env: { ...process.env, ...env,
      DEMO_MIGRATION_DATABASE_URL: 'postgresql://operator:private-password@production.invalid:5432/conference_manager_demo_ci' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr, 'NEON_BROWSER_INVENTORY_FAILED\n');
  assert.doesNotMatch(cli.stderr, /private-password|production.invalid/);
});
