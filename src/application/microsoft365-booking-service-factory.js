import { createHash } from 'node:crypto';
import { createBookingIntegrationService } from './booking-integration-service.js';
import { normalizeBookingChangeCalendarReplacement } from '../domain/booking-change.js';
import { CAPABILITY } from '../entitlements/capabilities.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
  normalizeCancelResult,
  normalizeCreateResult,
  normalizeReservationValidation,
} from '../integrations/calendar-contract.js';
import {
  BOOKING_CHANGE_MOVE_RECOVERY,
  BookingChangeCalendarMoveError,
} from './booking-change-errors.js';

function moveIdempotencyKey(tenantId, requestId, changeId, moveAttemptId, suffix = 'target') {
  return createHash('sha256')
    .update(
      `calendar-move:v2:${tenantId}:${requestId}:${changeId}:${moveAttemptId}:${suffix}`,
      'utf8',
    )
    .digest('hex');
}

function assertMoveAttemptNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError('BOOKING_CHANGE_MOVE_ATTEMPT_INVALID');
  }
  return value;
}

function cancelFailureProvesNoEffect(error) {
  return error instanceof CalendarProviderError
    && [
      PROVIDER_ERROR_KIND.AUTHORIZATION,
      PROVIDER_ERROR_KIND.CONFLICT,
      PROVIDER_ERROR_KIND.VALIDATION,
    ].includes(error.kind);
}

export function createMicrosoft365BookingServiceFactory({
  repository,
  calendarProviderFactory,
  entitlementService,
  auditService,
  authorizationPolicy,
  metrics,
  clock,
} = {}) {
  if (
    !repository
    || typeof repository.hasProviderReferenceByRequest !== 'function'
    || typeof repository.findProviderReferenceForCancellation !== 'function'
  ) {
    throw new TypeError('MICROSOFT365_BOOKING_REPOSITORY_REQUIRED');
  }
  if (
    !calendarProviderFactory
    || typeof calendarProviderFactory.forRoom !== 'function'
    || typeof calendarProviderFactory.forPersistedReference !== 'function'
  ) {
    throw new TypeError('MICROSOFT365_BOOKING_PROVIDER_FACTORY_REQUIRED');
  }
  if (!entitlementService || typeof entitlementService.requireAccess !== 'function') {
    throw new TypeError('MICROSOFT365_BOOKING_ENTITLEMENT_REQUIRED');
  }
  if (!auditService) throw new TypeError('MICROSOFT365_BOOKING_AUDIT_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.authorizeBookingOperation !== 'function') {
    throw new TypeError('MICROSOFT365_BOOKING_AUTHORIZATION_REQUIRED');
  }

  function forProvider(request, provider) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || !request.roomId) {
      throw new TypeError('MICROSOFT365_BOOKING_REQUEST_INVALID');
    }
    return createBookingIntegrationService({
      repository,
      provider,
      entitlementService,
      capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
      auditService,
      authorizeOperation: async ({ principal, tenantContext, request: target, operation }) => {
        return authorizationPolicy.authorizeBookingOperation(
          principal,
          tenantContext,
          target,
          operation,
        );
      },
      metrics,
      clock,
    });
  }

  return Object.freeze({
    async requiresCancellation(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('MICROSOFT365_BOOKING_REQUEST_INVALID');
      }
      return repository.hasProviderReferenceByRequest(request.tenantId, request.id);
    },

    async forRequest(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request) || !request.roomId) {
        throw new TypeError('MICROSOFT365_BOOKING_REQUEST_INVALID');
      }
      const provider = await calendarProviderFactory.forRoom({
        tenantId: request.tenantId,
        roomId: request.roomId,
      });
      return forProvider(request, provider);
    },

    forProvider,

    async moveCalendarEvent(context, currentRequest, proposedRequest, changeId, moveAttemptNumber) {
      assertMoveAttemptNumber(moveAttemptNumber);
      authorizationPolicy.authorizeBookingOperation(
        context.principal,
        context.tenantContext,
        currentRequest,
        'update',
      );
      await entitlementService.requireAccess({
        principal: context.principal,
        tenantContext: context.tenantContext,
        capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
        authorized: true,
      });
      const reference = await repository.findProviderReferenceForCancellation(
        currentRequest.tenantId,
        currentRequest.id,
      );
      if (!reference || reference.state !== 'active') throw new TypeError('BOOKING_REFERENCE_NOT_ACTIVE');
      const oldProvider = await calendarProviderFactory.forPersistedReference({
        tenantId: currentRequest.tenantId,
        roomId: currentRequest.roomId,
        integrationId: reference.integrationId,
        providerConnectionReference: reference.providerConnectionReference,
        providerResourceReference: reference.providerResourceReference,
      });
      const targetProvider = await calendarProviderFactory.forRoom({
        tenantId: proposedRequest.tenantId,
        roomId: proposedRequest.roomId,
      });
      if (targetProvider.integrationId !== reference.integrationId) {
        throw new TypeError('BOOKING_PROVIDER_GENERATION_MISMATCH');
      }
      const input = Object.freeze({
        tenantId: proposedRequest.tenantId,
        requestId: proposedRequest.id,
        roomId: proposedRequest.roomId,
        startsAt: proposedRequest.startsAt,
        endsAt: proposedRequest.endsAt,
        phase: context.phase,
        correlationId: context.correlationId,
      });
      const validation = normalizeReservationValidation(
        await targetProvider.validateReservation(input),
      );
      if (!validation.valid) return Object.freeze({ status: 'blocked' });
      const idempotencyKey = moveIdempotencyKey(
        proposedRequest.tenantId,
        proposedRequest.id,
        changeId,
        moveAttemptNumber,
      );
      let created;
      try {
        created = normalizeCreateResult(
          await targetProvider.createCalendarEvent(Object.freeze({ ...input, idempotencyKey })),
        );
      } catch (error) {
        throw new BookingChangeCalendarMoveError(
          BOOKING_CHANGE_MOVE_RECOVERY.RETRY_SAME_ATTEMPT,
          { cause: error },
        );
      }
      const replacement = Object.freeze({
        integrationId: reference.integrationId,
        previousProviderReference: reference.providerReference,
        previousProviderResourceReference: reference.providerResourceReference,
        providerReference: created.providerReference,
        providerResourceReference: targetProvider.providerResourceReference,
        idempotencyKey,
      });
      try {
        normalizeCancelResult(
          await oldProvider.cancelCalendarEvent(Object.freeze({
            tenantId: currentRequest.tenantId,
            requestId: currentRequest.id,
            roomId: currentRequest.roomId,
            startsAt: currentRequest.startsAt,
            endsAt: currentRequest.endsAt,
            phase: context.phase,
            correlationId: context.correlationId,
            providerReference: reference.providerReference,
            providerResourceReference: reference.providerResourceReference,
          })),
          reference.providerReference,
        );
      } catch (error) {
        if (!cancelFailureProvesNoEffect(error)) {
          throw new BookingChangeCalendarMoveError(
            BOOKING_CHANGE_MOVE_RECOVERY.RECONCILIATION_REQUIRED,
            { calendarReplacement: replacement, cause: error },
          );
        }
        try {
          normalizeCancelResult(
            await targetProvider.cancelCalendarEvent(Object.freeze({
              ...input,
              providerReference: created.providerReference,
              providerResourceReference: targetProvider.providerResourceReference,
            })),
            created.providerReference,
          );
        } catch (cleanupError) {
          throw new BookingChangeCalendarMoveError(
            BOOKING_CHANGE_MOVE_RECOVERY.RECONCILIATION_REQUIRED,
            {
              calendarReplacement: replacement,
              cause: new AggregateError(
                [error, cleanupError],
                'BOOKING_ROOM_MOVE_RECONCILIATION_REQUIRED',
              ),
            },
          );
        }
        throw new BookingChangeCalendarMoveError(
          BOOKING_CHANGE_MOVE_RECOVERY.RETRY_NEW_ATTEMPT,
          { cause: error },
        );
      }
      return Object.freeze({
        status: 'moved',
        disposition: created.disposition,
        replacement,
      });
    },

    async rollbackCalendarMove(
      context,
      currentRequest,
      proposedRequest,
      changeId,
      moveAttemptNumber,
      replacement,
    ) {
      assertMoveAttemptNumber(moveAttemptNumber);
      const normalizedReplacement = normalizeBookingChangeCalendarReplacement(replacement);
      authorizationPolicy.authorizeBookingOperation(
        context.principal,
        context.tenantContext,
        currentRequest,
        'update',
      );
      await entitlementService.requireAccess({
        principal: context.principal,
        tenantContext: context.tenantContext,
        capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
        authorized: true,
      });
      const reference = await repository.findProviderReferenceForCancellation(
        currentRequest.tenantId,
        currentRequest.id,
      );
      if (
        !reference
        || reference.state !== 'active'
        || reference.integrationId !== normalizedReplacement.integrationId
        || reference.providerReference !== normalizedReplacement.previousProviderReference
        || reference.providerResourceReference
          !== normalizedReplacement.previousProviderResourceReference
      ) throw new TypeError('BOOKING_CHANGE_MOVE_RECOVERY_REFERENCE_INVALID');
      const oldProvider = await calendarProviderFactory.forPersistedReference({
        tenantId: currentRequest.tenantId,
        roomId: currentRequest.roomId,
        integrationId: reference.integrationId,
        providerConnectionReference: reference.providerConnectionReference,
        providerResourceReference: reference.providerResourceReference,
      });
      const targetProvider = await calendarProviderFactory.forPersistedReference({
        tenantId: proposedRequest.tenantId,
        roomId: proposedRequest.roomId,
        integrationId: reference.integrationId,
        providerConnectionReference: reference.providerConnectionReference,
        providerResourceReference: normalizedReplacement.providerResourceReference,
      });
      const input = Object.freeze({
        tenantId: proposedRequest.tenantId,
        requestId: proposedRequest.id,
        roomId: proposedRequest.roomId,
        startsAt: proposedRequest.startsAt,
        endsAt: proposedRequest.endsAt,
        phase: context.phase,
        correlationId: context.correlationId,
      });
      normalizeCancelResult(
        await targetProvider.cancelCalendarEvent(Object.freeze({
          ...input,
          providerReference: normalizedReplacement.providerReference,
          providerResourceReference: normalizedReplacement.providerResourceReference,
        })),
        normalizedReplacement.providerReference,
      );
      const idempotencyKey = moveIdempotencyKey(
        currentRequest.tenantId,
        currentRequest.id,
        changeId,
        moveAttemptNumber,
        'restore',
      );
      const restored = normalizeCreateResult(
        await oldProvider.createCalendarEvent(Object.freeze({
          tenantId: currentRequest.tenantId,
          requestId: currentRequest.id,
          roomId: currentRequest.roomId,
          startsAt: currentRequest.startsAt,
          endsAt: currentRequest.endsAt,
          phase: context.phase,
          correlationId: context.correlationId,
          providerResourceReference: reference.providerResourceReference,
          idempotencyKey,
        })),
      );
      return Object.freeze({
        integrationId: reference.integrationId,
        expectedProviderReference: normalizedReplacement.previousProviderReference,
        expectedProviderResourceReference: normalizedReplacement.previousProviderResourceReference,
        providerReference: restored.providerReference,
        providerResourceReference: reference.providerResourceReference,
        idempotencyKey,
      });
    },

    async forCancellation(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request) || !request.roomId) {
        throw new TypeError('MICROSOFT365_BOOKING_REQUEST_INVALID');
      }
      const reference = await repository.findProviderReferenceForCancellation(
        request.tenantId,
        request.id,
      );
      if (!reference) return null;
      const provider = await calendarProviderFactory.forPersistedReference({
        tenantId: request.tenantId,
        roomId: request.roomId,
        integrationId: reference.integrationId,
        providerConnectionReference: reference.providerConnectionReference,
        providerResourceReference: reference.providerResourceReference,
      });
      return createBookingIntegrationService({
        repository,
        provider,
        entitlementService,
        capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
        auditService,
        authorizeOperation: async ({ principal, tenantContext, request: target, operation }) => {
          return authorizationPolicy.authorizeBookingOperation(
            principal,
            tenantContext,
            target,
            operation,
          );
        },
        metrics,
        clock,
      });
    },
  });
}
