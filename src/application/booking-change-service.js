import { randomUUID } from 'node:crypto';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError, AuthorizationInputError } from '../authorization/errors.js';
import {
  BOOKING_CHANGE_RECOVERY_PHASE,
  BOOKING_CHANGE_STATUS,
  normalizeBookingChange,
  normalizeBookingChangeCalendarReplacement,
} from '../domain/booking-change.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  REQUEST_COMPOSITION_SCHEMA_VERSION,
  normalizeRequestV2Draft,
} from '../domain/request-composition.js';
import { isRequestId, normalizeRequest, toPublicRequest } from '../domain/request.js';
import { RESERVATION_PHASE } from '../integrations/calendar-contract.js';
import {
  BOOKING_CHANGE_MOVE_RECOVERY,
  BookingChangeCalendarMoveError,
  BookingChangeConflictError,
  BookingChangeDependencyError,
} from './booking-change-errors.js';

class BookingChangeApprovalBlockedError extends Error {}

function reason(value) {
  if (typeof value !== 'string') throw new AuthorizationInputError('BOOKING_CHANGE_REASON_REQUIRED');
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AuthorizationInputError('BOOKING_CHANGE_REASON_INVALID');
  }
  return normalized;
}

function now(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('BOOKING_CHANGE_CLOCK_INVALID');
  return new Date(value);
}

function isPersistedProposalRequest(change, request) {
  return request.version === change.baseRequestVersion + 1
    && request.roomId === change.requestDraft.roomId
    && request.startsAt === change.requestDraft.startsAt
    && request.endsAt === change.requestDraft.endsAt
    && request.internalParticipants === change.requestDraft.internalParticipants
    && request.externalParticipants === change.requestDraft.externalParticipants
    && sameJson(request.snapshot, change.proposedRequestSnapshot);
}

function publicChange(changeValue, requestValue) {
  if (!changeValue) return null;
  let change;
  let request;
  let proposedRequest = null;
  try {
    change = normalizeBookingChange(changeValue);
    request = normalizeRequest(requestValue);
    if (
      change.tenantId !== request.tenantId
      || change.requestId !== request.id
      || request.status !== 'Confirmed'
    ) {
      throw new TypeError('BOOKING_CHANGE_PROJECTION_INVALID');
    }
    if (change.requestSchemaVersion === REQUEST_COMPOSITION_SCHEMA_VERSION) {
      const isBaseRequest = request.version === change.baseRequestVersion
        && request.updatedAt === change.baseRequestUpdatedAt;
      const isAppliedProposal = change.status === BOOKING_CHANGE_STATUS.APPLIED
        && isPersistedProposalRequest(change, request);
      if (!isBaseRequest && !isAppliedProposal) {
        throw new TypeError('BOOKING_CHANGE_PROJECTION_INVALID');
      }
      proposedRequest = toPublicRequest({
        ...request,
        schemaVersion: REQUEST_COMPOSITION_SCHEMA_VERSION,
        version: change.baseRequestVersion + 1,
        roomId: change.requestDraft.roomId,
        startsAt: change.requestDraft.startsAt,
        endsAt: change.requestDraft.endsAt,
        internalParticipants: change.requestDraft.internalParticipants,
        externalParticipants: change.requestDraft.externalParticipants,
        snapshot: change.proposedRequestSnapshot,
      });
    }
  } catch {
    throw new TypeError('BOOKING_CHANGE_PROJECTION_INVALID');
  }
  return Object.freeze({
    id: change.id,
    status: change.status,
    roomId: change.roomId,
    startsAt: change.startsAt,
    endsAt: change.endsAt,
    internalParticipants: change.internalParticipants,
    externalParticipants: change.externalParticipants,
    rejectionReason: change.rejectionReason,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    requestSchemaVersion: change.requestSchemaVersion,
    baseRequestVersion: change.baseRequestVersion,
    request: change.requestDraft,
    proposedRequest,
  });
}

function publicRequestRef(requestValue) {
  const request = normalizeRequest(requestValue);
  return Object.freeze({
    id: request.id,
    schemaVersion: request.schemaVersion,
    version: request.version,
    status: request.status,
  });
}

function publicChangeResult(change, request) {
  return Object.freeze({
    change: publicChange(change, request),
    requestRef: publicRequestRef(request),
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEmptyV2Proposal(request, draft) {
  if (request.schemaVersion !== REQUEST_COMPOSITION_SCHEMA_VERSION || !request.snapshot) return false;
  const details = request.snapshot.details;
  const allocations = request.snapshot.allocations.entries.map((entry) => ({
    costCenterId: entry.costCenterId,
    percentageBasisPoints: entry.percentageBasisPoints,
  }));
  return request.roomId === draft.roomId
    && request.startsAt === draft.startsAt
    && request.endsAt === draft.endsAt
    && request.internalParticipants === draft.internalParticipants
    && request.externalParticipants === draft.externalParticipants
    && details.title === draft.title
    && details.dietaryRequirements === draft.dietaryRequirements
    && details.specialRequirements === draft.specialRequirements
    && details.catering.participantCount === draft.catering.participantCount
    && sameJson(details.serviceIds, draft.serviceIds)
    && sameJson(details.catering.packageSelection, draft.catering.packageSelection)
    && sameJson(details.catering.itemQuantities, draft.catering.itemQuantities)
    && sameJson(allocations, draft.allocations)
    && sameJson(request.snapshot.configurationRevisions, draft.configurationRevisions);
}

function normalizeMovedCalendarResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'moved') {
    throw new TypeError('BOOKING_CHANGE_MOVE_RESULT_INVALID');
  }
  const expectedKeys = ['disposition', 'replacement', 'status'];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || !['created', 'existing'].includes(value.disposition)
  ) throw new TypeError('BOOKING_CHANGE_MOVE_RESULT_INVALID');
  let replacement;
  try {
    replacement = normalizeBookingChangeCalendarReplacement(value.replacement);
  } catch {
    throw new TypeError('BOOKING_CHANGE_MOVE_RESULT_INVALID');
  }
  return Object.freeze({
    status: 'moved',
    disposition: value.disposition,
    replacement,
  });
}

function assertBlockedCalendarResult(value) {
  if (Object.keys(value).length !== 1) {
    throw new TypeError('BOOKING_CHANGE_MOVE_RESULT_INVALID');
  }
}

export function createBookingChangeService({
  repository,
  requestRepository,
  authorizationPolicy,
  auditService,
  bookingServiceFactory,
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  for (const method of [
    'findOpen', 'propose', 'beginApproval', 'finishApproval', 'findApprovalState',
    'recordCalendarMoveTarget', 'beginCalendarMoveRollback', 'completeCalendarMoveRollback',
    'markCalendarMoveReconciliationRequired', 'returnToPending', 'reject', 'listAlternatives',
  ]) {
    if (typeof repository?.[method] !== 'function') throw new TypeError('BOOKING_CHANGE_REPOSITORY_REQUIRED');
  }
  if (typeof requestRepository?.findByTenantIdAndId !== 'function') {
    throw new TypeError('REQUEST_REPOSITORY_REQUIRED');
  }
  for (const method of [
    'authorizeRequestRead', 'authorizeBookingChangePropose', 'authorizeBookingChangeDecision',
  ]) {
    if (typeof authorizationPolicy?.[method] !== 'function') {
      throw new TypeError('BOOKING_CHANGE_AUTHORIZATION_REQUIRED');
    }
  }
  if (
    typeof auditService?.createEvent !== 'function'
    || typeof auditService?.record !== 'function'
    || typeof auditService?.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  for (const method of ['forRequest', 'moveCalendarEvent', 'rollbackCalendarMove']) {
    if (typeof bookingServiceFactory?.[method] !== 'function') {
      throw new TypeError('BOOKING_CHANGE_CALENDAR_REQUIRED');
    }
  }

  async function requestFor(tenantContext, requestId) {
    if (!isRequestId(requestId)) throw new AuthorizationInputError('REQUEST_ID_INVALID');
    const request = await requestRepository.findByTenantIdAndId(tenantContext.tenantId, requestId);
    if (!request) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
    return request;
  }

  async function recordDenied({
    principal,
    tenantContext,
    correlationId,
    requestId,
    operation,
  }) {
    if (principal?.tenantId !== tenantContext?.tenantId) return;
    await auditService.recordAuthorizationDenied({
      principal,
      tenantContext,
      correlationId,
      targetType: 'request',
      targetId: requestId,
      metadata: { operation },
    });
  }

  async function authorizedRequest({
    principal,
    tenantContext,
    correlationId,
    requestId,
    operation,
    authorize,
  }) {
    try {
      const request = await requestFor(tenantContext, requestId);
      authorizationPolicy[authorize](principal, tenantContext, request);
      return request;
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        await recordDenied({
          principal,
          tenantContext,
          correlationId,
          requestId,
          operation,
        });
      }
      throw error;
    }
  }

  function audit({ principal, tenantContext, correlationId, requestId, operation, outcome, changedAt }) {
    return auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.REQUEST_BOOKING_CHANGE,
      targetType: 'request',
      targetId: requestId,
      outcome,
      metadata: { operation },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      occurredAt: changedAt.toISOString(),
    });
  }

  function context(principal, tenantContext, correlationId, request) {
    return Object.freeze({ principal, tenantContext, correlationId, request, phase: RESERVATION_PHASE.FINAL });
  }

  function calendarAudit({
    principal,
    tenantContext,
    correlationId,
    requestId,
    operation,
    outcome,
    changedAt,
    metadata = {},
  }) {
    return auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.CALENDAR_OPERATION,
      targetType: 'request',
      targetId: requestId,
      outcome,
      metadata: { operation, ...metadata },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      occurredAt: changedAt.toISOString(),
    });
  }

  async function returnToPending(values) {
    const pending = await repository.returnToPending(values);
    if (!pending) throw new Error('BOOKING_CHANGE_PENDING_TRANSITION_FAILED');
    return pending;
  }

  return Object.freeze({
    publicChange,

    async findOpen({ principal, tenantContext, correlationId, requestId }) {
      if (!isInternalUuid(correlationId)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
      const request = await authorizedRequest({
        principal,
        tenantContext,
        correlationId,
        requestId,
        operation: 'booking_change_read',
        authorize: 'authorizeRequestRead',
      });
      return publicChangeResult(
        await repository.findOpen(tenantContext.tenantId, requestId),
        request,
      );
    },

    async propose({
      principal,
      tenantContext,
      correlationId,
      requestId,
      schemaVersion,
      expectedVersion,
      proposed,
    }) {
      if (!isInternalUuid(correlationId)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
      const request = await authorizedRequest({
        principal,
        tenantContext,
        correlationId,
        requestId,
        operation: 'booking_change_propose',
        authorize: 'authorizeBookingChangePropose',
      });
      if (schemaVersion !== REQUEST_COMPOSITION_SCHEMA_VERSION) {
        throw new AuthorizationInputError('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
      }
      if (
        !Number.isSafeInteger(expectedVersion)
        || expectedVersion < 1
        || expectedVersion >= Number.MAX_SAFE_INTEGER
      ) {
        throw new AuthorizationInputError('REQUEST_VERSION_INVALID');
      }
      const normalized = normalizeRequestV2Draft(proposed);
      if (request.version !== expectedVersion) throw new BookingChangeConflictError();
      if (isEmptyV2Proposal(request, normalized)) {
        throw new AuthorizationInputError('BOOKING_CHANGE_EMPTY');
      }
      const changeId = idFactory();
      if (!isInternalUuid(changeId)) throw new TypeError('BOOKING_CHANGE_ID_INVALID');
      const changedAt = now(clock);
      const result = await repository.propose({
        tenantId: tenantContext.tenantId,
        requestId,
        changeId,
        initiatorUserId: principal.userId,
        expectedVersion,
        proposal: normalized,
        changedAt,
        auditEvent: audit({
          principal, tenantContext, correlationId, requestId,
          operation: 'propose',
          outcome: AUDIT_OUTCOME.SUCCESS,
          changedAt,
        }),
      });
      if (result.status === 'open_exists') throw new BookingChangeConflictError('BOOKING_CHANGE_OPEN_EXISTS');
      if (result.status === 'capacity_conflict') throw new BookingChangeConflictError('BOOKING_CHANGE_CAPACITY_CONFLICT');
      if (result.status === 'configuration_conflict') throw new BookingChangeConflictError();
      if (result.status === 'conflict') throw new BookingChangeConflictError();
      return publicChangeResult(result.change, result.request);
    },

    async approve({ principal, tenantContext, correlationId, requestId, changeId }) {
      if (!isInternalUuid(correlationId) || !isInternalUuid(changeId)) {
        throw new AuthorizationInputError('BOOKING_CHANGE_ID_INVALID');
      }
      const request = await authorizedRequest({
        principal,
        tenantContext,
        correlationId,
        requestId,
        operation: 'booking_change_decision',
        authorize: 'authorizeBookingChangeDecision',
      });
      const startedAt = now(clock);
      const begun = await repository.beginApproval({
        tenantId: tenantContext.tenantId,
        requestId,
        changeId,
        deciderUserId: principal.userId,
        changedAt: startedAt,
        auditEvent: audit({
          principal, tenantContext, correlationId, requestId,
          operation: 'approve_begin', outcome: AUDIT_OUTCOME.SUCCESS, changedAt: startedAt,
        }),
      });
      if (begun.status === 'blocked') {
        return Object.freeze({
          status: 'blocked',
          alternatives: Object.freeze(begun.alternatives),
          ...publicChangeResult(begun.change, begun.request),
        });
      }
      if (begun.status === 'applied') {
        const applied = normalizeRequest(begun.request);
        if (
          applied.tenantId !== tenantContext.tenantId
          || applied.id !== requestId
          || applied.status !== 'Confirmed'
        ) throw new BookingChangeConflictError();
        return publicChangeResult(begun.change, applied);
      }
      if (begun.status === 'reconciliation_required') {
        throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED');
      }
      if (!['applying', 'finishing', 'restoring'].includes(begun.status)) {
        await recordDenied({
          principal,
          tenantContext,
          correlationId,
          requestId,
          operation: 'booking_change_decision',
        });
        throw new BookingChangeConflictError();
      }
      const proposedRequest = begun.change.requestSchemaVersion === 2
        ? normalizeRequest({
          ...begun.request,
          roomId: begun.change.requestDraft.roomId,
          startsAt: begun.change.requestDraft.startsAt,
          endsAt: begun.change.requestDraft.endsAt,
          internalParticipants: begun.change.requestDraft.internalParticipants,
          externalParticipants: begun.change.requestDraft.externalParticipants,
          schemaVersion: 2,
          version: begun.change.baseRequestVersion + 1,
          snapshot: begun.change.proposedRequestSnapshot,
        })
        : normalizeRequest({
          ...begun.request,
          roomId: begun.change.roomId,
          startsAt: begun.change.startsAt,
          endsAt: begun.change.endsAt,
          internalParticipants: begun.change.internalParticipants,
          externalParticipants: begun.change.externalParticipants,
        });
      const roomMove = begun.request.roomId !== proposedRequest.roomId;
      let move = begun.status === 'finishing'
        ? Object.freeze({ replacement: begun.change.calendarReplacement })
        : null;
      let calendarMutationAttempted = false;
      let calendarMoveReturned = false;
      let calendarMoveRecorded = begun.status === 'finishing';
      let finishAttempted = false;
      const alternatives = () => repository.listAlternatives({
        tenantId: tenantContext.tenantId,
        requestId,
        startsAt: new Date(proposedRequest.startsAt),
        endsAt: new Date(proposedRequest.endsAt),
        participants: proposedRequest.internalParticipants + proposedRequest.externalParticipants,
      });
      async function markReconciliationRequired(cause, calendarReplacement = null) {
        let replacement = null;
        if (calendarReplacement !== null) {
          try {
            replacement = normalizeBookingChangeCalendarReplacement(calendarReplacement);
          } catch (normalizationError) {
            cause = new AggregateError([cause, normalizationError]);
          }
        }
        const changedAt = now(clock);
        try {
          const marked = await repository.markCalendarMoveReconciliationRequired({
            tenantId: tenantContext.tenantId,
            requestId,
            changeId,
            moveAttemptNumber: begun.change.moveAttemptNumber,
            calendarReplacement: replacement,
            changedAt,
            auditEvent: audit({
              principal, tenantContext, correlationId, requestId,
              operation: 'approve_reconciliation_required',
              outcome: AUDIT_OUTCOME.FAILURE,
              changedAt,
            }),
            calendarAuditEvent: calendarAudit({
              principal,
              tenantContext,
              correlationId,
              requestId,
              operation: 'room_move_reconciliation_required',
              outcome: AUDIT_OUTCOME.FAILURE,
              changedAt,
            }),
          });
          if (!marked) throw new Error('BOOKING_CHANGE_RECONCILIATION_STATE_NOT_PERSISTED');
        } catch (persistenceError) {
          throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
            cause: new AggregateError([cause, persistenceError]),
          });
        }
        throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
          cause,
        });
      }

      async function blockedResult(pendingChange) {
        try {
          return Object.freeze({
            status: 'blocked',
            alternatives: Object.freeze(await alternatives()),
            ...publicChangeResult(pendingChange, begun.request),
          });
        } catch (error) {
          throw new BookingChangeDependencyError(undefined, { cause: error });
        }
      }

      async function approvalState() {
        return repository.findApprovalState({
          tenantId: tenantContext.tenantId,
          requestId,
          changeId,
        });
      }

      function matchingTargetState(state, replacement) {
        return state?.status === 'applying'
          && state.change?.moveAttemptNumber === begun.change.moveAttemptNumber
          && state.change?.recoveryPhase === BOOKING_CHANGE_RECOVERY_PHASE.TARGET_ACTIVE
          && sameJson(state.change.calendarReplacement, replacement);
      }

      async function recordCalendarMoveTarget(replacement, { outcome, disposition = null }) {
        const recordedAt = now(clock);
        try {
          const recorded = await repository.recordCalendarMoveTarget({
            tenantId: tenantContext.tenantId,
            requestId,
            changeId,
            moveAttemptNumber: begun.change.moveAttemptNumber,
            calendarReplacement: replacement,
            changedAt: recordedAt,
            auditEvent: audit({
              principal, tenantContext, correlationId, requestId,
              operation: 'approve_target_active', outcome, changedAt: recordedAt,
            }),
            calendarAuditEvent: calendarAudit({
              principal,
              tenantContext,
              correlationId,
              requestId,
              operation: 'room_move',
              outcome,
              changedAt: recordedAt,
              ...(disposition === null ? {} : { metadata: { disposition } }),
            }),
          });
          if (recorded) {
            calendarMoveRecorded = true;
            return Object.freeze({ status: 'recorded', change: recorded });
          }
        } catch (error) {
          let state = null;
          try {
            state = await approvalState();
          } catch (stateError) {
            return markReconciliationRequired(
              new AggregateError([error, stateError]),
              replacement,
            );
          }
          if (state?.status === 'applied') return state;
          if (matchingTargetState(state, replacement)) {
            calendarMoveRecorded = true;
            return Object.freeze({ status: 'recorded', change: state.change });
          }
          return markReconciliationRequired(error, replacement);
        }
        let state = null;
        try {
          state = await approvalState();
        } catch (error) {
          return markReconciliationRequired(error, replacement);
        }
        if (state?.status === 'applied') return state;
        if (matchingTargetState(state, replacement)) {
          calendarMoveRecorded = true;
          return Object.freeze({ status: 'recorded', change: state.change });
        }
        return markReconciliationRequired(
          new Error('BOOKING_CHANGE_TARGET_STATE_NOT_PERSISTED'),
          replacement,
        );
      }

      async function recordRoomMoveFailure(cause) {
        try {
          await auditService.record({
            principal,
            tenantContext,
            correlationId,
            action: AUDIT_ACTION.CALENDAR_OPERATION,
            targetType: 'request',
            targetId: requestId,
            outcome: AUDIT_OUTCOME.FAILURE,
            metadata: { operation: 'room_move', retryable: true },
            retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
          });
          return cause;
        } catch (auditError) {
          return new AggregateError([cause, auditError], 'BOOKING_CHANGE_FAILURE_AUDIT_UNAVAILABLE');
        }
      }

      async function restoreCalendarMove(calendarReplacement, cause) {
        const rollbackAt = now(clock);
        let restoring;
        try {
          restoring = await repository.beginCalendarMoveRollback({
            tenantId: tenantContext.tenantId,
            requestId,
            changeId,
            moveAttemptNumber: begun.change.moveAttemptNumber,
            changedAt: rollbackAt,
            auditEvent: audit({
              principal, tenantContext, correlationId, requestId,
              operation: 'approve_recovery_begin',
              outcome: AUDIT_OUTCOME.FAILURE,
              changedAt: rollbackAt,
            }),
          });
        } catch (error) {
          return markReconciliationRequired(
            new AggregateError([cause, error]),
            calendarReplacement,
          );
        }
        if (!restoring?.calendarReplacement) {
          return markReconciliationRequired(cause, calendarReplacement);
        }
        let restoration;
        try {
          restoration = await bookingServiceFactory.rollbackCalendarMove(
            context(principal, tenantContext, correlationId, begun.request),
            begun.request,
            proposedRequest,
            changeId,
            begun.change.moveAttemptNumber,
            restoring.calendarReplacement,
          );
        } catch (error) {
          throw new BookingChangeDependencyError(undefined, {
            cause: new AggregateError([cause, error]),
          });
        }
        const restoredAt = now(clock);
        try {
          const pending = await repository.completeCalendarMoveRollback({
            tenantId: tenantContext.tenantId,
            requestId,
            changeId,
            moveAttemptNumber: begun.change.moveAttemptNumber,
            restoration,
            changedAt: restoredAt,
            auditEvent: audit({
              principal, tenantContext, correlationId, requestId,
              operation: 'approve_retry_pending',
              outcome: AUDIT_OUTCOME.FAILURE,
              changedAt: restoredAt,
            }),
            calendarAuditEvent: calendarAudit({
              principal,
              tenantContext,
              correlationId,
              requestId,
              operation: 'room_move_restore',
              outcome: AUDIT_OUTCOME.SUCCESS,
              changedAt: restoredAt,
            }),
          });
          if (!pending) throw new Error('BOOKING_CHANGE_ROLLBACK_STATE_NOT_PERSISTED');
          return pending;
        } catch (error) {
          let state = null;
          try {
            state = await approvalState();
          } catch {
            // The persisted phase remains the fail-closed recovery authority.
          }
          if (state?.status === 'pending') return state.change;
          if (
            state?.status === 'applying'
            && state.change?.moveAttemptNumber === begun.change.moveAttemptNumber
            && state.change?.recoveryPhase === BOOKING_CHANGE_RECOVERY_PHASE.RESTORE_PENDING
            && sameJson(state.change.calendarReplacement, restoring.calendarReplacement)
          ) {
            throw new BookingChangeDependencyError(undefined, {
              cause: new AggregateError([cause, error]),
            });
          }
          return markReconciliationRequired(
            new AggregateError([cause, error]),
            restoring.calendarReplacement,
          );
        }
      }

      if (begun.status === 'restoring') {
        await restoreCalendarMove(
          begun.change.calendarReplacement,
          new Error('BOOKING_CHANGE_RECOVERY_RESUMED'),
        );
        throw new BookingChangeDependencyError(undefined, {
          cause: new Error('BOOKING_CHANGE_RECOVERY_COMPLETED_RETRY_REQUIRED'),
        });
      }
      try {
        const scheduleUnchanged = begun.request.startsAt === proposedRequest.startsAt
          && begun.request.endsAt === proposedRequest.endsAt;
        if (begun.status === 'finishing') {
          // The target-active phase resumes directly at the atomic database finish.
        } else if (begun.request.roomId === proposedRequest.roomId && scheduleUnchanged) {
          // Composition-only changes have no calendar-side representation.
        } else if (begun.request.roomId === proposedRequest.roomId) {
          const booking = await bookingServiceFactory.forRequest(proposedRequest);
          const bookingContext = context(principal, tenantContext, correlationId, proposedRequest);
          const validation = await booking.validateReservation(bookingContext);
          if (!validation.valid) {
            const blockedAt = now(clock);
            const pending = await returnToPending({
              tenantId: tenantContext.tenantId, requestId, changeId, changedAt: blockedAt,
              auditEvent: audit({ principal, tenantContext, correlationId, requestId,
                operation: 'approve_blocked', outcome: AUDIT_OUTCOME.FAILURE, changedAt: blockedAt }),
            });
            return blockedResult(pending);
          }
          calendarMutationAttempted = true;
          await booking.updateCalendarEvent(bookingContext);
        } else {
          move = await bookingServiceFactory.moveCalendarEvent(
            context(principal, tenantContext, correlationId, begun.request),
            begun.request,
            proposedRequest,
            changeId,
            begun.change.moveAttemptNumber,
          );
          if (move?.status === 'blocked') {
            try {
              assertBlockedCalendarResult(move);
            } catch (error) {
              throw new BookingChangeCalendarMoveError(
                BOOKING_CHANGE_MOVE_RECOVERY.RECONCILIATION_REQUIRED,
                { cause: error },
              );
            }
            const blockedAt = now(clock);
            const pending = await returnToPending({
              tenantId: tenantContext.tenantId, requestId, changeId, changedAt: blockedAt,
              auditEvent: audit({ principal, tenantContext, correlationId, requestId,
                operation: 'approve_blocked', outcome: AUDIT_OUTCOME.FAILURE, changedAt: blockedAt }),
            });
            return blockedResult(pending);
          }
          calendarMoveReturned = true;
          try {
            move = normalizeMovedCalendarResult(move);
          } catch (error) {
            let replacement = null;
            try {
              replacement = normalizeBookingChangeCalendarReplacement(move?.replacement);
            } catch {
              return markReconciliationRequired(error);
            }
            const recorded = await recordCalendarMoveTarget(replacement, {
              outcome: AUDIT_OUTCOME.FAILURE,
            });
            if (recorded.status === 'applied') {
              return publicChangeResult(recorded.change, recorded.request);
            }
            throw error;
          }
          const recorded = await recordCalendarMoveTarget(move.replacement, {
            outcome: AUDIT_OUTCOME.SUCCESS,
            disposition: move.disposition,
          });
          if (recorded.status === 'applied') {
            return publicChangeResult(recorded.change, recorded.request);
          }
        }
        const finishedAt = now(clock);
        finishAttempted = true;
        const finished = await repository.finishApproval({
          tenantId: tenantContext.tenantId,
          requestId,
          changeId,
          changedAt: finishedAt,
          calendarReplacement: move?.replacement ?? null,
          auditEvent: audit({
            principal, tenantContext, correlationId, requestId,
            operation: 'approve_applied', outcome: AUDIT_OUTCOME.SUCCESS, changedAt: finishedAt,
          }),
        });
        if (finished.status === 'blocked') throw new BookingChangeApprovalBlockedError();
        if (finished.status !== 'applied') throw new BookingChangeConflictError();
        return publicChangeResult(finished.change, finished.request);
      } catch (error) {
        if (
          error instanceof BookingChangeDependencyError
          && error.code === 'BOOKING_CHANGE_RECONCILIATION_REQUIRED'
        ) throw error;
        if (finishAttempted) {
          let reconciliation;
          try {
            reconciliation = await approvalState();
          } catch (reconciliationError) {
            throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
              cause: new AggregateError([error, reconciliationError]),
            });
          }
          if (reconciliation?.status === 'applied') {
            return publicChangeResult(reconciliation.change, reconciliation.request);
          }
          if (reconciliation?.status !== 'applying') {
            throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
              cause: error,
            });
          }
          if (roomMove) {
            if (!matchingTargetState(reconciliation, move?.replacement)) {
              throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
                cause: error,
              });
            }
            calendarMoveRecorded = true;
          }
        }
        const failure = roomMove ? await recordRoomMoveFailure(error) : error;
        if (error instanceof BookingChangeCalendarMoveError) {
          if (error.recovery === BOOKING_CHANGE_MOVE_RECOVERY.RECONCILIATION_REQUIRED) {
            return markReconciliationRequired(failure, error.calendarReplacement);
          }
          if (error.recovery === BOOKING_CHANGE_MOVE_RECOVERY.RETRY_SAME_ATTEMPT) {
            throw new BookingChangeDependencyError(undefined, { cause: failure });
          }
          const failedAt = now(clock);
          try {
            await returnToPending({
              tenantId: tenantContext.tenantId,
              requestId,
              changeId,
              changedAt: failedAt,
              auditEvent: audit({
                principal, tenantContext, correlationId, requestId,
                operation: 'approve_retry_pending', outcome: AUDIT_OUTCOME.FAILURE,
                changedAt: failedAt,
              }),
            });
          } catch (pendingError) {
            throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
              cause: new AggregateError([failure, pendingError]),
            });
          }
          throw new BookingChangeDependencyError(undefined, { cause: failure });
        }

        if (roomMove && calendarMoveRecorded) {
          const pending = await restoreCalendarMove(move.replacement, failure);
          if (failure instanceof BookingChangeApprovalBlockedError) {
            return blockedResult(pending);
          }
          if (failure instanceof BookingChangeConflictError) throw failure;
          throw new BookingChangeDependencyError(undefined, { cause: failure });
        }
        if (roomMove && calendarMoveReturned) {
          let replacement = null;
          try {
            replacement = normalizeBookingChangeCalendarReplacement(move?.replacement);
          } catch {
            return markReconciliationRequired(failure);
          }
          const recorded = await recordCalendarMoveTarget(replacement, {
            outcome: AUDIT_OUTCOME.FAILURE,
          });
          if (recorded.status === 'applied') {
            return publicChangeResult(recorded.change, recorded.request);
          }
          await restoreCalendarMove(replacement, failure);
          throw new BookingChangeDependencyError(undefined, { cause: failure });
        }
        let pendingAfterCompensation = null;
        try {
          if (calendarMutationAttempted) {
            const rollback = await bookingServiceFactory.forRequest(begun.request);
            await rollback.updateCalendarEvent(context(
              principal,
              tenantContext,
              correlationId,
              begun.request,
            ));
          }
          const failedAt = now(clock);
          pendingAfterCompensation = await returnToPending({
            tenantId: tenantContext.tenantId,
            requestId,
            changeId,
            changedAt: failedAt,
            auditEvent: audit({
              principal, tenantContext, correlationId, requestId,
              operation: failure instanceof BookingChangeApprovalBlockedError
                ? 'approve_blocked'
                : 'approve_retry_pending',
              outcome: AUDIT_OUTCOME.FAILURE,
              changedAt: failedAt,
            }),
          });
        } catch (compensationError) {
          throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
            cause: new AggregateError([failure, compensationError]),
          });
        }
        if (failure instanceof BookingChangeApprovalBlockedError) {
          return blockedResult(pendingAfterCompensation);
        }
        if (failure instanceof BookingChangeConflictError) throw failure;
        throw new BookingChangeDependencyError(undefined, { cause: failure });
      }
    },

    async reject({ principal, tenantContext, correlationId, requestId, changeId, rejectionReason }) {
      if (!isInternalUuid(correlationId) || !isInternalUuid(changeId)) {
        throw new AuthorizationInputError('BOOKING_CHANGE_ID_INVALID');
      }
      const request = await authorizedRequest({
        principal,
        tenantContext,
        correlationId,
        requestId,
        operation: 'booking_change_decision',
        authorize: 'authorizeBookingChangeDecision',
      });
      const changedAt = now(clock);
      const rejected = await repository.reject({
        tenantId: tenantContext.tenantId,
        requestId,
        changeId,
        deciderUserId: principal.userId,
        reason: reason(rejectionReason),
        changedAt,
        auditEvent: audit({
          principal, tenantContext, correlationId, requestId,
          operation: 'reject', outcome: AUDIT_OUTCOME.SUCCESS, changedAt,
        }),
      });
      if (!rejected) {
        await recordDenied({
          principal,
          tenantContext,
          correlationId,
          requestId,
          operation: 'booking_change_decision',
        });
        throw new BookingChangeConflictError();
      }
      return publicChangeResult(rejected, request);
    },
  });
}
