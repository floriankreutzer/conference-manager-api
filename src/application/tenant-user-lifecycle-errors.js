export class TenantUserLifecycleConflictError extends Error {
  constructor(code = 'TENANT_USER_LIFECYCLE_CONFLICT', { currentVersion = null } = {}) {
    super(code);
    this.name = 'TenantUserLifecycleConflictError';
    this.code = code;
    this.currentVersion = currentVersion;
  }
}
