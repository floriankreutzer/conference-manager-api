import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requirePlatformOwnerActionsContext,requirePlatformOwnerRolesActionsContext }
  from '../scripts/support/platform-owner-actions-context.mjs';

const deploymentEpoch = 'a1000000-0000-4000-8000-000000000001';
const segmentId = 'a1000000-0000-4000-8000-000000000002';
const directoryId = 'a1000000-0000-4000-8000-000000000003';
const subjectId = 'a1000000-0000-4000-8000-000000000004';
function context(kind='bootstrap') {
  const env={ GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'floriankreutzer', GITHUB_TRIGGERING_ACTOR: 'floriankreutzer',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'b'.repeat(40), EXPECTED_MAIN_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF: 'floriankreutzer/conference-manager-api/.github/workflows/protected-int-first-owner.yml@refs/heads/main',
    PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID: directoryId, PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID: subjectId,
    PLATFORM_OWNER_BOOTSTRAP_DEPLOYMENT_EPOCH: deploymentEpoch, PLATFORM_AUDIT_SEGMENT_ID: segmentId,
    PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH: deploymentEpoch,
    CM_INT_OWNER_REQUEST_JSON: JSON.stringify({ environment: 'int', deploymentEpoch, directoryId, subjectId,
      approvalReference: 'synthetic-owner-approval', correlationId: 'a1000000-0000-4000-8000-000000000005' }),
    CM_INT_OWNER_EVIDENCE: JSON.stringify({ sourceSha: 'b'.repeat(40), environment: 'int', deploymentEpoch,
      segmentId, identityReference: 'synthetic-identity-evidence', servicesClosed: true }) };
  if (kind==='roles') {
    env.GITHUB_WORKFLOW_REF=env.GITHUB_WORKFLOW_REF.replace('protected-int-first-owner.yml','protected-int-owner-roles.yml');
    env.CM_INT_OWNER_REQUEST_JSON=JSON.stringify({ ...JSON.parse(env.CM_INT_OWNER_REQUEST_JSON),expectedSecurityVersion: 6 });
  }
  return env;
}

for (const kind of ['bootstrap','roles']) {
const guard=kind==='roles' ? requirePlatformOwnerRolesActionsContext : requirePlatformOwnerActionsContext;
test(`${kind} Actions context requires exact independent identity, source, deployment and evidence binding`, () => {
  assert.equal(guard(context(kind)), true);
  for (const patch of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_REF: 'refs/tags/release' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_WORKFLOW_REF: 'other' },
    { GITHUB_REPOSITORY: 'other/repository' }, { EXPECTED_MAIN_SHA: 'c'.repeat(40) }, { RUNNER_DEBUG: '1' },
    { ACTIONS_STEP_DEBUG: 'true' }, { ACTIONS_RUNNER_DEBUG: 'true' }, { NODE_OPTIONS: 'private-canary' },
    { PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID: subjectId }, { PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID: directoryId },
    { PLATFORM_OWNER_BOOTSTRAP_DEPLOYMENT_EPOCH: segmentId }, { PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH: segmentId },
    { PLATFORM_AUDIT_SEGMENT_ID: deploymentEpoch }, { CM_INT_OWNER_REQUEST_JSON: 'private-canary' },
    { CM_INT_OWNER_REQUEST_JSON: 'a'.repeat(4097) }, { CM_INT_OWNER_EVIDENCE: '{}' }]) {
    assert.throws(() => guard({ ...context(kind), ...patch }),
      { message: 'PLATFORM_OWNER_ACTIONS_REFUSED' });
  }
  for (const patch of [{ sourceSha: 'c'.repeat(40) }, { environment: 'prod' }, { servicesClosed: false },
    { deploymentEpoch: segmentId }, { segmentId: deploymentEpoch }, { identityReference: '' },
    { identityReference: 'private\ncanary' }, { extra: true }]) {
    const env = context(kind);
    env.CM_INT_OWNER_EVIDENCE = JSON.stringify({ ...JSON.parse(env.CM_INT_OWNER_EVIDENCE), ...patch });
    assert.throws(() => guard(env), { message: 'PLATFORM_OWNER_ACTIONS_REFUSED' });
  }
  for (const patch of [{ directoryId: subjectId }, { subjectId: directoryId }, { environment: 'dev' },
    { deploymentEpoch: segmentId }, { roles: ['platform_security_admin'] }, { correlationId: 'private-canary' }]) {
    const env = context(kind);
    env.CM_INT_OWNER_REQUEST_JSON = JSON.stringify({ ...JSON.parse(env.CM_INT_OWNER_REQUEST_JSON), ...patch });
    assert.throws(() => guard(env), { message: 'PLATFORM_OWNER_ACTIONS_REFUSED' });
  }
});

test(`${kind} workflow keeps identity on FD3, suppresses CLI receipts and refuses before invoking a writer`, () => {
  const name=kind==='roles' ? 'protected-int-owner-roles.yml' : 'protected-int-first-owner.yml';
  const guardScript=kind==='roles' ? 'platform-owner-roles-actions-guard.mjs' : 'platform-owner-actions-guard.mjs';
  const workflow=readFileSync(`.github/workflows/${name}`,'utf8');
  const command = workflow.split('        run: |\n').at(-1).split('\n').map(line => line.slice(10)).join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'first-owner-actions-'));
  try {
    const marker = join(directory, 'invoked');
    const fake = join(directory, 'offline.mjs');
    writeFileSync(fake, `import {readFileSync,writeFileSync} from 'node:fs';
      const actual=JSON.parse(readFileSync(3,'utf8'));
      if (JSON.stringify(actual)!==process.env.CM_INT_OWNER_REQUEST_JSON) process.exit(9);
      writeFileSync(process.env.TEST_MARKER,'invoked');
      console.log('PRIVATE_OPERATOR_RECEIPT');
      process.exit(Number(process.env.TEST_EXIT||0));\n`);
    writeFileSync(join(directory, 'node'), '#!/bin/bash\n' +
      `if [[ "$1" == scripts/${guardScript} ]]; then exec "$REAL_NODE" "$@"; fi\n` +
      'exec "$REAL_NODE" "$TEST_OFFLINE" "$@"\n', { mode: 0o700 });
    const env = { ...context(kind), PATH: `${directory}:/usr/bin:/bin`, REAL_NODE: process.execPath,
      TEST_OFFLINE: fake, TEST_MARKER: marker };
    const success = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout,kind==='roles'
      ? 'PROTECTED_INT_OWNER_ROLES_SUCCEEDED\n' : 'PROTECTED_INT_FIRST_OWNER_SUCCEEDED\n');
    assert.equal(success.stderr, ''); assert.equal(existsSync(marker), true); rmSync(marker);
    const failed = spawnSync('bash', ['-c', command], { env: { ...env, TEST_EXIT: '1' }, encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(failed.stdout, ''); rmSync(marker);
    const refused = spawnSync('bash', ['-c', command], { env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, encoding: 'utf8' });
    assert.equal(refused.status, 1); assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, 'PLATFORM_OWNER_ACTIONS_REFUSED\n'); assert.equal(existsSync(marker), false);
    assert.doesNotMatch(workflow, /pull_request_target:|upload-artifact|GITHUB_ENV|GITHUB_OUTPUT|vars\.CM_INT_OWNER/);
    assert.ok(workflow.indexOf('Require ordinary logging') < workflow.indexOf('secrets.CM_INT_AUDIT_HMAC_SECRET'));
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: \$\{\{ secrets\.CM_INT_AUDIT_OFFLINE_DATABASE_URL \}\}/);
    assert.doesNotMatch(workflow, /HOSTED_DEMO_.*DATABASE_URL/);
    assert.match(workflow, /group: hosted-shared-demo-database-initialize/);
    assert.doesNotMatch(workflow, /platform-passkey-offline-grant|db-migrate|demo-reset|start:protected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

}

test('one-time owner role upgrade refuses missing or malformed versions and foreign workflow authority before execution',()=>{
  for (const expectedSecurityVersion of [undefined,0,-1,1.5,'6',Number.MAX_SAFE_INTEGER+1]) {
    const env=context('roles');env.CM_INT_OWNER_REQUEST_JSON=JSON.stringify({
      ...JSON.parse(env.CM_INT_OWNER_REQUEST_JSON),expectedSecurityVersion });
    assert.throws(()=>requirePlatformOwnerRolesActionsContext(env),{ message: 'PLATFORM_OWNER_ACTIONS_REFUSED' });
  }
  assert.throws(()=>requirePlatformOwnerRolesActionsContext(context()),{ message: 'PLATFORM_OWNER_ACTIONS_REFUSED' });
  assert.throws(()=>requirePlatformOwnerActionsContext(context('roles')),{ message: 'PLATFORM_OWNER_ACTIONS_REFUSED' });
});
