import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from '../src/application/tenant-settings-errors.js';

test('Tenant settings input failures use the bounded validation response', () => {
  const error = asApiError(new TenantSettingsInputError('TENANT_SETTINGS_REVISION_INVALID'));
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.context, null);
});

test('Tenant settings conflicts expose only the safe current revision context', () => {
  const error = asApiError(new TenantSettingsConflictError(9));
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, 'TENANT_SETTINGS_REVISION_CONFLICT');
  assert.deepEqual(error.context, { currentRevision: 9 });
});
