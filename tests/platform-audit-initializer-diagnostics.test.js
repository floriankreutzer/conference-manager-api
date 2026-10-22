import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const config = () => ({ PATH: process.env.PATH, NODE_ENV: 'pilot', DEPLOYMENT_ENVIRONMENT: 'int',
  PLATFORM_SECURITY_EPOCH: '2', PLATFORM_PASSKEY_OFFLINE_ROLE: 'cm_offline_owner',
  PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: 'postgres://cm_offline_owner:private-canary@db.example.com/cm_int',
  PLATFORM_DATABASE_URL: 'postgres://cm_runtime:private-canary@db.example.com/cm_int',
  PLATFORM_AUDIT_HMAC_SECRET: 'private-signing-canary'.repeat(3) });

test('initializer refusals identify only fixed pre-network stages and never forward private values or exception text', () => {
  const cases = [
    ['MODE', { NODE_ENV: 'test' }],
    ['OWNER_CONFIGURATION', { PLATFORM_PASSKEY_OFFLINE_ROLE: 'INVALID-private-canary' }],
    ['DATABASE_URL', { PLATFORM_DATABASE_URL: 'private-canary' }],
    ['DATABASE_BINDING', { PLATFORM_DATABASE_URL: 'postgres://cm_runtime:private-canary@foreign.example.com/cm_int' }],
    ['SECURITY_REVISION', { PLATFORM_SECURITY_EPOCH: '0' }],
    ['SIGNING_KEY', { PLATFORM_AUDIT_HMAC_SECRET: 'private-canary' }],
    ['CONFIGURATION', { PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: 'postgres://%xx:private-canary@db.example.com/cm_int' }],
    ['REQUEST', {}],
  ];
  for (const [stage, patch] of cases) {
    const result = spawnSync(process.execPath, ['scripts/platform-audit-segment-initialize.mjs'],
      { env: { ...config(), ...patch }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, stage);
    assert.equal(result.stdout, '', stage);
    assert.equal(result.stderr, `PLATFORM_AUDIT_SEGMENT_INITIALIZATION_REFUSED\nPLATFORM_AUDIT_STAGE_${stage}_REFUSED\n`);
    assert.doesNotMatch(result.stderr, /private-canary|private-signing|postgres|example\.com|at file|URIError/);
  }
  const argumentsRefusal = spawnSync(process.execPath, ['scripts/platform-audit-segment-initialize.mjs', 'private-canary'],
    { env: config(), encoding: 'utf8', timeout: 5000 });
  assert.equal(argumentsRefusal.status, 1);
  assert.equal(argumentsRefusal.stdout, '');
  assert.equal(argumentsRefusal.stderr,
    'PLATFORM_AUDIT_SEGMENT_INITIALIZATION_REFUSED\nPLATFORM_AUDIT_STAGE_ARGUMENTS_REFUSED\n');
});
