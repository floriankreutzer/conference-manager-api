import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError, loadConfig } from '../src/config.js';

test('development configuration has safe bounded defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.publicOrigin, 'http://localhost:3000');
  assert.equal(config.port, 3000);
  assert.equal(config.maxBodyBytes, 65_536);
  assert.ok(Object.isFrozen(config));
});

test('production requires an explicit HTTPS public origin', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (error) => {
    assert.ok(error instanceof ConfigurationError);
    return error.code === 'PUBLIC_ORIGIN_REQUIRED';
  });
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://example.com' }), (error) => {
    assert.ok(error instanceof ConfigurationError);
    return error.code === 'PUBLIC_ORIGIN_HTTPS_REQUIRED';
  });
});

test('public origin rejects paths, credentials, and unsupported schemes', () => {
  for (const origin of ['https://example.com/api', 'https://user:pass@example.com', 'ftp://example.com']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin }), ConfigurationError);
  }
});

test('numeric security limits reject malformed or unsafe values', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MAX_BODY_BYTES: '0' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', RATE_LIMIT_MAX: 'not-a-number' }), ConfigurationError);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: '70000' }), ConfigurationError);
});
