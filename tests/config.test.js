import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError, loadConfig, loadDatabaseConfig } from '../src/config.js';

const VALID_CSRF_SECRET = 'production-csrf-secret-at-least-32-bytes-long';
const VALID_AUDIT_SECRET = 'production-audit-hmac-secret-at-least-32-bytes';
const VALID_ENTRA_CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const VALID_ENTRA_CLIENT_SECRET = 'production-entra-client-secret-at-least-32-bytes';
const VALID_OIDC_SECRET = 'production-oidc-transaction-secret-at-least-32-bytes';
const PRODUCTION_BASE = Object.freeze({
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://example.com',
  DATABASE_URL: 'postgresql://db.example.com/conference_manager',
  DATABASE_SSL: 'verify-full',
  CSRF_SECRET: VALID_CSRF_SECRET,
  AUDIT_HMAC_SECRET: VALID_AUDIT_SECRET,
  ENTRA_CLIENT_ID: VALID_ENTRA_CLIENT_ID,
  ENTRA_CLIENT_SECRET: VALID_ENTRA_CLIENT_SECRET,
  OIDC_TRANSACTION_SECRET: VALID_OIDC_SECRET,
});

test('development configuration has safe bounded defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.publicOrigin, 'http://localhost:3000');
  assert.equal(config.port, 3000);
  assert.equal(config.maxBodyBytes, 65_536);
  assert.equal(config.databaseUrl, null);
  assert.equal(config.databaseSsl, 'disable');
  assert.equal(config.sessionTtlSeconds, 28_800);
  assert.equal(config.csrfSecret, null);
  assert.equal(config.auditHmacSecret, null);
  assert.equal(config.entraClientId, null);
  assert.equal(config.entraClientSecret, null);
  assert.equal(config.oidcTransactionSecret, null);
  assert.equal(config.entraAuthority, 'https://login.microsoftonline.com/organizations');
  assert.equal(config.entraRedirectUri, 'http://localhost:3000/api/v1/auth/microsoft/callback');
  assert.equal(config.oidcTransactionTtlSeconds, 600);
  assert.equal(config.serviceVersion, '0.1.0');
  assert.equal(config.buildId, 'local');
  assert.ok(Object.isFrozen(config));
});

test('any database-backed runtime requires a stable audit HMAC secret', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/conference_manager',
    }),
    (error) => error instanceof ConfigurationError && error.code === 'AUDIT_HMAC_SECRET_REQUIRED',
  );
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/conference_manager',
    AUDIT_HMAC_SECRET: VALID_AUDIT_SECRET,
  });
  assert.equal(config.databaseUrl, 'postgresql://localhost/conference_manager');
  assert.equal(config.auditHmacSecret, VALID_AUDIT_SECRET);
});

test('development and test reject partial Entra configuration', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', ENTRA_CLIENT_ID: VALID_ENTRA_CLIENT_ID }),
    (error) => error instanceof ConfigurationError && error.code === 'ENTRA_CLIENT_SECRET_REQUIRED',
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      ENTRA_CLIENT_ID: VALID_ENTRA_CLIENT_ID,
      ENTRA_CLIENT_SECRET: VALID_ENTRA_CLIENT_SECRET,
    }),
    (error) => error instanceof ConfigurationError && error.code === 'OIDC_TRANSACTION_SECRET_REQUIRED',
  );
});

test('production requires explicit HTTPS origin before database configuration', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (error) => {
    assert.ok(error instanceof ConfigurationError);
    return error.code === 'PUBLIC_ORIGIN_REQUIRED';
  });
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://example.com' }), (error) => {
    assert.ok(error instanceof ConfigurationError);
    return error.code === 'PUBLIC_ORIGIN_HTTPS_REQUIRED';
  });
});

test('production requires PostgreSQL, verified TLS, CSRF secret, and stable audit HMAC secret', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://example.com' }),
    (error) => error instanceof ConfigurationError && error.code === 'DATABASE_URL_REQUIRED',
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://db.example.com/conference_manager',
      DATABASE_SSL: 'disable',
    }),
    (error) => error instanceof ConfigurationError && error.code === 'DATABASE_SSL_REQUIRED',
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://db.example.com/conference_manager',
      DATABASE_SSL: 'verify-full',
    }),
    (error) => error instanceof ConfigurationError && error.code === 'CSRF_SECRET_REQUIRED',
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://db.example.com/conference_manager',
      DATABASE_SSL: 'verify-full',
      CSRF_SECRET: 'too-short',
    }),
    (error) => error instanceof ConfigurationError && error.code === 'CSRF_SECRET_INVALID',
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://db.example.com/conference_manager',
      DATABASE_SSL: 'verify-full',
      CSRF_SECRET: VALID_CSRF_SECRET,
    }),
    (error) => error instanceof ConfigurationError && error.code === 'AUDIT_HMAC_SECRET_REQUIRED',
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://db.example.com/conference_manager',
      DATABASE_SSL: 'verify-full',
      CSRF_SECRET: VALID_CSRF_SECRET,
      AUDIT_HMAC_SECRET: 'too-short',
    }),
    (error) => error instanceof ConfigurationError && error.code === 'AUDIT_HMAC_SECRET_INVALID',
  );

  const config = loadConfig({
    ...PRODUCTION_BASE,
    SERVICE_VERSION: '1.4.0',
    BUILD_ID: '20260824.1',
    SESSION_TTL_SECONDS: '3600',
  });
  assert.equal(config.databaseSsl, 'verify-full');
  assert.equal(config.csrfSecret, VALID_CSRF_SECRET);
  assert.equal(config.auditHmacSecret, VALID_AUDIT_SECRET);
  assert.equal(config.entraClientId, VALID_ENTRA_CLIENT_ID);
  assert.equal(config.entraClientSecret, VALID_ENTRA_CLIENT_SECRET);
  assert.equal(config.oidcTransactionSecret, VALID_OIDC_SECRET);
  assert.equal(config.sessionTtlSeconds, 3600);
  assert.equal(config.serviceVersion, '1.4.0');
  assert.equal(config.buildId, '20260824.1');
});

test('pilot and production require complete Entra OIDC configuration', () => {
  const complete = {
    ...PRODUCTION_BASE,
    SERVICE_VERSION: '1.0.0',
    BUILD_ID: 'build-1',
  };
  for (const [field, code] of [
    ['ENTRA_CLIENT_ID', 'ENTRA_CLIENT_ID_REQUIRED'],
    ['ENTRA_CLIENT_SECRET', 'ENTRA_CLIENT_SECRET_REQUIRED'],
    ['OIDC_TRANSACTION_SECRET', 'OIDC_TRANSACTION_SECRET_REQUIRED'],
  ]) {
    assert.throws(
      () => loadConfig({ ...complete, [field]: '' }),
      (error) => error instanceof ConfigurationError && error.code === code,
    );
  }
  assert.throws(
    () => loadConfig({ ...complete, ENTRA_CLIENT_ID: 'not-a-guid' }),
    (error) => error instanceof ConfigurationError && error.code === 'ENTRA_CLIENT_ID_INVALID',
  );
  assert.throws(
    () => loadConfig({ ...complete, OIDC_TRANSACTION_TTL_SECONDS: '901' }),
    (error) => error instanceof ConfigurationError && error.code === 'OIDC_TRANSACTION_TTL_SECONDS_INVALID',
  );
});

test('pilot and production require bounded support metadata', () => {
  assert.throws(
    () => loadConfig(PRODUCTION_BASE),
    (error) => error instanceof ConfigurationError && error.code === 'SERVICE_VERSION_REQUIRED',
  );
  assert.throws(
    () => loadConfig({ ...PRODUCTION_BASE, SERVICE_VERSION: '1.0.0' }),
    (error) => error instanceof ConfigurationError && error.code === 'BUILD_ID_REQUIRED',
  );
  assert.throws(
    () => loadConfig({ ...PRODUCTION_BASE, SERVICE_VERSION: '../unsafe', BUILD_ID: 'build-1' }),
    (error) => error instanceof ConfigurationError && error.code === 'SERVICE_VERSION_INVALID',
  );
  assert.throws(
    () => loadConfig({ ...PRODUCTION_BASE, SERVICE_VERSION: '1.0.0', BUILD_ID: 'build id' }),
    (error) => error instanceof ConfigurationError && error.code === 'BUILD_ID_INVALID',
  );
});

test('database URL rejects unsupported schemes, fragments, and connection-string overrides', () => {
  for (const databaseUrl of [
    'mysql://db.example.com/conference_manager',
    'postgresql://db.example.com/conference_manager#fragment',
    'postgresql://db.example.com/conference_manager?sslmode=disable',
  ]) {
    assert.throws(
      () => loadDatabaseConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }, 'test'),
      ConfigurationError,
    );
  }
});

test('public origin rejects paths, credentials, and unsupported schemes', () => {
  for (const origin of ['https://example.com/api', 'https://user:pass@example.com', 'ftp://example.com']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin }), ConfigurationError);
  }
});

test('numeric security and database limits reject malformed or unsafe values', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MAX_BODY_BYTES: '0' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MAX_RESPONSE_BYTES: '700000' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', RATE_LIMIT_MAX: 'not-a-number' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: '70000' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', SESSION_TTL_SECONDS: '299' }), ConfigurationError);
  assert.throws(() => loadDatabaseConfig({ NODE_ENV: 'test', DATABASE_POOL_MAX: '0' }, 'test'), ConfigurationError);
  assert.throws(
    () => loadDatabaseConfig({ NODE_ENV: 'test', DATABASE_STATEMENT_TIMEOUT_MS: '999999' }, 'test'),
    ConfigurationError,
  );
});
