import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadDemoMediaStorageConfig, assertDemoPostgresStorageConfiguration } from '../src/demo/media-storage-config.js';
import { demoMediaStorageEnvironment, demoMediaStorageConfig, DEMO_MEDIA_TEST_HOST } from './support/demo-media-storage-environment.js';

function load(surface = 'customer', overrides = {}, mode = 'neon') {
  const env = demoMediaStorageEnvironment(surface, mode, overrides);
  return loadDemoMediaStorageConfig(env, { config: demoMediaStorageConfig(env, surface), surface });
}

test('normal Demo storage defaults to PostgreSQL and accepts explicitly cleared rollback settings', () => {
  for (const surface of ['customer', 'platform']) {
    for (const mode of [undefined, 'postgres']) {
      const settings = load(surface, {
        DEMO_MEDIA_STORAGE: mode,
        DEMO_MEDIA_STORAGE_BRANCH_ID: '',
        DEMO_MEDIA_STORAGE_DATABASE_HOST: '',
        DEMO_CUSTOMER_MEDIA_STORAGE_ACCESS_KEY_ID: '',
        DEMO_CUSTOMER_MEDIA_STORAGE_SECRET_ACCESS_KEY: '',
        DEMO_RESET_MEDIA_STORAGE_ACCESS_KEY_ID: '',
        DEMO_RESET_MEDIA_STORAGE_SECRET_ACCESS_KEY: '',
      }, 'postgres');
      assert.deepEqual(settings, { mode: 'postgres', storage: null });
      assert.equal(Object.isFrozen(settings), true);
    }
  }
});

test('explicit Neon configuration binds one exact Frankfurt branch/host and surface credential', () => {
  for (const surface of ['customer', 'platform']) {
    const settings = load(surface);
    assert.equal(settings.mode, 'neon');
    assert.equal(settings.branch, 'br-demo-media-test');
    assert.equal(settings.host, DEMO_MEDIA_TEST_HOST);
    assert.equal(settings.storage.endpoint, 'https://br-demo-media-test.storage.c-5.eu-central-1.aws.neon.tech');
    assert.equal(settings.storage.region, 'eu-central-1');
    assert.equal(settings.storage.bucket, 'conference-manager-media');
    assert.equal(settings.storage.accessKeyId, `synthetic-${surface === 'customer' ? 'customer' : 'reset'}-access-id`);
    assert.equal(Object.isFrozen(settings.storage), true);
  }
});

test('unknown modes and occupied unused PostgreSQL settings fail closed', () => {
  for (const mode of ['', 'objects', 'Neon', ' neon', 'memory', null]) {
    assert.throws(() => load('customer', { DEMO_MEDIA_STORAGE: mode }, 'postgres'), /DEMO_MEDIA_STORAGE_/);
  }
  for (const change of [
    { DEMO_MEDIA_STORAGE_BRANCH_ID: 'br-unused' },
    { DEMO_MEDIA_STORAGE_DATABASE_HOST: ' ' },
    { DEMO_CUSTOMER_MEDIA_STORAGE_ACCESS_KEY_ID: 'unused-access-id' },
    { DEMO_RESET_MEDIA_STORAGE_SECRET_ACCESS_KEY: 'unused-storage-secret' },
    { DEMO_MEDIA_STORAGE_ENDPOINT: 'https://arbitrary.invalid' },
  ]) assert.throws(() => load('customer', change, 'postgres'), /POSTGRES_CONFIGURATION_REQUIRED/);
});

test('Neon requires every binding/credential and rejects arbitrary endpoint, bucket, and foreign surface authority', () => {
  for (const surface of ['customer', 'platform']) {
    const scope = surface === 'customer' ? 'CUSTOMER' : 'RESET';
    for (const key of ['DEMO_MEDIA_STORAGE_BRANCH_ID', 'DEMO_MEDIA_STORAGE_DATABASE_HOST',
      `DEMO_${scope}_MEDIA_STORAGE_ACCESS_KEY_ID`, `DEMO_${scope}_MEDIA_STORAGE_SECRET_ACCESS_KEY`]) {
      for (const value of [undefined, '', ' ']) assert.throws(() => load(surface, { [key]: value }), /DEMO_MEDIA_STORAGE_/);
    }
    for (const change of [
      { DEMO_MEDIA_STORAGE_ENDPOINT: 'https://arbitrary.invalid' },
      { DEMO_MEDIA_STORAGE_BUCKET: 'public-bucket' },
      { DEMO_MEDIA_STORAGE_REGION: 'us-east-1' },
      { DEMO_PLATFORM_MEDIA_STORAGE_ACCESS_KEY_ID: 'unexpected-platform-authority' },
      { [`DEMO_${surface === 'customer' ? 'RESET' : 'CUSTOMER'}_MEDIA_STORAGE_SECRET_ACCESS_KEY`]: 'wrong-surface-secret' },
    ]) assert.throws(() => load(surface, change), /EXCESS_CONFIGURATION_FORBIDDEN/);
  }
});

test('Neon host and branch validation deny URL tricks, unverified TLS and test/production activation', () => {
  for (const branch of ['https://br-demo-media-test', 'br-demo-media-test/path', 'br-demo-media-test?query',
    'br-demo-media-test\n', 'BR-demo-media-test', '../branch']) {
    assert.throws(() => load('customer', { DEMO_MEDIA_STORAGE_BRANCH_ID: branch }), /BRANCH_INVALID/);
  }
  for (const host of ['127.0.0.1', 'db.demo.invalid', 'ep-demo-media-test.c-5.us-east-1.aws.neon.tech',
    'ep-other-test.c-5.eu-central-1.aws.neon.tech', `${DEMO_MEDIA_TEST_HOST}:5432`, `${DEMO_MEDIA_TEST_HOST}.attacker.invalid`]) {
    assert.throws(() => load('customer', { DEMO_MEDIA_STORAGE_DATABASE_HOST: host }), /DATABASE_BINDING_INVALID/);
  }
  assert.throws(() => load('customer', { NODE_ENV: 'test' }), /DATABASE_BINDING_INVALID/);
  assert.throws(() => load('customer', { NODE_ENV: 'test', DEMO_DATABASE_SSL: 'disable' }), /DATABASE_BINDING_INVALID/);
  assert.throws(() => load('customer', { NODE_ENV: 'production' }), /ENVIRONMENT_FORBIDDEN/);
});

test('Neon uses exact nonadministrative database principals and one canonical database', () => {
  const source = demoMediaStorageEnvironment('customer').DEMO_CUSTOMER_DATABASE_URL;
  for (const url of [source.replace('cm_demo_customer', 'cm_demo_reset'),
    source.replace('/conference_manager_demo_shared', '/conference_manager_demo_other'),
    source.replace(DEMO_MEDIA_TEST_HOST, `${DEMO_MEDIA_TEST_HOST}:6543`),
    `${source}?sslmode=disable`, `${source}#ignored`, source.replace('postgresql:', 'https:')]) {
    assert.throws(() => load('customer', { DEMO_CUSTOMER_DATABASE_URL: url }), /DEMO_(?:MEDIA_STORAGE_|CONFIG_)/);
  }
  const platform = demoMediaStorageEnvironment('platform');
  assert.throws(() => load('platform', {
    DEMO_PLATFORM_DATABASE_URL: platform.DEMO_PLATFORM_DATABASE_URL.replace('cm_demo_platform', 'cm_demo_customer'),
  }), /DATABASE_BINDING_INVALID/);
  assert.throws(() => load('platform', {
    DEMO_RESET_DATABASE_URL: platform.DEMO_RESET_DATABASE_URL.replace('cm_demo_reset', 'cm_demo_migration'),
  }), /DATABASE_BINDING_INVALID/);
});

test('storage credentials cannot alias runtime/database secrets or leak in validation failures', () => {
  for (const surface of ['customer', 'platform']) {
    const env = demoMediaStorageEnvironment(surface);
    const scope = surface === 'customer' ? 'CUSTOMER' : 'RESET';
    const secretKey = `DEMO_${scope}_MEDIA_STORAGE_SECRET_ACCESS_KEY`;
    const aliases = [env[`DEMO_${surface.toUpperCase()}_SESSION_SECRET`], env.DEMO_TENANT_AUDIT_HMAC_SECRET,
      env[`DEMO_${scope}_MEDIA_STORAGE_ACCESS_KEY_ID`], `synthetic-${scope.toLowerCase()}-db`];
    for (const alias of aliases) assert.throws(() => load(surface, { [secretKey]: alias }), /SECRET_ALIAS_FORBIDDEN/);
    const sensitive = 'synthetic credential with whitespace';
    assert.throws(() => load(surface, { [secretKey]: sensitive }), (error) => {
      assert.equal(error.code, 'DEMO_MEDIA_STORAGE_CREDENTIAL_INVALID');
      assert.equal(String(error).includes(sensitive), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('the PostgreSQL operator reset refuses configured Neon before parsing credentials or connecting', () => {
  assertDemoPostgresStorageConfiguration({ DEMO_MEDIA_STORAGE: 'postgres', DEMO_MEDIA_STORAGE_BRANCH_ID: '' });
  assert.throws(() => assertDemoPostgresStorageConfiguration({ DEMO_MEDIA_STORAGE: 'neon' }),
    /POSTGRES_CONFIGURATION_REQUIRED/);
  const result = spawnSync(process.execPath, ['scripts/demo-reset.mjs'], {
    env: { NODE_ENV: 'test', DEMO_MEDIA_STORAGE: 'neon' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr.trim());
  assert.equal(failure.code, 'DEMO_MEDIA_STORAGE_POSTGRES_CONFIGURATION_REQUIRED');
});
