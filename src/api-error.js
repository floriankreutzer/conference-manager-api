import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from './application/microsoft365-connection-errors.js';
import { FinalRoomAvailabilityError } from './application/final-room-confirmation-service.js';
import { SiteTimeZoneRequiredError } from './application/production-application-service.js';
import { RequestCancellationReconciliationError } from './application/request-service.js';
import { BookingChangeConflictError, BookingChangeDependencyError } from './application/booking-change-errors.js';
import { TenantUserRoleConflictError } from './application/tenant-user-errors.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from './application/tenant-settings-errors.js';
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
import {
  TenantBookingPolicyInputError,
  TenantBookingPolicyViolationError,
} from './domain/tenant-booking-policies.js';
import { TenantCostAllocationInputError } from './domain/tenant-cost-allocation.js';

const BOOKING_POLICY_VIOLATION_CODES = new Set([
  'BOOKING_POLICY_LEAD_TIME_VIOLATION',
  'BOOKING_POLICY_ADVANCE_WINDOW_VIOLATION',
  'BOOKING_POLICY_CANCELLATION_WINDOW_VIOLATION',
  'BOOKING_POLICY_CHANGE_WINDOW_VIOLATION',
  'BOOKING_POLICY_PARTICIPANT_LIMIT_VIOLATION',
  'BOOKING_POLICY_SITE_NOT_ALLOWED',
  'BOOKING_POLICY_ROOM_NOT_ALLOWED',
  'BOOKING_POLICY_SERVICE_NOT_ALLOWED',
]);
const BOOKING_POLICY_PARAMETER_BOUNDS = Object.freeze({
  requiredMinutes: 527_040,
  maximumMinutes: 527_040,
  maximumParticipants: 100_000,
});

function bookingPolicyViolationContext(parameters) {
  const context = {};
  for (const [key, maximum] of Object.entries(BOOKING_POLICY_PARAMETER_BOUNDS)) {
    const value = parameters?.[key];
    if (Number.isSafeInteger(value) && value >= 0 && value <= maximum) context[key] = value;
  }
  return Object.keys(context).length > 0 ? Object.freeze(context) : null;
}

export class ApiError extends Error {
  constructor(statusCode, code, context = null) {
    super(code);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.context = context;
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
    || error instanceof TenantSettingsInputError
    || error instanceof TenantBookingPolicyInputError
    || error instanceof TenantCostAllocationInputError
  ) {
    return new ApiError(400, 'VALIDATION_FAILED');
  }
  if (error instanceof OnboardingDeniedError) return new ApiError(403, 'ONBOARDING_UNAVAILABLE');
  if (error instanceof EntitlementDeniedError) return new ApiError(403, 'ENTITLEMENT_ACCESS_DENIED');
  if (error instanceof OnboardingConflictError) return new ApiError(409, 'ONBOARDING_CONFLICT');
  if (error instanceof TenantUserRoleConflictError) return new ApiError(409, error.code);
  if (error instanceof TenantSettingsConflictError) {
    return new ApiError(409, error.code, { currentRevision: error.currentRevision });
  }
  if (error instanceof TenantBookingPolicyViolationError) {
    const code = BOOKING_POLICY_VIOLATION_CODES.has(error.code)
      ? error.code
      : 'BOOKING_POLICY_VIOLATION';
    return new ApiError(409, code, bookingPolicyViolationContext(error.parameters));
  }
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
  if (error instanceof BookingChangeConflictError) return new ApiError(409, error.code);
  if (error instanceof BookingChangeDependencyError) return new ApiError(503, error.code);
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
