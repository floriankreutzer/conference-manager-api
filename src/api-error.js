import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from './application/microsoft365-connection-errors.js';
import { FinalRoomAvailabilityError } from './application/final-room-confirmation-service.js';
import { SiteTimeZoneRequiredError } from './application/production-application-service.js';
import { RequestCancellationReconciliationError } from './application/request-service.js';
import { TenantUserRoleConflictError } from './application/tenant-user-errors.js';
import {
  AuditInputError,
  AuditIntegrityError,
} from './audit/errors.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from './authorization/errors.js';
import { EntraAuthenticationError } from './identity/entra-errors.js';
import { EntitlementDeniedError, EntitlementInputError } from './entitlements/errors.js';
import {
  OnboardingConflictError,
  OnboardingDeniedError,
  OnboardingInputError,
} from './onboarding/errors.js';
import {
  TenantInputError,
  TenantUnavailableError,
} from './tenancy/errors.js';
import { RoomAvailabilityUnavailableError } from './application/room-availability-service.js';

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
  if (error instanceof EntraAuthenticationError) return new ApiError(401, 'AUTHENTICATION_FAILED');
  if (
    error instanceof TenantInputError
    || error instanceof AuthorizationInputError
    || error instanceof AuditInputError
    || error instanceof OnboardingInputError
    || error instanceof Microsoft365ConnectionInputError
    || error instanceof EntitlementInputError
  ) {
    return new ApiError(400, 'VALIDATION_FAILED');
  }
  if (error instanceof OnboardingDeniedError) return new ApiError(403, 'ONBOARDING_UNAVAILABLE');
  if (error instanceof EntitlementDeniedError) return new ApiError(403, 'ENTITLEMENT_ACCESS_DENIED');
  if (error instanceof OnboardingConflictError) return new ApiError(409, 'ONBOARDING_CONFLICT');
  if (error instanceof TenantUserRoleConflictError) return new ApiError(409, error.code);
  if (error instanceof Microsoft365ConnectionConflictError) return new ApiError(409, error.code);
  if (error instanceof Microsoft365ConnectionUnavailableError) {
    return new ApiError(503, 'MICROSOFT365_CONNECTION_UNAVAILABLE');
  }
  if (error instanceof RoomAvailabilityUnavailableError) {
    return new ApiError(503, 'ROOM_AVAILABILITY_UNAVAILABLE');
  }
  if (error instanceof SiteTimeZoneRequiredError) {
    return new ApiError(409, 'SITE_TIME_ZONE_REQUIRED');
  }
  if (error instanceof FinalRoomAvailabilityError) {
    return new ApiError(503, 'CALENDAR_DEPENDENCY_UNAVAILABLE');
  }
  if (error instanceof RequestCancellationReconciliationError) {
    return new ApiError(503, 'CALENDAR_RECONCILIATION_REQUIRED');
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
