import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requirePlatformAuditActionsContext } from '../scripts/support/platform-audit-actions-context.mjs';

const expected = { environment: 'int', segmentId: 'ae000000-0000-4000-8000-000000000001',
  deploymentEpoch: 'ae000000-0000-4000-8000-000000000002', legacyEventCount: 124, inventoryDigest: 'a'.repeat(64) };
function context(operation = 'initialize') {
  return { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'floriankreutzer', GITHUB_TRIGGERING_ACTOR: 'floriankreutzer',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'b'.repeat(40), EXPECTED_MAIN_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF: 'floriankreutzer/conference-manager-api/.github/workflows/protected-int-audit-segment.yml@refs/heads/main',
    INT_AUDIT_OPERATION: operation, CM_INT_AUDIT_EXPECTED_JSON: JSON.stringify(expected),
    CM_INT_AUDIT_REQUEST_JSON: JSON.stringify(operation === 'initialize' ? { ...expected,
      approvalReference: 'test-approved', correlationId: 'ae000000-0000-4000-8000-000000000003' }
      : { environment: 'int', segmentId: expected.segmentId, securityEpoch: expected.deploymentEpoch }),
    CM_INT_AUDIT_RECOVERY_EVIDENCE: JSON.stringify({ sourceSha: 'b'.repeat(40), environment: 'int',
      deploymentEpoch: expected.deploymentEpoch, restoreReference: 'test-restore', custodyReference: 'test-custody',
      servicesClosed: true }),
    PLATFORM_AUDIT_SEGMENT_ID: expected.segmentId, PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH: expected.deploymentEpoch,
    PLATFORM_AUDIT_SEGMENT_LEGACY_EVENT_COUNT: '124', PLATFORM_AUDIT_SEGMENT_INVENTORY_DIGEST: expected.inventoryDigest };
}

test('Actions gate accepts each separate operation only with exact source, independent context and evidence references', () => {
  for (const operation of ['initialize', 'grants', 'customer_groups', 'microsoft_operations',
    'synthetic_microsoft', 'owner_customer', 'observability_reads']) {
    assert.equal(requirePlatformAuditActionsContext(context(operation)), operation);
  }
});

test('Actions gate refuses replay, other actors, source, debug logging, environment and malformed private metadata', () => {
  const invalid = [
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_WORKFLOW_REF: 'other' }, { EXPECTED_MAIN_SHA: 'c'.repeat(40) },
    { GITHUB_SHA: '' }, { INT_AUDIT_OPERATION: 'reset' }, { RUNNER_DEBUG: '1' }, { ACTIONS_STEP_DEBUG: 'true' },
    { ACTIONS_RUNNER_DEBUG: 'true' }, { CM_INT_AUDIT_REQUEST_JSON: 'PRIVATE_DETAIL' },
    { CM_INT_AUDIT_REQUEST_JSON: 'a'.repeat(4097) }, { CM_INT_AUDIT_EXPECTED_JSON: '{}' },
    { CM_INT_AUDIT_RECOVERY_EVIDENCE: '{}' }, { PLATFORM_AUDIT_SEGMENT_LEGACY_EVENT_COUNT: '0124' },
    { PLATFORM_AUDIT_SEGMENT_ID: expected.segmentId.toUpperCase() },
  ];
  for (const operation of ['initialize', 'grants', 'customer_groups', 'microsoft_operations',
    'synthetic_microsoft', 'owner_customer', 'observability_reads']) {
    for (const patch of invalid) assert.throws(() => requirePlatformAuditActionsContext({ ...context(operation), ...patch }),
      { message: 'PLATFORM_AUDIT_ACTIONS_REFUSED' });
    for (const patch of [{ sourceSha: 'c'.repeat(40) }, { environment: 'prod' }, { servicesClosed: false },
      { deploymentEpoch: expected.segmentId }, { custodyReference: '' }, { restoreReference: 'private\nvalue' }, { extra: true }]) {
      const env = context(operation);
      env.CM_INT_AUDIT_RECOVERY_EVIDENCE = JSON.stringify({ ...JSON.parse(env.CM_INT_AUDIT_RECOVERY_EVIDENCE), ...patch });
      assert.throws(() => requirePlatformAuditActionsContext(env), { message: 'PLATFORM_AUDIT_ACTIONS_REFUSED' });
    }
    const env = context(operation), request = JSON.parse(env.CM_INT_AUDIT_REQUEST_JSON);
    for (const patch of [{ segmentId: expected.deploymentEpoch }, { extra: true }]) {
      assert.throws(() => requirePlatformAuditActionsContext({ ...env,
        CM_INT_AUDIT_REQUEST_JSON: JSON.stringify({ ...request, ...patch }) }), { message: 'PLATFORM_AUDIT_ACTIONS_REFUSED' });
    }
  }
});

test('public workflow logs omit actual FD3 metadata and private CLI output; a refused gate never invokes a mutation', () => {
  const workflow = readFileSync('.github/workflows/protected-int-audit-segment.yml', 'utf8');
  const command = workflow.split('        run: |\n').at(-1).split('\n').map(line => line.slice(10)).join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'audit-actions-'));
  try {
    const marker = join(directory, 'invoked');
    const fake = join(directory, 'offline.mjs');
    writeFileSync(fake, `import {readFileSync,writeFileSync} from 'node:fs';
      const actual=JSON.parse(readFileSync(3,'utf8'));
      if (JSON.stringify(actual)!==process.env.CM_INT_AUDIT_REQUEST_JSON) process.exit(9);
      writeFileSync(process.env.TEST_MARKER,process.argv[2]);
      console.log('PRIVATE_CLI_RECEIPT');
      process.exit(Number(process.env.TEST_EXIT||0));\n`);
    writeFileSync(join(directory, 'node'), '#!/bin/bash\n' +
      'if [[ "$1" == scripts/platform-audit-actions-guard.mjs ]]; then exec "$REAL_NODE" "$@"; fi\n' +
      'exec "$REAL_NODE" "$TEST_OFFLINE" "$@"\n', { mode: 0o700 });
    for (const operation of ['initialize', 'grants', 'customer_groups', 'microsoft_operations',
    'synthetic_microsoft', 'owner_customer', 'observability_reads']) {
      const env = { ...context(operation), PATH: `${directory}:/usr/bin:/bin`, REAL_NODE: process.execPath,
        TEST_OFFLINE: fake, TEST_MARKER: marker };
      const result = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'PROTECTED_INT_AUDIT_OPERATION_SUCCEEDED\n');
      assert.equal(result.stderr, '');
      assert.match(readFileSync(marker, 'utf8'), operation === 'initialize' ? /segment-initialize/
        : operation === 'grants' ? /segment-runtime-grants/ : operation === 'customer_groups'
          ? /customer-microsoft-group-runtime-grants/ : operation === 'microsoft_operations'
            ? /platform-microsoft-operation-runtime-grants/ : operation === 'synthetic_microsoft'
              ? /synthetic-microsoft-custody-runtime-grants/ : operation === 'owner_customer'
                ? /owner-customer-custody-runtime-grants/ : /platform-observability-read-runtime-grants/);
      rmSync(marker);
      const failed = spawnSync('bash', ['-c', command], { env: { ...env, TEST_EXIT: '1' }, encoding: 'utf8' });
      assert.equal(failed.status, 1); assert.equal(failed.stdout, ''); rmSync(marker);
      const refused = spawnSync('bash', ['-c', command], { env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, encoding: 'utf8' });
      assert.equal(refused.status, 1); assert.equal(refused.stdout, '');
      assert.equal(refused.stderr, 'PLATFORM_AUDIT_ACTIONS_REFUSED\n'); assert.equal(existsSync(marker), false);
    }
    assert.doesNotMatch(workflow, /pull_request_target:|upload-artifact|GITHUB_ENV|GITHUB_OUTPUT|vars\.CM_INT_AUDIT/);
    assert.ok(workflow.indexOf('Require ordinary logging') < workflow.indexOf('secrets.CM_INT_AUDIT_HMAC_SECRET'));
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: \$\{\{ secrets\.CM_INT_AUDIT_OFFLINE_DATABASE_URL \}\}/);
    assert.doesNotMatch(workflow, /HOSTED_DEMO_.*DATABASE_URL/);
    assert.match(workflow, /group: hosted-shared-demo-database-initialize/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
