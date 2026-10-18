import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTargetRuntimeConfig } from '../scripts/support/target-load-runtime-config.mjs';

import { RUN, SHA, NOW, targetLoadEnvironment as env } from './support/target-load-environment.js';

test('target config uses canonical production contracts with verified TLS and separate surface authority', () => {
  const customer = loadTargetRuntimeConfig(env(), NOW);
  assert.equal(customer.config.mode, 'production'); assert.equal(customer.config.databaseSsl, 'verify-full');
  assert.equal(new URL(customer.config.databaseUrl).search, ''); assert.equal(customer.config.rateLimitMax, 120);
  assert.equal(customer.config.databasePoolMax, 10); assert.equal(customer.storageConfig.bucket, `saas38-load-${RUN}`);
  assert.equal(customer.config.buildId, SHA); assert.equal(customer.config.host, '0.0.0.0');
  const platform = loadTargetRuntimeConfig(env('platform'), NOW);
  assert.equal(platform.config.mode, 'production'); assert.equal(platform.config.databaseSsl, 'verify-full');
  assert.equal(platform.config.databasePoolMax, 4); assert.equal(platform.storageConfig, null);
  assert.notEqual(platform.config.auditHmacSecret, platform.config.tenantAuditHmacSecret);
  assert.notEqual(platform.config.auditHmacSecret, customer.config.auditHmacSecret);
  assert.notEqual(customer.config.databaseUrl, platform.config.databaseUrl);
  const representative = loadTargetRuntimeConfig({ ...env(), LOAD_RATE_PROFILE: 'representative1000' }, NOW);
  assert.equal(representative.config.rateLimitMax, 1000); assert.equal(representative.profile, 'representative1000');
  assert.match(loadTargetRuntimeConfig({ ...env(), LOAD_STORAGE_CLUSTER: '7' }, NOW).storageConfig.endpoint,
    /\.storage\.c-7\.eu-central-1\.aws\.neon\.tech$/);
  assert.match(loadTargetRuntimeConfig({ ...env(), LOAD_STORAGE_CLUSTER: '8' }, NOW).storageConfig.endpoint,
    /\.storage\.c-8\.eu-central-1\.aws\.neon\.tech$/);
});

test('target config rejects production aliases, swapped surface secrets, mutable builds and insecure destinations safely', () => {
  const changes = [{ DATABASE_URL: 'private-existing-database' }, { PLATFORM_DATABASE_URL: 'private-existing-database' },
    { DEMO_CUSTOMER_DATABASE_URL: 'private-existing-database' }, { ENTRA_CLIENT_SECRET: 'private-provider-secret' },
    { LOAD_CURSOR_SECRET: 'private-platform-secret' }, { LOAD_TENANT_AUDIT_HMAC_SECRET: 'private-platform-secret' },
    { RENDER: undefined }, { RENDER_GIT_COMMIT: 'b'.repeat(40) }, { RENDER_GIT_BRANCH: 'unmerged' },
    { RENDER_GIT_REPO_SLUG: 'foreign/repository' }, { RENDER_SERVICE_NAME: 'conference-manager-demo' },
    { LOAD_RATE_PROFILE: 'unbounded' }, { LOAD_PUBLIC_ORIGIN: 'http://private.invalid' },
    { LOAD_STORAGE_PROBE_JSON: undefined }, { LOAD_STORAGE_PROBE_JSON: '{\"url\":\"https://private.invalid\"}' },
    { LOAD_CSRF_SECRET: undefined }, { LOAD_AUDIT_HMAC_SECRET: undefined },
    { LOAD_STORAGE_CLUSTER: '0' }, { LOAD_STORAGE_CLUSTER: '7/redirect' },
    { LOAD_DATABASE_URL: env().LOAD_DATABASE_URL.replace('verify-full', 'require') }];
  for (const change of changes) assert.throws(() => loadTargetRuntimeConfig({ ...env(), ...change }, NOW),
    /^Error: LOAD_RUNTIME_CONFIG_INVALID$/);
  assert.throws(() => loadTargetRuntimeConfig({ ...env('platform'), LOAD_STORAGE_SECRET_ACCESS_KEY: 'private-storage-secret' }, NOW),
    /^Error: LOAD_RUNTIME_CONFIG_INVALID$/);
  assert.throws(() => loadTargetRuntimeConfig({ ...env('platform'), LOAD_STORAGE_CLUSTER: '7' }, NOW),
    /^Error: LOAD_RUNTIME_CONFIG_INVALID$/);
  assert.throws(() => loadTargetRuntimeConfig(env(), NOW + 60_000), /^Error: LOAD_RUNTIME_CONFIG_INVALID$/);
  const aliased = env('platform'); aliased.LOAD_TENANT_AUDIT_HMAC_SECRET = aliased.LOAD_AUDIT_HMAC_SECRET;
  assert.throws(() => loadTargetRuntimeConfig(aliased, NOW), /^Error: LOAD_RUNTIME_CONFIG_INVALID$/);
});
