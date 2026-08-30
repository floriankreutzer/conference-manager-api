import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPlatformConfig,
  PlatformConfigurationError,
} from '../src/platform/config.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PLATFORM_SERVICE_VERSION: '1.0.0',
    PLATFORM_BUILD_ID: 'saas3-release',
    PLATFORM_PUBLIC_ORIGIN: 'https://platform.example',
    PLATFORM_ENTRA_TENANT_ID: TENANT_ID,
    PLATFORM_ENTRA_CLIENT_ID: CLIENT_ID,
    PLATFORM_ENTRA_CLIENT_SECRET: 'P'.repeat(32),
    PLATFORM_ENTRA_AUTHORITY: `https://login.microsoftonline.com/${TENANT_ID}`,
    PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'cm-platform-mfa',
    PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT: 'cm-platform-step-up',
    PLATFORM_OIDC_TRANSACTION_SECRET: 'O'.repeat(32),
    PLATFORM_CSRF_SECRET: 'C'.repeat(32),
    PLATFORM_AUDIT_HMAC_SECRET: 'A'.repeat(32),
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: 'T'.repeat(32),
    PLATFORM_CURSOR_SECRET: 'R'.repeat(32),
    PLATFORM_DATABASE_URL: 'postgresql://platform@example-db.internal/platform',
    PLATFORM_DATABASE_SSL: 'verify-full',
    ...overrides,
  };
}

test('Platform production config keeps Platform and canonical Tenant audit credentials distinct', () => {
  const config = loadPlatformConfig(productionEnvironment());
  assert.equal(config.auditHmacSecret, 'A'.repeat(32));
  assert.equal(config.tenantAuditHmacSecret, 'T'.repeat(32));
  assert.notEqual(config.auditHmacSecret, config.tenantAuditHmacSecret);
  assert.equal(config.applicationName, 'conference-manager-platform-api');
  assert.equal(config.databasePoolMax, 10);
  assert.equal(config.readinessTimeoutMs, 1_000);
});

test('Platform config requires explicit environment injection and production Tenant audit custody', () => {
  assert.throws(
    () => loadPlatformConfig(),
    (error) => error instanceof PlatformConfigurationError && error.code === 'PLATFORM_ENV_REQUIRED',
  );
  assert.throws(
    () => loadPlatformConfig(productionEnvironment({ PLATFORM_TENANT_AUDIT_HMAC_SECRET: '' })),
    (error) => error.code === 'PLATFORM_TENANT_AUDIT_HMAC_SECRET_REQUIRED',
  );
});

test('Platform config rejects audit-key reuse across process and integrity domains', () => {
  assert.throws(
    () => loadPlatformConfig(productionEnvironment({
      AUDIT_HMAC_SECRET: 'T'.repeat(32),
    })),
    (error) => error.code === 'PLATFORM_TENANT_AUDIT_SECRET_ALIAS_FORBIDDEN',
  );
  assert.throws(
    () => loadPlatformConfig(productionEnvironment({
      PLATFORM_TENANT_AUDIT_HMAC_SECRET: 'A'.repeat(32),
    })),
    (error) => error.code === 'PLATFORM_AUDIT_DOMAIN_SECRET_ALIAS_FORBIDDEN',
  );
});

test('DB-backed development config also requires all stable persistence integrity keys', () => {
  assert.throws(
    () => loadPlatformConfig({
      NODE_ENV: 'development',
      PLATFORM_PUBLIC_ORIGIN: 'https://platform.example',
      PLATFORM_DATABASE_URL: 'postgresql://platform@example-db.internal/platform',
      PLATFORM_AUDIT_HMAC_SECRET: 'A'.repeat(32),
      PLATFORM_CURSOR_SECRET: 'R'.repeat(32),
    }),
    (error) => error.code === 'PLATFORM_PERSISTENCE_SECRETS_REQUIRED',
  );
});
