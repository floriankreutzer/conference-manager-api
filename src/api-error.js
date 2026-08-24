import {
  AuditInputError,
  AuditIntegrityError,
} from './audit/errors.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from './authorization/errors.js';
import {
  TenantInputError,
  TenantUnavailableError,
} from './tenancy/errors.js';

export class ApiError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function asApiError(error) {
  if (error instanceof ApiError) return error;
  if (
    error instanceof TenantInputError
    || error instanceof AuthorizationInputError
    || error instanceof AuditInputError
  ) {
    return new ApiError(400, 'VALIDATION_FAILED');
  }
  if (error instanceof TenantUnavailableError) return new ApiError(403, 'TENANT_UNAVAILABLE');
  if (error instanceof AuthorizationDeniedError) {
    return error.conceal
      ? new ApiError(404, 'NOT_FOUND')
      : new ApiError(403, 'FORBIDDEN');
  }
  if (error instanceof RequestStateConflictError) return new ApiError(409, 'REQUEST_STATE_CONFLICT');
  if (error instanceof AuditIntegrityError) return new ApiError(503, 'AUDIT_INTEGRITY_UNAVAILABLE');
  return new ApiError(500, 'INTERNAL_ERROR');
}
