import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  encodeGitHubActionsCommandData,
  registerGitHubActionsSecretMasks,
  sensitiveGitHubActionsEnvironmentValues,
  serializeGitHubActionsEnvironment,
} from '../scripts/github-actions-command-files.mjs';

test('GitHub Actions secret masks escape command data and reject unsafe values', () => {
  assert.equal(
    encodeGitHubActionsCommandData('percent%\r\nvalue'),
    'percent%25%0D%0Avalue',
  );
  const writes = [];
  registerGitHubActionsSecretMasks(
    ['first-secret', 'line\r\n::warning::secret', 'first-secret'],
    { write: (chunk) => writes.push(chunk) },
  );
  assert.deepEqual(writes, [
    '::add-mask::first-secret\n',
    '::add-mask::line%0D%0A::warning::secret\n',
  ]);
  for (const [values, options] of [
    [null, { write: () => {} }],
    [[], { write: () => {} }],
    [[''], { write: () => {} }],
    [[null], { write: () => {} }],
    [['unsafe\0value'], { write: () => {} }],
    [['value'], { write: null }],
  ]) {
    assert.throws(
      () => registerGitHubActionsSecretMasks(values, options),
      /GITHUB_ACTIONS_(?:MASK_VALUES|MASK_VALUE)_INVALID/,
    );
  }
});

test('GitHub Actions environment output is single-line and identifies every secret class', () => {
  const variables = {
    NODE_ENV: 'test',
    DEMO_CUSTOMER_DATABASE_URL: 'postgresql://user:password@localhost/database',
    DEMO_PLATFORM_DATABASE_URL: 'postgresql://platform:password@localhost/database',
    DEMO_RESET_DATABASE_URL: 'postgresql://reset:password@localhost/database',
    DEMO_MIGRATION_DATABASE_URL: 'postgresql://migration:password@localhost/database',
    DEMO_CUSTOMER_SESSION_SECRET: 'customer-session-secret',
    DEMO_CUSTOMER_CSRF_SECRET: 'customer-csrf-secret',
    DEMO_PLATFORM_SESSION_SECRET: 'platform-session-secret',
    DEMO_PLATFORM_CSRF_SECRET: 'platform-csrf-secret',
    DEMO_TENANT_AUDIT_HMAC_SECRET: 'audit-secret',
  };
  assert.deepEqual(sensitiveGitHubActionsEnvironmentValues(variables), [
    variables.DEMO_CUSTOMER_DATABASE_URL,
    variables.DEMO_PLATFORM_DATABASE_URL,
    variables.DEMO_RESET_DATABASE_URL,
    variables.DEMO_MIGRATION_DATABASE_URL,
    variables.DEMO_CUSTOMER_SESSION_SECRET,
    variables.DEMO_CUSTOMER_CSRF_SECRET,
    variables.DEMO_PLATFORM_SESSION_SECRET,
    variables.DEMO_PLATFORM_CSRF_SECRET,
    variables.DEMO_TENANT_AUDIT_HMAC_SECRET,
  ]);
  assert.equal(
    serializeGitHubActionsEnvironment({ NODE_ENV: 'test', SAFE_VALUE: 'value=with-percent%25' }),
    'NODE_ENV=test\nSAFE_VALUE=value=with-percent%25\n',
  );
  for (const invalid of [
    null,
    [],
    {},
    new Date(),
    { lowercase: 'value' },
    { 'BAD-NAME': 'value' },
    { SAFE: '' },
    { SAFE: null },
    { SAFE: 'unsafe\0value' },
    { SAFE: 'unsafe\rvalue' },
    { SAFE: 'unsafe\nvalue' },
  ]) {
    assert.throws(
      () => serializeGitHubActionsEnvironment(invalid),
      /GITHUB_ACTIONS_ENVIRONMENT_INVALID/,
    );
  }
});

test('Shared Demo CI registers generated secrets before database work and environment propagation', async () => {
  const source = await readFile(
    new URL('../scripts/provision-shared-demo-ci.mjs', import.meta.url),
    'utf8',
  );
  const registerAt = source.indexOf('registerGitHubActionsSecretMasks([');
  const connectAt = source.indexOf('await client.connect()');
  const appendAt = source.indexOf('await appendFile(');
  assert.notEqual(registerAt, -1);
  assert.equal(registerAt < connectAt, true);
  assert.equal(registerAt < appendAt, true);
  assert.match(source, /\.\.\.sensitiveGitHubActionsEnvironmentValues\(variables\)/u);
  assert.match(source, /\.\.\.Object\.values\(passwords\)/u);
  assert.match(source, /serializeGitHubActionsEnvironment\(variables\)/u);
  assert.doesNotMatch(source, /Object\.entries\(variables\)\.map/u);
});
