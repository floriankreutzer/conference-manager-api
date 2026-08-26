import { randomUUID } from 'node:crypto';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError, AuthorizationInputError } from '../authorization/errors.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId, normalizeRequest } from '../domain/request.js';
import { RESERVATION_PHASE } from '../integrations/calendar-contract.js';
import { BookingChangeConflictError, BookingChangeDependencyError } from './booking-change-errors.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function utc(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function proposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthorizationInputError('BOOKING_CHANGE_INVALID');
  }
  const keys = ['roomId', 'startsAt', 'endsAt', 'internalParticipants', 'externalParticipants'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new AuthorizationInputError('BOOKING_CHANGE_INVALID');
  }
  if (typeof value.roomId !== 'string' || !SAFE_ID.test(value.roomId)
    || !utc(value.startsAt) || !utc(value.endsAt)
    || Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    throw new AuthorizationInputError('BOOKING_CHANGE_INVALID');
  }
  for (const count of [value.internalParticipants, value.externalParticipants]) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) {
      throw new AuthorizationInputError('BOOKING_CHANGE_INVALID');
    }
  }
  if (value.internalParticipants + value.externalParticipants < 1) {
    throw new AuthorizationInputError('BOOKING_CHANGE_INVALID');
  }
  return Object.freeze({
    roomId: value.roomId,
    startsAt: new Date(value.startsAt),
    endsAt: new Date(value.endsAt),
    internalParticipants: value.internalParticipants,
    externalParticipants: value.externalParticipants,
  });
}

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

function publicChange(change) {
  if (!change) return null;
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
  });
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
    'findOpen', 'propose', 'beginApproval', 'finishApproval', 'returnToPending',
    'reject', 'listAlternatives',
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
  if (typeof auditService?.createEvent !== 'function' || typeof auditService?.record !== 'function') {
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

  return Object.freeze({
    publicChange,

    async findOpen({ principal, tenantContext, correlationId, requestId }) {
      if (!isInternalUuid(correlationId)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
      const request = await requestFor(tenantContext, requestId);
      authorizationPolicy.authorizeRequestRead(principal, tenantContext, request);
      return publicChange(await repository.findOpen(tenantContext.tenantId, requestId));
    },

    async propose({ principal, tenantContext, correlationId, requestId, proposed }) {
      if (!isInternalUuid(correlationId)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
      const request = await requestFor(tenantContext, requestId);
      authorizationPolicy.authorizeBookingChangePropose(principal, tenantContext, request);
      const normalized = proposal(proposed);
      const participantOnly = normalized.roomId === request.roomId
        && normalized.startsAt.toISOString() === request.startsAt
        && normalized.endsAt.toISOString() === request.endsAt;
      if (
        normalized.roomId === request.roomId
        && normalized.startsAt.toISOString() === request.startsAt
        && normalized.endsAt.toISOString() === request.endsAt
        && normalized.internalParticipants === request.internalParticipants
        && normalized.externalParticipants === request.externalParticipants
      ) throw new AuthorizationInputError('BOOKING_CHANGE_EMPTY');
      const changeId = idFactory();
      if (!isInternalUuid(changeId)) throw new TypeError('BOOKING_CHANGE_ID_INVALID');
      const changedAt = now(clock);
      const result = await repository.propose({
        tenantId: tenantContext.tenantId,
        requestId,
        changeId,
        initiatorUserId: principal.userId,
        proposal: normalized,
        changedAt,
        auditEvent: audit({
          principal, tenantContext, correlationId, requestId,
          operation: participantOnly ? 'participants_apply' : 'propose',
          outcome: AUDIT_OUTCOME.SUCCESS,
          changedAt,
        }),
      });
      if (result.status === 'open_exists') throw new BookingChangeConflictError('BOOKING_CHANGE_OPEN_EXISTS');
      if (result.status === 'capacity_conflict') throw new BookingChangeConflictError('BOOKING_CHANGE_CAPACITY_CONFLICT');
      if (result.status === 'conflict') throw new BookingChangeConflictError();
      return Object.freeze({ change: publicChange(result.change), request: result.request });
    },

    async approve({ principal, tenantContext, correlationId, requestId, changeId }) {
      if (!isInternalUuid(correlationId) || !isInternalUuid(changeId)) {
        throw new AuthorizationInputError('BOOKING_CHANGE_ID_INVALID');
      }
      const request = await requestFor(tenantContext, requestId);
      authorizationPolicy.authorizeBookingChangeDecision(principal, tenantContext, request);
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
        return Object.freeze({ status: 'blocked', alternatives: Object.freeze(begun.alternatives) });
      }
      if (begun.status !== 'applying') throw new BookingChangeConflictError();
      const proposedRequest = normalizeRequest({
        ...begun.request,
        roomId: begun.change.roomId,
        startsAt: begun.change.startsAt,
        endsAt: begun.change.endsAt,
        internalParticipants: begun.change.internalParticipants,
        externalParticipants: begun.change.externalParticipants,
      });
      let move = null;
      let calendarMutationAttempted = false;
      const alternatives = () => repository.listAlternatives({
        tenantId: tenantContext.tenantId,
        requestId,
        startsAt: new Date(proposedRequest.startsAt),
        endsAt: new Date(proposedRequest.endsAt),
        participants: proposedRequest.internalParticipants + proposedRequest.externalParticipants,
      });
      try {
        if (begun.request.roomId === proposedRequest.roomId) {
          const booking = await bookingServiceFactory.forRequest(proposedRequest);
          const bookingContext = context(principal, tenantContext, correlationId, proposedRequest);
          const validation = await booking.validateReservation(bookingContext);
          if (!validation.valid) {
            const blockedAt = now(clock);
            await repository.returnToPending({
              tenantId: tenantContext.tenantId, requestId, changeId, changedAt: blockedAt,
              auditEvent: audit({ principal, tenantContext, correlationId, requestId,
                operation: 'approve_blocked', outcome: AUDIT_OUTCOME.FAILURE, changedAt: blockedAt }),
            });
            return Object.freeze({ status: 'blocked', alternatives: await alternatives() });
          }
          calendarMutationAttempted = true;
          await booking.updateCalendarEvent(bookingContext);
        } else {
          move = await bookingServiceFactory.moveCalendarEvent(
            context(principal, tenantContext, correlationId, begun.request),
            begun.request,
            proposedRequest,
            changeId,
          );
          if (move.status === 'blocked') {
            const blockedAt = now(clock);
            await repository.returnToPending({
              tenantId: tenantContext.tenantId, requestId, changeId, changedAt: blockedAt,
              auditEvent: audit({ principal, tenantContext, correlationId, requestId,
                operation: 'approve_blocked', outcome: AUDIT_OUTCOME.FAILURE, changedAt: blockedAt }),
            });
            return Object.freeze({ status: 'blocked', alternatives: await alternatives() });
          }
        }
        const finishedAt = now(clock);
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
        if (finished.status !== 'applied') throw new BookingChangeConflictError();
        return Object.freeze({ status: 'applied', request: finished.request });
      } catch (error) {
        let failure = error;
        if (begun.request.roomId !== proposedRequest.roomId) {
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
          } catch (auditError) {
            failure = new AggregateError([error, auditError], 'BOOKING_CHANGE_FAILURE_AUDIT_UNAVAILABLE');
          }
        }
        try {
          if (move) {
            await bookingServiceFactory.rollbackCalendarMove(
              context(principal, tenantContext, correlationId, begun.request),
              begun.request,
              changeId,
              move,
            );
          } else if (calendarMutationAttempted) {
            const rollback = await bookingServiceFactory.forRequest(begun.request);
            await rollback.updateCalendarEvent(context(
              principal,
              tenantContext,
              correlationId,
              begun.request,
            ));
          }
          const failedAt = now(clock);
          await repository.returnToPending({
            tenantId: tenantContext.tenantId,
            requestId,
            changeId,
            changedAt: failedAt,
            auditEvent: audit({
              principal, tenantContext, correlationId, requestId,
              operation: 'approve_retry_pending', outcome: AUDIT_OUTCOME.FAILURE, changedAt: failedAt,
            }),
          });
        } catch (compensationError) {
          throw new BookingChangeDependencyError('BOOKING_CHANGE_RECONCILIATION_REQUIRED', {
            cause: new AggregateError([failure, compensationError]),
          });
        }
        if (failure instanceof BookingChangeConflictError) throw failure;
        throw new BookingChangeDependencyError(undefined, { cause: failure });
      }
    },

    async reject({ principal, tenantContext, correlationId, requestId, changeId, rejectionReason }) {
      if (!isInternalUuid(correlationId) || !isInternalUuid(changeId)) {
        throw new AuthorizationInputError('BOOKING_CHANGE_ID_INVALID');
      }
      const request = await requestFor(tenantContext, requestId);
      authorizationPolicy.authorizeBookingChangeDecision(principal, tenantContext, request);
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
      if (!rejected) throw new BookingChangeConflictError();
      return Object.freeze({ status: 'rejected', change: publicChange(rejected) });
    },
  });
}
