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
  if (error instanceof TenantInputError) return new ApiError(400, 'VALIDATION_FAILED');
  if (error instanceof TenantUnavailableError) return new ApiError(403, 'TENANT_UNAVAILABLE');
  return new ApiError(500, 'INTERNAL_ERROR');
}
