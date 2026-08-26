export class TenantSettingsInputError extends Error {
  constructor(code = 'TENANT_SETTINGS_INPUT_INVALID') {
    super(code);
    this.name = 'TenantSettingsInputError';
    this.code = code;
  }
}

export class TenantSettingsConflictError extends Error {
  constructor(currentRevision) {
    super('TENANT_SETTINGS_REVISION_CONFLICT');
    this.name = 'TenantSettingsConflictError';
    this.code = 'TENANT_SETTINGS_REVISION_CONFLICT';
    this.currentRevision = currentRevision;
  }
}
