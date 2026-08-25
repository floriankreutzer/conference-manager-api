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
import { isRequestId } from '../domain/request.js';
import { REQUEST_STATUS, REQUEST_TRANSITION } from '../domain/request-workflow.js';
import { RESERVATION_PHASE } from '../integrations/calendar-contract.js';

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function assertRequestId(requestId) {
  if (!isRequestId(requestId)) throw new AuthorizationInputError('REQUEST_ID_INVALID');
}

export function createRequestService({
  repository,
  authorizationPolicy,
  auditService,
  finalRoomConfirmationService = null,
  bookingServiceFactory = null,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.findByTenantIdAndId !== 'function'
    || typeof repository.transitionByTenantIdAndId !== 'function'
  ) {
    throw new TypeError('REQUEST_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.authorizeRequestRead !== 'function'
    || typeof authorizationPolicy.authorizeRequestTransition !== 'function'
  ) {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.record !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (finalRoomConfirmationService !== null && typeof finalRoomConfirmationService?.confirm !== 'function') {
    throw new TypeError('FINAL_ROOM_CONFIRMATION_SERVICE_INVALID');
  }
  if (bookingServiceFactory !== null && typeof bookingServiceFactory?.forRequest !== 'function') {
    throw new TypeError('BOOKING_SERVICE_FACTORY_INVALID');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');

  async function loadRequest(tenantContext, requestId) {
    assertRequestId(requestId);
    return repository.findByTenantIdAndId(tenantContext.tenantId, requestId);
  }

  async function recordDenied({ principal, tenantContext, requestId, correlationId, operation }) {
    await auditService.recordAuthorizationDenied({
      principal,
      tenantContext,
      correlationId,
      targetType: 'request',
      targetId: requestId,
      metadata: { operation },
    });
  }

  async function recordTransitionFailure({
    principal,
    tenantContext,
    requestId,
    correlationId,
    request,
    transition,
    reasonCode,
  }) {
    await auditService.record({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.REQUEST_TRANSITION_FAILED,
      targetType: 'request',
      targetId: requestId,
      previousState: request ? { status: request.status } : null,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: {
        reasonCode,
        transitionProvided: typeof transition === 'string',
      },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
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

  async function synchronizeCancellation({ principal, tenantContext, request, correlationId }) {
    if (!bookingServiceFactory || !request.roomId) return;
    const service = await bookingServiceFactory.forRequest(request);
    await service.cancelCalendarEvent(bookingContext(
      principal,
      tenantContext,
      request,
      correlationId,
    ));
  }

  return Object.freeze({
    async getRequest({ principal, tenantContext, requestId, correlationId }) {
      const request = await loadRequest(tenantContext, requestId);
      if (!request) {
        await recordDenied({
          principal,
          tenantContext,
          requestId,
          correlationId,
          operation: 'read',
        });
        throw concealedNotFound();
      }
      try {
        authorizationPolicy.authorizeRequestRead(principal, tenantContext, request);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await recordDenied({
            principal,
            tenantContext,
            requestId,
            correlationId,
            operation: 'read',
          });
        }
        throw error;
      }
      return request;
    },

    async transitionRequest({
      principal,
      tenantContext,
      requestId,
      transition,
      reason,
      correlationId,
    }) {
      assertRequestId(requestId);
      if (transition === REQUEST_TRANSITION.CONFIRM && finalRoomConfirmationService) {
        if (reason !== undefined && reason !== null) {
          throw new AuthorizationInputError('TRANSITION_REASON_FORBIDDEN');
        }
        return finalRoomConfirmationService.confirm({
          principal,
          tenantContext,
          requestId,
          correlationId,
        });
      }

      const request = await loadRequest(tenantContext, requestId);
      if (!request) {
        await recordDenied({
          principal,
          tenantContext,
          requestId,
          correlationId,
          operation: 'transition',
        });
        throw concealedNotFound();
      }

      if (transition === REQUEST_TRANSITION.CANCEL && request.status === REQUEST_STATUS.CANCELLED) {
        try {
          authorizationPolicy.authorizeRequestRead(principal, tenantContext, request);
        } catch (error) {
          if (error instanceof AuthorizationDeniedError) {
            await recordDenied({
              principal,
              tenantContext,
              requestId,
              correlationId,
              operation: 'transition',
            });
          }
          throw error;
        }
        await synchronizeCancellation({ principal, tenantContext, request, correlationId });
        return request;
      }

      let decision;
      try {
        decision = authorizationPolicy.authorizeRequestTransition(
          principal,
          tenantContext,
          request,
          transition,
          reason,
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await recordDenied({
            principal,
            tenantContext,
            requestId,
            correlationId,
            operation: 'transition',
          });
        } else if (error instanceof AuthorizationInputError) {
          await recordTransitionFailure({
            principal,
            tenantContext,
            requestId,
            correlationId,
            request,
            transition,
            reasonCode: 'validation_failed',
          });
        } else if (error instanceof RequestStateConflictError) {
          await recordTransitionFailure({
            principal,
            tenantContext,
            requestId,
            correlationId,
            request,
            transition,
            reasonCode: 'state_conflict',
          });
        }
        throw error;
      }

      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0) throw new TypeError('REQUEST_CLOCK_INVALID');
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
        metadata: {
          reasonProvided: decision.reason !== null,
          transition: decision.transition,
        },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      });
      const updated = await repository.transitionByTenantIdAndId({
        tenantId: tenantContext.tenantId,
        requestId,
        expectedStatus: decision.expectedStatus,
        nextStatus: decision.nextStatus,
        reason: decision.reason,
        changedAt,
        auditEvent,
      });
      if (!updated) {
        await recordTransitionFailure({
          principal,
          tenantContext,
          requestId,
          correlationId,
          request,
          transition,
          reasonCode: 'concurrent_state_change',
        });
        throw new RequestStateConflictError();
      }
      if (decision.nextStatus === REQUEST_STATUS.CANCELLED) {
        await synchronizeCancellation({
          principal,
          tenantContext,
          request: updated,
          correlationId,
        });
      }
      return updated;
    },
  });
}
