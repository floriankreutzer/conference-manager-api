import { createHash } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { normalizeRequest } from '../domain/request.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCapabilityId } from '../entitlements/capabilities.js';
import {
  assertCalendarProvider,
  classifyProviderError,
  isReservationPhase,
  normalizeAvailabilityResult,
  normalizeCancelResult,
  normalizeCreateResult,
  normalizeReservationValidation,
  normalizeUpdateResult,
} from '../integrations/calendar-contract.js';
import {
  BookingIntegrationDeniedError,
  BookingIntegrationError,
  BookingIntegrationInputError,
} from '../integrations/errors.js';

export const BOOKING_PROVIDER_OPERATION = Object.freeze({
  AVAILABILITY: 'availability',
  RESERVATION_VALIDATION: 'reservation_validation',
  CREATE: 'create',
  MODIFY: 'update',
  CANCEL: 'cancel',
});

function isActiveTenantContext(principal, tenantContext, request) {
  return Boolean(
    principal
    && tenantContext
    && request
    && principal.tenantId === tenantContext.tenantId
    && request.tenantId === tenantContext.tenantId
    && tenantContext.status === 'active',
  );
}

function normalizeOperationInput({ principal, tenantContext, request, correlationId, phase }) {
  let normalizedRequest;
  try {
    normalizedRequest = normalizeRequest(request);
  } catch {
    throw new BookingIntegrationInputError('BOOKING_REQUEST_INVALID');
  }
  if (!isInternalUuid(correlationId)) throw new BookingIntegrationInputError('BOOKING_CORRELATION_INVALID');
  if (!isReservationPhase(phase)) throw new BookingIntegrationInputError('BOOKING_RESERVATION_PHASE_INVALID');
  if (!normalizedRequest.roomId) throw new BookingIntegrationInputError('BOOKING_ROOM_REQUIRED');
  if (!isActiveTenantContext(principal, tenantContext, normalizedRequest)) {
    throw new BookingIntegrationDeniedError('BOOKING_TENANT_SCOPE_INVALID');
  }
  return normalizedRequest;
}

function createIdempotencyKey(tenantId, requestId, integrationId) {
  return createHash('sha256')
    .update(`calendar-create:v1:${tenantId}:${requestId}:${integrationId}`, 'utf8')
    .digest('hex');
}

function providerInput(request, tenantContext, correlationId, phase) {
  return Object.freeze({
    tenantId: tenantContext.tenantId,
    requestId: request.id,
    roomId: request.roomId,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    phase,
    correlationId,
  });
}

export function createBookingIntegrationService({
  repository,
  provider,
  entitlementService,
  capabilityId,
  auditService,
  authorizeOperation = async () => false,
  metrics,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.hasConflictingRequest !== 'function'
    || typeof repository.findProviderReferenceByRequest !== 'function'
    || typeof repository.createProviderReference !== 'function'
    || typeof repository.touchProviderReference !== 'function'
    || typeof repository.cancelProviderReference !== 'function'
  ) {
    throw new TypeError('BOOKING_REPOSITORY_REQUIRED');
  }
  const calendarProvider = assertCalendarProvider(provider);
  if (!entitlementService || typeof entitlementService.requireAccess !== 'function') {
    throw new TypeError('ENTITLEMENT_SERVICE_REQUIRED');
  }
  const normalizedCapabilityId = normalizeCapabilityId(capabilityId);
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.record !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof authorizeOperation !== 'function') throw new TypeError('BOOKING_AUTHORIZATION_REQUIRED');
  if (metrics && (
    typeof metrics.recordBookingOperation !== 'function'
    || typeof metrics.recordIntegrationCall !== 'function'
  )) {
    throw new TypeError('BOOKING_METRICS_INVALID');
  }
  if (typeof clock !== 'function') throw new TypeError('BOOKING_CLOCK_REQUIRED');

  async function requireAccess(context, operation, request) {
    const authorized = await authorizeOperation({
      principal: context.principal,
      tenantContext: context.tenantContext,
      request,
      operation,
    });
    if (authorized !== true) throw new BookingIntegrationDeniedError();
    await entitlementService.requireAccess({
      principal: context.principal,
      tenantContext: context.tenantContext,
      capabilityId: normalizedCapabilityId,
      authorized: true,
    });
  }

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new BookingIntegrationInputError('BOOKING_CLOCK_INVALID');
    return value;
  }

  function changedAt() {
    return new Date(now());
  }

  async function recordProviderFailure(context, request, operation, error, durationMs) {
    const classification = classifyProviderError(error, operation);
    metrics?.recordIntegrationCall({
      operation,
      outcome: 'failure',
      retryable: classification.retryable,
      durationMs,
    });
    await auditService.record({
      principal: context.principal,
      tenantContext: context.tenantContext,
      correlationId: context.correlationId,
      action: AUDIT_ACTION.CALENDAR_OPERATION,
      targetType: 'request',
      targetId: request.id,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: {
        operation,
        providerCode: classification.code,
        retryable: classification.retryable,
      },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
    });
    throw new BookingIntegrationError(classification.code, classification);
  }

  async function providerCall(context, request, operation, call) {
    const startedAt = now();
    try {
      const result = await call();
      metrics?.recordIntegrationCall({
        operation,
        outcome: 'success',
        retryable: false,
        durationMs: Math.max(0, now() - startedAt),
      });
      return result;
    } catch (error) {
      return recordProviderFailure(
        context,
        request,
        operation,
        error,
        Math.max(0, now() - startedAt),
      );
    }
  }

  async function observedBooking(operation, execute) {
    try {
      const result = await execute();
      metrics?.recordBookingOperation({ operation, outcome: 'success' });
      return result;
    } catch (error) {
      metrics?.recordBookingOperation({
        operation,
        outcome: error instanceof BookingIntegrationDeniedError ? 'denied' : 'failure',
      });
      throw error;
    }
  }

  async function localConflict(request) {
    return repository.hasConflictingRequest({
      tenantId: request.tenantId,
      roomId: request.roomId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      excludeRequestId: request.id,
    });
  }

  function successAudit(context, request, operation, phase, previousState, newState, disposition) {
    return auditService.createEvent({
      principal: context.principal,
      tenantContext: context.tenantContext,
      correlationId: context.correlationId,
      action: AUDIT_ACTION.CALENDAR_OPERATION,
      targetType: 'request',
      targetId: request.id,
      previousState,
      newState,
      outcome: AUDIT_OUTCOME.SUCCESS,
      occurredAt: changedAt().toISOString(),
      metadata: { operation, phase, disposition },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
    });
  }

  async function prepare(context, operation) {
    const request = normalizeOperationInput(context);
    await requireAccess(context, operation, request);
    return request;
  }

  return Object.freeze({
    async lookupAvailability(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.AVAILABILITY, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.AVAILABILITY);
        if (await localConflict(request)) return Object.freeze({ available: false, conflictCount: 1 });
        return providerCall(context, request, BOOKING_PROVIDER_OPERATION.AVAILABILITY, async () => {
          return normalizeAvailabilityResult(await calendarProvider.lookupAvailability(
            providerInput(request, context.tenantContext, context.correlationId, context.phase),
          ));
        });
      });
    },

    async validateReservation(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.RESERVATION_VALIDATION, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.RESERVATION_VALIDATION);
        if (await localConflict(request)) return Object.freeze({ valid: false, reason: 'conflict' });
        return providerCall(context, request, BOOKING_PROVIDER_OPERATION.RESERVATION_VALIDATION, async () => {
          return normalizeReservationValidation(await calendarProvider.validateReservation(
            providerInput(request, context.tenantContext, context.correlationId, context.phase),
          ));
        });
      });
    },

    async createCalendarEvent(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.CREATE, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.CREATE);
        const existing = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (existing?.state === 'active') return Object.freeze({ disposition: 'existing', state: 'active' });
        if (existing) throw new BookingIntegrationInputError('BOOKING_REFERENCE_CANCELLED');

        const idempotencyKey = createIdempotencyKey(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        const created = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.CREATE, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            idempotencyKey,
          };
          return normalizeCreateResult(await calendarProvider.createCalendarEvent(Object.freeze(input)));
        });
        const auditEvent = successAudit(
          context,
          request,
          BOOKING_PROVIDER_OPERATION.CREATE,
          context.phase,
          null,
          { calendarState: 'active' },
          created.disposition,
        );
        const stored = await repository.createProviderReference({
          tenantId: context.tenantContext.tenantId,
          requestId: request.id,
          integrationId: calendarProvider.integrationId,
          providerReference: created.providerReference,
          idempotencyKey,
          correlationId: context.correlationId,
          changedAt: new Date(auditEvent.occurredAt),
          auditEvent,
        });
        return Object.freeze({
          disposition: stored.created ? created.disposition : 'existing',
          state: stored.reference.state,
        });
      });
    },

    async updateCalendarEvent(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.MODIFY, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.MODIFY);
        const reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (!reference || reference.state !== 'active') {
          throw new BookingIntegrationInputError('BOOKING_REFERENCE_NOT_ACTIVE');
        }
        const updated = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.MODIFY, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: reference.providerReference,
          };
          return normalizeUpdateResult(
            await calendarProvider.updateCalendarEvent(Object.freeze(input)),
            reference.providerReference,
          );
        });
        const auditEvent = successAudit(
          context,
          request,
          BOOKING_PROVIDER_OPERATION.MODIFY,
          context.phase,
          { calendarState: 'active' },
          { calendarState: 'active' },
          updated.disposition,
        );
        await repository.touchProviderReference({
          tenantId: context.tenantContext.tenantId,
          requestId: request.id,
          integrationId: calendarProvider.integrationId,
          providerReference: reference.providerReference,
          changedAt: new Date(auditEvent.occurredAt),
          auditEvent,
        });
        return Object.freeze({ disposition: updated.disposition, state: 'active' });
      });
    },

    async cancelCalendarEvent(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.CANCEL);
        const reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (!reference) return Object.freeze({ disposition: 'not_present', state: 'cancelled' });
        if (reference.state === 'cancelled') {
          return Object.freeze({ disposition: 'already_cancelled', state: 'cancelled' });
        }
        const cancelled = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: reference.providerReference,
          };
          return normalizeCancelResult(
            await calendarProvider.cancelCalendarEvent(Object.freeze(input)),
            reference.providerReference,
          );
        });
        const auditEvent = successAudit(
          context,
          request,
          BOOKING_PROVIDER_OPERATION.CANCEL,
          context.phase,
          { calendarState: 'active' },
          { calendarState: 'cancelled' },
          cancelled.disposition,
        );
        await repository.cancelProviderReference({
          tenantId: context.tenantContext.tenantId,
          requestId: request.id,
          integrationId: calendarProvider.integrationId,
          providerReference: reference.providerReference,
          changedAt: new Date(auditEvent.occurredAt),
          auditEvent,
        });
        return Object.freeze({ disposition: cancelled.disposition, state: 'cancelled' });
      });
    },
  });
}
