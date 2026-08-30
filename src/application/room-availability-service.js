import { AuthorizationDeniedError, AuthorizationInputError } from '../authorization/errors.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { CAPABILITY } from '../entitlements/capabilities.js';
import { normalizeAvailabilityResult } from '../integrations/calendar-contract.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_AVAILABILITY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export class RoomAvailabilityUnavailableError extends Error {
  constructor(code = 'ROOM_AVAILABILITY_UNAVAILABLE', options = {}) {
    super(code, options);
    this.name = 'RoomAvailabilityUnavailableError';
    this.code = code;
  }
}

function canonicalUtcInstant(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return parsed;
}

export function normalizeRoomAvailabilityQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthorizationInputError('ROOM_AVAILABILITY_INPUT_INVALID');
  }
  if (Object.keys(value).some((key) => ![
    'roomId', 'startsAt', 'endsAt', 'resubmissionRequestId',
  ].includes(key))) {
    throw new AuthorizationInputError('ROOM_AVAILABILITY_INPUT_INVALID');
  }
  if (typeof value.roomId !== 'string' || !ROOM_ID_PATTERN.test(value.roomId)) {
    throw new AuthorizationInputError('ROOM_AVAILABILITY_INPUT_INVALID');
  }
  const startsAt = canonicalUtcInstant(value.startsAt);
  const endsAt = canonicalUtcInstant(value.endsAt);
  if (
    !startsAt
    || !endsAt
    || endsAt <= startsAt
    || endsAt.getTime() - startsAt.getTime() > MAX_AVAILABILITY_WINDOW_MS
  ) {
    throw new AuthorizationInputError('ROOM_AVAILABILITY_INPUT_INVALID');
  }
  return Object.freeze({
    roomId: value.roomId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    resubmissionRequestId: value.resubmissionRequestId === undefined
      || value.resubmissionRequestId === null
      ? null
      : (() => {
        if (!isRequestId(value.resubmissionRequestId)) {
          throw new AuthorizationInputError('ROOM_AVAILABILITY_INPUT_INVALID');
        }
        return value.resubmissionRequestId;
      })(),
  });
}

export function createRoomAvailabilityService({
  repository,
  authorizationPolicy,
  entitlementService,
  calendarProviderFactory,
} = {}) {
  if (
    !repository
    || typeof repository.hasConflictingRequest !== 'function'
    || typeof repository.findByTenantIdAndId !== 'function'
  ) {
    throw new TypeError('ROOM_AVAILABILITY_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.authorizeRequestCreate !== 'function'
    || typeof authorizationPolicy.authorizeRequestRead !== 'function'
  ) {
    throw new TypeError('ROOM_AVAILABILITY_AUTHORIZATION_REQUIRED');
  }
  if (!entitlementService || typeof entitlementService.requireAccess !== 'function') {
    throw new TypeError('ROOM_AVAILABILITY_ENTITLEMENT_REQUIRED');
  }
  if (!calendarProviderFactory || typeof calendarProviderFactory.forRoom !== 'function') {
    throw new TypeError('ROOM_AVAILABILITY_PROVIDER_REQUIRED');
  }

  return Object.freeze({
    async checkAvailability({ principal, tenantContext, correlationId, query }) {
      if (!isInternalUuid(correlationId)) {
        throw new AuthorizationInputError('CORRELATION_ID_INVALID');
      }
      const normalized = normalizeRoomAvailabilityQuery(query);
      authorizationPolicy.authorizeRequestCreate(principal, tenantContext);

      let excludeRequestId = null;
      if (normalized.resubmissionRequestId !== null) {
        const request = await repository.findByTenantIdAndId(
          tenantContext.tenantId,
          normalized.resubmissionRequestId,
        );
        authorizationPolicy.authorizeRequestRead(principal, tenantContext, request);
        if (
          request.requesterUserId !== principal.userId
          || request.status !== 'Change Requested'
        ) {
          throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
        }
        excludeRequestId = request.id;
      }

      try {
        await entitlementService.requireAccess({
          principal,
          tenantContext,
          capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
          authorized: true,
        });
        const localConflict = await repository.hasConflictingRequest({
          tenantId: tenantContext.tenantId,
          roomId: normalized.roomId,
          startsAt: normalized.startsAt,
          endsAt: normalized.endsAt,
          excludeRequestId,
        });
        if (localConflict) return Object.freeze({ available: false, conflictCount: 1 });

        const provider = await calendarProviderFactory.forRoom({
          tenantId: tenantContext.tenantId,
          roomId: normalized.roomId,
        });
        return normalizeAvailabilityResult(await provider.lookupAvailability({
          tenantId: tenantContext.tenantId,
          roomId: normalized.roomId,
          startsAt: normalized.startsAt,
          endsAt: normalized.endsAt,
          phase: 'provisional',
          correlationId,
        }));
      } catch (error) {
        if (error instanceof RoomAvailabilityUnavailableError) throw error;
        throw new RoomAvailabilityUnavailableError(undefined, { cause: error });
      }
    },
  });
}
