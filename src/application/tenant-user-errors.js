export class TenantUserRoleConflictError extends Error {
  constructor(code = 'TENANT_USER_ROLE_CONFLICT') {
    super(code);
    this.name = 'TenantUserRoleConflictError';
    this.code = code;
  }
}
