export class TenantPilotLifecycleConflictError extends Error {
  constructor(code = 'TENANT_PILOT_LIFECYCLE_CONFLICT') {
    super(code);
    this.name = 'TenantPilotLifecycleConflictError';
    this.code = code;
  }
}
