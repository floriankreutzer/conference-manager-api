import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError, loadConfig, loadDatabaseConfig } from '../src/config.js';

test('development configuration has safe bounded defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.publicOrigin, 'http://localhost:3000');
  assert.equal(config.port, 3000);
  assert.equal(config.maxBodyBytes, 65_536);
  assert.equal(config.databaseUrl, null);
  assert.equal(config.databaseSsl, 'disable');
  assert.ok(Object.isFrozen(config));
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

test('production requires PostgreSQL and certificate-verifying TLS', () => {
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

  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://example.com',
    DATABASE_URL: 'postgresql://db.example.com/conference_manager',
    DATABASE_SSL: 'verify-full',
  });
  assert.equal(config.databaseSsl, 'verify-full');
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
  assert.throws(() => loadConfig({ NODE_ENV: 'test', RATE_LIMIT_MAX: 'not-a-number' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: '70000' }), ConfigurationError);
  assert.throws(() => loadDatabaseConfig({ NODE_ENV: 'test', DATABASE_POOL_MAX: '0' }, 'test'), ConfigurationError);
  assert.throws(
    () => loadDatabaseConfig({ NODE_ENV: 'test', DATABASE_STATEMENT_TIMEOUT_MS: '999999' }, 'test'),
    ConfigurationError,
  );
});
