import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from './tenant-settings-errors.js';

export const TENANT_SETTINGS_SCHEMA_VERSION = 1;
export const TENANT_SETTINGS_INITIAL_REVISION = 1;

export function requireTenantSettingsSchemaVersion(value) {
  if (value !== TENANT_SETTINGS_SCHEMA_VERSION) {
    throw new TenantSettingsInputError('TENANT_SETTINGS_SCHEMA_VERSION_UNSUPPORTED');
  }
  return value;
}

export function requireTenantSettingsRevision(value) {
  if (
    !Number.isSafeInteger(value)
    || value < TENANT_SETTINGS_INITIAL_REVISION
    || value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TenantSettingsInputError('TENANT_SETTINGS_REVISION_INVALID');
  }
  return value;
}

export function assertTenantSettingsRevision(expectedRevision, currentRevision) {
  const expected = requireTenantSettingsRevision(expectedRevision);
  const current = requireTenantSettingsRevision(currentRevision);
  if (expected !== current) throw new TenantSettingsConflictError(current);
  return current;
}

export function nextTenantSettingsRevision(currentRevision) {
  const current = requireTenantSettingsRevision(currentRevision);
  if (current >= Number.MAX_SAFE_INTEGER - 1) {
    throw new TenantSettingsInputError('TENANT_SETTINGS_REVISION_INVALID');
  }
  return current + 1;
}
