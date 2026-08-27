import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TENANT_SETTINGS_INITIAL_REVISION,
  TENANT_SETTINGS_SCHEMA_VERSION,
  assertTenantSettingsRevision,
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
} from '../src/application/tenant-settings-revision.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from '../src/application/tenant-settings-errors.js';

test('tenant settings revisions expose one bounded shared version primitive', () => {
  assert.equal(TENANT_SETTINGS_SCHEMA_VERSION, 1);
  assert.equal(TENANT_SETTINGS_INITIAL_REVISION, 1);
  assert.equal(requireTenantSettingsSchemaVersion(1), 1);
  assert.equal(requireTenantSettingsRevision(1), 1);
  assert.equal(nextTenantSettingsRevision(1), 2);
});

test('unknown schema and malformed revision states fail closed', () => {
  for (const value of [0, 2, '1', null, undefined]) {
    assert.throws(
      () => requireTenantSettingsSchemaVersion(value),
      (error) => error instanceof TenantSettingsInputError
        && error.code === 'TENANT_SETTINGS_SCHEMA_VERSION_UNSUPPORTED',
    );
  }
  for (const value of [0, -1, 1.5, '1', null, undefined, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => requireTenantSettingsRevision(value),
      (error) => error instanceof TenantSettingsInputError
        && error.code === 'TENANT_SETTINGS_REVISION_INVALID',
    );
  }
});

test('stale writes expose only the current safe revision and never advance it', () => {
  assert.throws(
    () => assertTenantSettingsRevision(4, 5),
    (error) => error instanceof TenantSettingsConflictError
      && error.code === 'TENANT_SETTINGS_REVISION_CONFLICT'
      && error.currentRevision === 5,
  );
  assert.equal(assertTenantSettingsRevision(5, 5), 5);
  assert.equal(nextTenantSettingsRevision(5), 6);
  assert.throws(
    () => nextTenantSettingsRevision(Number.MAX_SAFE_INTEGER - 1),
    (error) => error instanceof TenantSettingsInputError
      && error.code === 'TENANT_SETTINGS_REVISION_INVALID',
  );
});
