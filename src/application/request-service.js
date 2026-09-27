import { requestActorRoleAtAction } from '../authorization/policy.js';
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
import { BOOKING_OPERATION } from '../authorization/policy.js';
import {
  isRequestId,
  isRequestVersion,
} from '../domain/request.js';
import { REQUEST_STATUS, REQUEST_TRANSITION } from '../domain/request-workflow.js';
import { RESERVATION_PHASE } from '../integrations/calendar-contract.js';
import { fitPublicPage } from './public-page.js';
import {
  createRequestHistoryCursor,
  normalizeRequestHistoryQuery,
} from './request-history.js';

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function assertRequestId(requestId) {
  if (!isRequestId(requestId)) throw new AuthorizationInputError('REQUEST_ID_INVALID');
}

export class RequestCancellationReconciliationError extends Error {
  constructor(options = {}) {
    super('REQUEST_CANCELLATION_RECONCILIATION_REQUIRED', options);
    this.name = 'RequestCancellationReconciliationError';
    this.code = 'REQUEST_CANCELLATION_RECONCILIATION_REQUIRED';
  }
}

export function createRequestService({
  repository,
  authorizationPolicy,
  auditService,
  finalRoomConfirmationService,
  bookingServiceFactory = null,
  metrics = null,
  maxResponseBytes = 1_048_576,
  cursorSecret = randomUUID(),
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
    || typeof authorizationPolicy.authorizeRequestReconciliation !== 'function'
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
  if (!finalRoomConfirmationService || typeof finalRoomConfirmationService.confirm !== 'function') {
    throw new TypeError('FINAL_ROOM_CONFIRMATION_SERVICE_REQUIRED');
  }
  if (
    bookingServiceFactory !== null
    && (
      typeof bookingServiceFactory?.forCancellation !== 'function'
      || typeof bookingServiceFactory?.requiresCancellation !== 'function'
    )
  ) {
    throw new TypeError('BOOKING_SERVICE_FACTORY_INVALID');
  }
  if (
    bookingServiceFactory !== null
    && typeof authorizationPolicy.authorizeBookingOperation !== 'function'
  ) {
    throw new TypeError('BOOKING_AUTHORIZATION_REQUIRED');
  }
  if (metrics !== null && typeof metrics?.recordBookingOperation !== 'function') {
    throw new TypeError('REQUEST_METRICS_INVALID');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('REQUEST_RESPONSE_BYTES_INVALID');
  }
  if (typeof cursorSecret !== 'string' || Buffer.byteLength(cursorSecret) < 32) {
    throw new TypeError('REQUEST_CURSOR_SECRET_INVALID');
  }

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

  async function failCalendarReconciliation({
    principal,
    tenantContext,
    request,
    correlationId,
    reasonCode,
    cause,
  }) {
    metrics?.recordBookingOperation({ operation: 'cancel', outcome: 'failure' });
    let auditError = null;
    try {
      await auditService.record({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.CALENDAR_OPERATION,
        targetType: 'request',
        targetId: request.id,
        previousState: { calendarState: 'reconciliation_required' },
        outcome: AUDIT_OUTCOME.FAILURE,
        metadata: { operation: 'cancel', reasonCode },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      });
    } catch (error) {
      auditError = error;
    }
    throw new RequestCancellationReconciliationError({
      cause: auditError
        ? new AggregateError([cause, auditError], 'CALENDAR_RECONCILIATION_OBSERVABILITY_FAILED')
        : cause,
    });
  }

  async function calendarCleanupRequired({ principal, tenantContext, request, correlationId }) {
    if (!bookingServiceFactory || !request.roomId) return false;
    const authorized = authorizationPolicy.authorizeBookingOperation(
      principal,
      tenantContext,
      request,
      BOOKING_OPERATION.CANCEL,
    );
    if (authorized !== true) return false;
    try {
      return await bookingServiceFactory.requiresCancellation(request);
    } catch (error) {
      return failCalendarReconciliation({
        principal,
        tenantContext,
        request,
        correlationId,
        reasonCode: 'reference_lookup_unavailable',
        cause: error,
      });
    }
  }

  async function synchronizeCancellation({ principal, tenantContext, request, correlationId, enabled }) {
    if (!enabled) return;
    let service;
    try {
      service = await bookingServiceFactory.forCancellation(request);
      if (!service || typeof service.cancelCalendarEvent !== 'function') {
        throw new TypeError('CALENDAR_CANCELLATION_SERVICE_INVALID');
      }
    } catch (error) {
      return failCalendarReconciliation({
        principal,
        tenantContext,
        request,
        correlationId,
        reasonCode: 'cancellation_factory_unavailable',
        cause: error,
      });
    }
    try {
      await service.cancelCalendarEvent(bookingContext(
        principal,
        tenantContext,
        request,
        correlationId,
      ));
    } catch (error) {
      throw new RequestCancellationReconciliationError({ cause: error });
    }
  }

  function releaseStatusFor(transition) {
    if (transition === REQUEST_TRANSITION.CANCEL) return REQUEST_STATUS.CANCELLED;
    if (transition === REQUEST_TRANSITION.REJECT) return REQUEST_STATUS.REJECTED;
    if (transition === REQUEST_TRANSITION.REQUEST_CHANGE) return REQUEST_STATUS.CHANGE_REQUESTED;
    return null;
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

    async getRequestRoomContext({
      principal,
      tenantContext,
      requestId,
      correlationId,
      projection = null,
    }) {
      if (projection !== null && projection !== 'guest') {
        throw new AuthorizationInputError('REQUEST_ROOM_CONTEXT_PROJECTION_INVALID');
      }
      if (typeof repository.findRoomContextByTenantIdAndRoomId !== 'function') {
        throw new TypeError('REQUEST_ROOM_CONTEXT_REPOSITORY_REQUIRED');
      }
      const request = await loadRequest(tenantContext, requestId);
      if (!request) {
        await recordDenied({
          principal,
          tenantContext,
          requestId,
          correlationId,
          operation: 'room_context',
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
            operation: 'room_context',
          });
        }
        throw error;
      }

      if (projection === 'guest') {
        if (request.status !== REQUEST_STATUS.CONFIRMED) throw new RequestStateConflictError();
        if (typeof repository.findGuestContextByTenantIdAndRequest !== 'function') {
          throw new TypeError('REQUEST_GUEST_CONTEXT_REPOSITORY_REQUIRED');
        }
        const currentRoomContext = await repository.findGuestContextByTenantIdAndRequest(
          tenantContext.tenantId, request.id, request.version,
        );
        if (currentRoomContext === null) throw new RequestStateConflictError();
        return Object.freeze({
          schemaVersion: 2,
          requestRef: Object.freeze({
            id: request.id, schemaVersion: request.schemaVersion,
            version: request.version, status: request.status,
          }),
          currentRoomContext,
          requestId: correlationId,
        });
      }

      const currentRoomContext = request.roomId === null
        ? null
        : await repository.findRoomContextByTenantIdAndRoomId(
          tenantContext.tenantId,
          request.roomId,
        );
      if (request.roomId !== null && currentRoomContext === null) {
        throw new TypeError('REQUEST_ROOM_CONTEXT_INVALID');
      }
      return Object.freeze({
        schemaVersion: 1,
        requestRef: Object.freeze({
          id: request.id,
          schemaVersion: request.schemaVersion,
          version: request.version,
          status: request.status,
        }),
        currentRoomContext,
        requestId: correlationId,
      });
    },

    async getRequestHistory({
      principal,
      tenantContext,
      requestId,
      correlationId,
      query = { limit: undefined, cursor: undefined },
    }) {
      if (typeof repository.listHistoryPageByTenantIdAndId !== 'function') {
        throw new TypeError('REQUEST_HISTORY_REPOSITORY_REQUIRED');
      }
      const evaluatedAt = new Date(clock()).toISOString();
      const page = normalizeRequestHistoryQuery(query, {
        requestId,
        tenantId: tenantContext.tenantId,
        cursorSecret,
        evaluatedAt,
      });
      const request = await loadRequest(tenantContext, requestId);
      if (!request) {
        await recordDenied({
          principal,
          tenantContext,
          requestId,
          correlationId,
          operation: 'history',
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
            operation: 'history',
          });
        }
        throw error;
      }
      const asOfVersion = page.asOfVersion ?? request.version;
      if (asOfVersion > request.version) {
        throw new AuthorizationInputError('REQUEST_HISTORY_CURSOR_INVALID');
      }
      const history = await repository.listHistoryPageByTenantIdAndId(
        tenantContext.tenantId,
        requestId,
        {
          asOfVersion,
          beforeVersion: page.beforeVersion,
          limit: page.limit + 1,
        },
      );
      if (
        !Array.isArray(history)
        || history.length > page.limit + 1
        || history.some((entry, index) => (
          !Number.isSafeInteger(entry?.version)
          || entry.version < 1
          || entry.version > asOfVersion
          || (index > 0 && entry.version >= history[index - 1].version)
        ))
      ) throw new TypeError('REQUEST_HISTORY_INVALID');
      return fitPublicPage({
        items: history,
        limit: page.limit,
        maxResponseBytes,
        cursorFor: (last) => createRequestHistoryCursor({
          requestId,
          tenantId: tenantContext.tenantId,
          asOfVersion,
          beforeVersion: last.version,
          evaluatedAt,
        }, { cursorSecret }),
        resultFor: (entries, publicPage) => Object.freeze({
          schemaVersion: 3,
          asOfVersion,
          history: entries,
          page: publicPage,
          requestId: correlationId,
        }),
        envelopeFor: (result) => result,
      });
    },

    async transitionRequest({
      principal,
      tenantContext,
      requestId,
      transition,
      reason,
      expectedVersion,
      correlationId,
    }) {
      assertRequestId(requestId);
      if (!isRequestVersion(expectedVersion)) {
        throw new AuthorizationInputError('REQUEST_VERSION_PRECONDITION_INVALID');
      }
      if (transition === REQUEST_TRANSITION.CONFIRM) {
        if (reason !== undefined && reason !== null) {
          throw new AuthorizationInputError('TRANSITION_REASON_FORBIDDEN');
        }
        return finalRoomConfirmationService.confirm({
          principal,
          tenantContext,
          requestId,
          expectedVersion,
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

      const releaseStatus = releaseStatusFor(transition);
      if (releaseStatus !== null && request.status === releaseStatus) {
        try {
          const reconciliation = authorizationPolicy.authorizeRequestReconciliation(
            principal,
            tenantContext,
            request,
            transition,
            reason,
          );
          if (
            reconciliation.nextStatus !== releaseStatus
            || reconciliation.reason !== request.statusReason
            || request.version !== expectedVersion
          ) throw new RequestStateConflictError();
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
        const enabled = await calendarCleanupRequired({
          principal,
          tenantContext,
          request,
          correlationId,
        });
        await synchronizeCancellation({ principal, tenantContext, request, correlationId, enabled });
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
        if (request.version !== expectedVersion) throw new RequestStateConflictError();
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

      const releasesCalendarReservation = [
        REQUEST_STATUS.CANCELLED,
        REQUEST_STATUS.REJECTED,
        REQUEST_STATUS.CHANGE_REQUESTED,
      ].includes(decision.nextStatus);
      const synchronizeCalendarWrite = releasesCalendarReservation
        ? await calendarCleanupRequired({ principal, tenantContext, request, correlationId })
        : false;

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
      const bookingChangeAuditEvent = releasesCalendarReservation
        ? auditService.createEvent({
          principal,
          tenantContext,
          correlationId,
          action: AUDIT_ACTION.REQUEST_BOOKING_CHANGE,
          targetType: 'request',
          targetId: requestId,
          previousState: { status: 'pending' },
          newState: { status: 'superseded' },
          outcome: AUDIT_OUTCOME.SUCCESS,
          occurredAt: changedAt.toISOString(),
          metadata: {
            operation: 'supersede',
            reasonCode: 'request_released',
            transition: decision.transition,
          },
          retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
        })
        : null;
      const updated = await repository.transitionByTenantIdAndId({
        tenantId: tenantContext.tenantId,
        requestId,
        actorUserId: principal.userId,
        actorRoleAtAction: requestActorRoleAtAction(principal),
        expectedStatus: decision.expectedStatus,
        expectedVersion,
        nextStatus: decision.nextStatus,
        reason: decision.reason,
        changedAt,
        auditEvent,
        bookingChangeAuditEvent,
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
      if (releasesCalendarReservation) {
        const cleanupRequiredAfterCommit = synchronizeCalendarWrite
          || await calendarCleanupRequired({
            principal,
            tenantContext,
            request: updated,
            correlationId,
          });
        await synchronizeCancellation({
          principal,
          tenantContext,
          request: updated,
          correlationId,
          enabled: cleanupRequiredAfterCommit,
        });
      }
      return updated;
    },
  });
}
import { randomUUID } from 'node:crypto';
