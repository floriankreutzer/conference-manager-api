import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import {
  AuthorizationDeniedError,
  RequestStateConflictError,
} from '../authorization/errors.js';
import { isRequestId } from '../domain/request.js';
import { REQUEST_STATUS, REQUEST_TRANSITION } from '../domain/request-workflow.js';
import { CAPABILITY } from '../entitlements/capabilities.js';
import { CalendarProviderError, RESERVATION_PHASE } from '../integrations/calendar-contract.js';

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

export class FinalRoomAvailabilityError extends Error {
  constructor(code = 'FINAL_ROOM_AVAILABILITY_UNAVAILABLE', options = {}) {
    super(code, options);
    this.name = 'FinalRoomAvailabilityError';
    this.code = code;
  }
}

export function createFinalRoomConfirmationService({
  repository,
  authorizationPolicy,
  auditService,
  entitlementService,
  calendarProviderFactory,
  bookingServiceFactory = null,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.findByTenantIdAndId !== 'function'
    || typeof repository.confirmIfRoomAvailable !== 'function'
  ) {
    throw new TypeError('FINAL_CONFIRMATION_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.authorizeRequestRead !== 'function'
    || typeof authorizationPolicy.authorizeRequestTransition !== 'function'
  ) {
    throw new TypeError('FINAL_CONFIRMATION_AUTHORIZATION_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.record !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('FINAL_CONFIRMATION_AUDIT_REQUIRED');
  }
  if (!entitlementService || typeof entitlementService.requireAccess !== 'function') {
    throw new TypeError('FINAL_CONFIRMATION_ENTITLEMENT_REQUIRED');
  }
  if (!calendarProviderFactory || typeof calendarProviderFactory.forRoom !== 'function') {
    throw new TypeError('FINAL_CONFIRMATION_PROVIDER_FACTORY_REQUIRED');
  }
  if (bookingServiceFactory && typeof bookingServiceFactory.forRequest !== 'function') {
    throw new TypeError('FINAL_CONFIRMATION_BOOKING_FACTORY_INVALID');
  }
  if (typeof clock !== 'function') throw new TypeError('FINAL_CONFIRMATION_CLOCK_REQUIRED');

  async function recordFailure({ principal, tenantContext, requestId, correlationId, request, reasonCode }) {
    await auditService.record({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.REQUEST_TRANSITION_FAILED,
      targetType: 'request',
      targetId: requestId,
      previousState: request ? { status: request.status } : null,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: { reasonCode, transitionProvided: true },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
    });
  }

  async function recordDenied({ principal, tenantContext, requestId, correlationId }) {
    await auditService.recordAuthorizationDenied({
      principal,
      tenantContext,
      correlationId,
      targetType: 'request',
      targetId: requestId,
      metadata: { operation: 'final_confirm' },
    });
  }

  function bookingContext(principal, tenantContext, request, correlationId) {
    return Object.freeze({
      principal,
      tenantContext,
      request,
      correlationId,
      phase: RESERVATION_PHASE.FINAL,
    });
  }

  async function compensateCreatedCalendarEvent(service, context, originalError) {
    try {
      await service.cancelCalendarEvent(context);
    } catch (compensationError) {
      throw new FinalRoomAvailabilityError('FINAL_ROOM_COMPENSATION_FAILED', {
        cause: new AggregateError([originalError, compensationError], 'FINAL_ROOM_CONFIRMATION_AND_COMPENSATION_FAILED'),
      });
    }
  }

  return Object.freeze({
    async confirm({ principal, tenantContext, requestId, correlationId }) {
      if (!isRequestId(requestId)) throw new TypeError('REQUEST_ID_INVALID');
      const request = await repository.findByTenantIdAndId(tenantContext.tenantId, requestId);
      if (!request) {
        await recordDenied({ principal, tenantContext, requestId, correlationId });
        throw concealedNotFound();
      }

      if (request.status === REQUEST_STATUS.CONFIRMED) {
        try {
          authorizationPolicy.authorizeRequestRead(principal, tenantContext, request);
        } catch (error) {
          if (error instanceof AuthorizationDeniedError) {
            await recordDenied({ principal, tenantContext, requestId, correlationId });
          }
          throw error;
        }
        return request;
      }

      let decision;
      try {
        decision = authorizationPolicy.authorizeRequestTransition(
          principal,
          tenantContext,
          request,
          REQUEST_TRANSITION.CONFIRM,
          undefined,
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await recordDenied({ principal, tenantContext, requestId, correlationId });
        }
        throw error;
      }
      if (!request.roomId) {
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: 'room_required',
        });
        throw new RequestStateConflictError('ROOM_REQUIRED');
      }

      await entitlementService.requireAccess({
        principal,
        tenantContext,
        capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
        authorized: true,
      });

      const provider = await calendarProviderFactory.forRoom({
        tenantId: tenantContext.tenantId,
        roomId: request.roomId,
      });
      let validation;
      try {
        validation = await provider.validateReservation({
          tenantId: tenantContext.tenantId,
          requestId: request.id,
          roomId: request.roomId,
          startsAt: request.startsAt,
          endsAt: request.endsAt,
          phase: RESERVATION_PHASE.FINAL,
          correlationId,
        });
      } catch (error) {
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: 'provider_unavailable',
        });
        if (error instanceof CalendarProviderError) {
          throw new FinalRoomAvailabilityError('FINAL_ROOM_PROVIDER_UNAVAILABLE', { cause: error });
        }
        throw error;
      }
      if (!validation || validation.valid !== true || validation.reason !== 'available') {
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: 'provider_conflict',
        });
        throw new RequestStateConflictError('ROOM_AVAILABILITY_CONFLICT');
      }

      let bookingService = null;
      let calendarCreated = false;
      const context = bookingContext(principal, tenantContext, request, correlationId);
      if (bookingServiceFactory) {
        bookingService = await bookingServiceFactory.forRequest(request);
        await bookingService.createCalendarEvent(context);
        calendarCreated = true;
      }

      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0) throw new TypeError('FINAL_CONFIRMATION_CLOCK_INVALID');
      const changedAt = new Date(changedMs);
      const auditEvent = auditService.createEvent({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.REQUEST_TRANSITION,
        targetType: 'request',
        targetId: requestId,
        previousState: { status: request.status },
        newState: { status: decision.nextStatus },
        outcome: AUDIT_OUTCOME.SUCCESS,
        occurredAt: changedAt.toISOString(),
        metadata: { reasonProvided: false, transition: decision.transition },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      });

      let result;
      try {
        result = await repository.confirmIfRoomAvailable({
          tenantId: tenantContext.tenantId,
          requestId,
          expectedStatus: decision.expectedStatus,
          changedAt,
          auditEvent,
        });
      } catch (error) {
        if (calendarCreated) await compensateCreatedCalendarEvent(bookingService, context, error);
        throw error;
      }
      if (result.status === 'confirmed') return result.request;

      const conflict = new RequestStateConflictError(
        result.status === 'room_conflict' ? 'ROOM_AVAILABILITY_CONFLICT' : 'REQUEST_STATE_CONFLICT',
      );
      if (calendarCreated) await compensateCreatedCalendarEvent(bookingService, context, conflict);
      await recordFailure({
        principal,
        tenantContext,
        requestId,
        correlationId,
        request,
        reasonCode: result.status === 'room_conflict' ? 'concurrent_room_conflict' : 'concurrent_state_change',
      });
      throw conflict;
    },
  });
}
