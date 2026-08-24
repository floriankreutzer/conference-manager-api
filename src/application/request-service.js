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
      return updated;
    },
  });
}
