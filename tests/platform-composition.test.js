import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformComposition } from '../src/platform-composition.js';
import { loadPlatformConfig } from '../src/platform/config.js';

function secret(character) {
  return character.repeat(32);
}

function config() {
  return loadPlatformConfig({
    NODE_ENV: 'test',
    PLATFORM_PUBLIC_ORIGIN: 'https://platform.example.test',
    PLATFORM_ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    PLATFORM_ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    PLATFORM_ENTRA_CLIENT_SECRET: secret('a'),
    PLATFORM_ENTRA_AUTHORITY: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
    PLATFORM_OIDC_TRANSACTION_SECRET: secret('b'),
    PLATFORM_CSRF_SECRET: secret('c'),
    PLATFORM_AUDIT_HMAC_SECRET: secret('d'),
    PLATFORM_CURSOR_SECRET: secret('e'),
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: secret('f'),
    PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'platform-mfa',
    PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT: 'platform-step-up',
    PLATFORM_DATABASE_URL: 'postgresql://platform:credential@localhost:5432/platform',
    PLATFORM_DATABASE_SSL: 'disable',
  });
}

test('production Platform composition wires every HTTP service without opening a database connection', async () => {
  const composition = createPlatformComposition({ config: config() });
  try {
    assert.equal(typeof composition.process.start, 'function');
    assert.equal(typeof composition.process.stop, 'function');
    assert.equal(typeof composition.usageRecorder.recordRequestCreated, 'function');
    assert.equal(composition.config.applicationName, 'conference-manager-platform-api');
    assert.notEqual(composition.config.databaseUrl, process.env.DATABASE_URL);
  } finally {
    await composition.stop();
  }
});
