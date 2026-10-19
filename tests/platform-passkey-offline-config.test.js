import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadPlatformPasskeyOfflineConfig } from '../src/operator/platform-passkey-offline-config.js';

const config = () => ({ NODE_ENV: 'pilot', DEPLOYMENT_ENVIRONMENT: 'int', PLATFORM_SECURITY_EPOCH: '8',
  PLATFORM_PASSKEY_OFFLINE_ROLE: 'cm_offline_owner', PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),
  PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: 'postgres://cm_offline_owner:x@db.example.com/cm_int',
  PLATFORM_DATABASE_URL: 'postgres://cm_runtime:y@db.example.com/cm_int' });

test('INT offline issuance fixes strict TLS, bounded pool, exact epoch and separate owner identity for the same database', () => {
  const loaded = loadPlatformPasskeyOfflineConfig(config());
  assert.equal(loaded.mode, 'pilot'); assert.equal(loaded.environment, 'int'); assert.equal(loaded.securityEpoch, 8);
  assert.equal(loaded.databaseSsl, 'verify-full'); assert.equal(loaded.databasePoolMax, 1);
  for (const change of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development' }, { DEPLOYMENT_ENVIRONMENT: 'prod' },
    { PLATFORM_SECURITY_EPOCH: '08' }, { PLATFORM_SECURITY_EPOCH: '0' }, { PLATFORM_SECURITY_EPOCH: '9007199254740992' },
    { PLATFORM_PASSKEY_OFFLINE_ROLE: 'cm_runtime' }, { PLATFORM_DATABASE_URL: undefined },
    { PLATFORM_DATABASE_URL: 'postgres://cm_offline_owner:y@db.example.com/cm_int' },
    { PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: config().PLATFORM_DATABASE_URL },
    { PLATFORM_DATABASE_URL: 'postgres://cm_runtime:y@other.example.com/cm_int' },
    { PLATFORM_DATABASE_URL: 'postgres://cm_runtime:y@db.example.com/cm_prod' },
    { PLATFORM_AUDIT_HMAC_SECRET: 'short' }, { AUDIT_HMAC_SECRET: config().PLATFORM_AUDIT_HMAC_SECRET }]) {
    assert.throws(() => loadPlatformPasskeyOfflineConfig({ ...config(), ...change }));
  }
});

test('offline entrypoint fails before descriptors or network on unsupported mode and never echoes configuration', () => {
  const result = spawnSync(process.execPath, ['scripts/platform-passkey-offline-grant.mjs'],
    { env: { PATH: process.env.PATH, NODE_ENV: 'test', PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: 'synthetic-private-config' },
      encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { status: 'failed', code: 'PLATFORM_PASSKEY_OFFLINE_CONFIGURATION_INVALID' });
  assert.doesNotMatch(result.stderr, /synthetic-private-config|postgres|stack|at file/);
});
