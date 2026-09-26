import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from '../authorization/errors.js';
import {
  isImmediateRequestVersionSuccessor,
  isRequestId,
  isRequestVersion,
} from '../domain/request.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { REQUEST_STATUS, REQUEST_TRANSITION } from '../domain/request-workflow.js';
import { CAPABILITY } from '../entitlements/capabilities.js';
import { EntitlementDeniedError } from '../entitlements/errors.js';
import {
  RESERVATION_PHASE,
  isProviderConnectionReference,
  isProviderReference,
  isProviderResourceReference,
} from '../integrations/calendar-contract.js';

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function normalizePreConfirmationCleanup(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.disposition !== 'string'
    || value.disposition.length < 1
    || value.disposition.length > 64
  ) {
    throw new TypeError('FINAL_ROOM_CALENDAR_CLEANUP_RESULT_INVALID');
  }
  if (value.state === 'cancelled' && value.reference === null) return null;
  const reference = value.reference;
  if (
    value.state !== 'compensated'
    || !reference
    || typeof reference !== 'object'
    || Array.isArray(reference)
    || !isInternalUuid(reference.integrationId)
    || !isProviderReference(reference.providerReference)
    || !isProviderConnectionReference(reference.providerConnectionReference)
    || !isProviderResourceReference(reference.providerResourceReference)
  ) {
    throw new TypeError('FINAL_ROOM_CALENDAR_CLEANUP_RESULT_INVALID');
  }
  return Object.freeze({
    disposition: value.disposition,
    reference: Object.freeze({
      integrationId: reference.integrationId,
      providerReference: reference.providerReference,
      providerConnectionReference: reference.providerConnectionReference,
      providerResourceReference: reference.providerResourceReference,
    }),
  });
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
    || typeof authorizationPolicy.authorizeRequestReconciliation !== 'function'
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
  if (
    !entitlementService
    || typeof entitlementService.requireAccess !== 'function'
    || typeof entitlementService.evaluateAccess !== 'function'
  ) {
    throw new TypeError('FINAL_CONFIRMATION_ENTITLEMENT_REQUIRED');
  }
  if (!calendarProviderFactory || typeof calendarProviderFactory.forRoom !== 'function') {
    throw new TypeError('FINAL_CONFIRMATION_PROVIDER_FACTORY_REQUIRED');
  }
  if (
    bookingServiceFactory
    && typeof bookingServiceFactory.forProvider !== 'function'
  ) {
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
      await service.compensateCalendarEvent(context);
    } catch (compensationError) {
      throw new FinalRoomAvailabilityError('FINAL_ROOM_COMPENSATION_FAILED', {
        cause: new AggregateError([originalError, compensationError], 'FINAL_ROOM_CONFIRMATION_AND_COMPENSATION_FAILED'),
      });
    }
  }

  function isCommittedConfirmation(request, expectedVersion) {
    return request?.status === REQUEST_STATUS.CONFIRMED
      && isImmediateRequestVersionSuccessor(request.version, expectedVersion);
  }

  return Object.freeze({
    async confirm({ principal, tenantContext, requestId, expectedVersion, correlationId }) {
      if (!isRequestId(requestId)) throw new TypeError('REQUEST_ID_INVALID');
      if (!isRequestVersion(expectedVersion)) {
        throw new AuthorizationInputError('REQUEST_VERSION_PRECONDITION_INVALID');
      }
      const request = await repository.findByTenantIdAndId(tenantContext.tenantId, requestId);
      if (!request) {
        await recordDenied({ principal, tenantContext, requestId, correlationId });
        throw concealedNotFound();
      }

      if (request.status === REQUEST_STATUS.CONFIRMED) {
        try {
          authorizationPolicy.authorizeRequestReconciliation(
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
        if (request.version !== expectedVersion) {
          await recordFailure({
            principal,
            tenantContext,
            requestId,
            correlationId,
            request,
            reasonCode: 'state_conflict',
          });
          throw new RequestStateConflictError();
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
        if (request.version !== expectedVersion) throw new RequestStateConflictError();
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await recordDenied({ principal, tenantContext, requestId, correlationId });
        } else if (error instanceof RequestStateConflictError) {
          await recordFailure({
            principal,
            tenantContext,
            requestId,
            correlationId,
            request,
            reasonCode: 'state_conflict',
          });
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

      let calendarWriteEnabled = false;
      try {
        await entitlementService.requireAccess({
          principal,
          tenantContext,
          capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
          authorized: true,
        });
        calendarWriteEnabled = bookingServiceFactory
          ? await entitlementService.evaluateAccess({
            principal,
            tenantContext,
            capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
            authorized: true,
          })
          : false;
      } catch (error) {
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: error instanceof EntitlementDeniedError
            ? 'calendar_entitlement_denied'
            : 'calendar_entitlement_unavailable',
        });
        if (error instanceof EntitlementDeniedError) throw error;
        throw new FinalRoomAvailabilityError('FINAL_ROOM_ENTITLEMENT_UNAVAILABLE', { cause: error });
      }

      let validation;
      let calendarAuthority;
      let calendarProvider;
      try {
        calendarProvider = await calendarProviderFactory.forRoom({
          tenantId: tenantContext.tenantId,
          roomId: request.roomId,
        });
        if (
          !isInternalUuid(calendarProvider?.integrationId)
          || !isProviderConnectionReference(calendarProvider?.providerConnectionReference)
          || !isProviderResourceReference(calendarProvider?.providerResourceReference)
          || typeof calendarProvider?.integrationProvider !== 'string'
          || !PROVIDER_PATTERN.test(calendarProvider.integrationProvider)
          || typeof calendarProvider?.identityProvider !== 'string'
          || !PROVIDER_PATTERN.test(calendarProvider.identityProvider)
        ) {
          throw new TypeError('FINAL_ROOM_PROVIDER_AUTHORITY_INVALID');
        }
        calendarAuthority = Object.freeze({
          integrationId: calendarProvider.integrationId,
          integrationProvider: calendarProvider.integrationProvider,
          identityProvider: calendarProvider.identityProvider,
          providerConnectionReference: calendarProvider.providerConnectionReference,
          roomId: request.roomId,
          providerResourceReference: calendarProvider.providerResourceReference,
          calendarWriteEnabled,
        });
        validation = await calendarProvider.validateReservation({
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
        throw new FinalRoomAvailabilityError('FINAL_ROOM_PROVIDER_UNAVAILABLE', { cause: error });
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
      let calendarCleanup = null;
      const context = bookingContext(principal, tenantContext, request, correlationId);
      if (!calendarWriteEnabled && bookingServiceFactory) {
        try {
          if (
            typeof bookingServiceFactory.requiresCancellation !== 'function'
            || typeof bookingServiceFactory.forCancellation !== 'function'
          ) {
            throw new TypeError('FINAL_ROOM_CALENDAR_CLEANUP_FACTORY_INVALID');
          }
          if (await bookingServiceFactory.requiresCancellation(request)) {
            const cleanupService = await bookingServiceFactory.forCancellation(request);
            if (
              !cleanupService
              || typeof cleanupService.cancelCalendarEventBeforeConfirmation !== 'function'
            ) {
              throw new TypeError('FINAL_ROOM_CALENDAR_CLEANUP_SERVICE_INVALID');
            }
            calendarCleanup = normalizePreConfirmationCleanup(
              await cleanupService.cancelCalendarEventBeforeConfirmation(context),
            );
          }
        } catch (error) {
          await recordFailure({
            principal,
            tenantContext,
            requestId,
            correlationId,
            request,
            reasonCode: 'calendar_cleanup_unavailable',
          });
          throw new FinalRoomAvailabilityError(
            'FINAL_ROOM_CALENDAR_RECONCILIATION_REQUIRED',
            { cause: error },
          );
        }
      }
      if (calendarWriteEnabled) {
        try {
          bookingService = await bookingServiceFactory.forProvider(request, calendarProvider);
          await bookingService.createCalendarEvent(context);
          calendarCreated = true;
        } catch (error) {
          await recordFailure({
            principal,
            tenantContext,
            requestId,
            correlationId,
            request,
            reasonCode: 'calendar_write_unavailable',
          });
          throw new FinalRoomAvailabilityError('FINAL_ROOM_CALENDAR_WRITE_UNAVAILABLE', { cause: error });
        }
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
      const calendarCleanupAuditEvent = calendarCleanup === null
        ? null
        : auditService.createEvent({
          principal,
          tenantContext,
          correlationId,
          action: AUDIT_ACTION.CALENDAR_OPERATION,
          targetType: 'request',
          targetId: requestId,
          previousState: { calendarState: 'compensated' },
          newState: { calendarState: 'cancelled' },
          outcome: AUDIT_OUTCOME.SUCCESS,
          occurredAt: changedAt.toISOString(),
          metadata: {
            disposition: calendarCleanup.disposition,
            operation: 'cancel',
            phase: RESERVATION_PHASE.FINAL,
          },
          retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
        });

      let result;
      try {
        result = await repository.confirmIfRoomAvailable({
          tenantId: tenantContext.tenantId,
          requestId,
          expectedStatus: decision.expectedStatus,
          expectedVersion,
          calendarAuthority,
          calendarCleanup: calendarCleanup === null ? null : Object.freeze({
            reference: calendarCleanup.reference,
            auditEvent: calendarCleanupAuditEvent,
          }),
          changedAt,
          auditEvent,
        });
      } catch (error) {
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: 'confirmation_outcome_unknown',
        });
        throw new FinalRoomAvailabilityError('FINAL_ROOM_CONFIRMATION_RECONCILIATION_REQUIRED', {
          cause: error,
        });
      }
      if (result.status === 'confirmed' && isCommittedConfirmation(result.request, expectedVersion)) {
        return result.request;
      }
      if (result.request?.status === REQUEST_STATUS.CONFIRMED) {
        const conflict = new RequestStateConflictError();
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: 'concurrent_state_change',
        });
        throw conflict;
      }

      if (result.status === 'provider_authority_conflict') {
        const authorityError = new FinalRoomAvailabilityError('FINAL_ROOM_PROVIDER_AUTHORITY_LOST');
        if (calendarCreated) {
          await compensateCreatedCalendarEvent(bookingService, context, authorityError);
        }
        await recordFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          reasonCode: 'provider_authority_lost',
        });
        throw authorityError;
      }

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
