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
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
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

function createIdempotencyKey(tenantId, requestId, integrationId, attemptNumber) {
  return createHash('sha256')
    .update(`calendar-create:v1:${tenantId}:${requestId}:${integrationId}:${attemptNumber}`, 'utf8')
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
    || typeof repository.reserveProviderResourceBinding !== 'function'
    || typeof repository.retryProviderResourceBinding !== 'function'
    || typeof repository.createProviderReference !== 'function'
    || typeof repository.touchProviderReference !== 'function'
    || typeof repository.cancelProviderReference !== 'function'
    || typeof repository.beginCompensatingProviderReference !== 'function'
    || typeof repository.completeCompensatingProviderReference !== 'function'
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
    if (operation === BOOKING_PROVIDER_OPERATION.CANCEL) return;
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

  function preConfirmationCleanupResult(disposition, state, reference = null) {
    return Object.freeze({
      disposition,
      state,
      reference: reference === null ? null : Object.freeze({
        integrationId: reference.integrationId,
        providerReference: reference.providerReference,
        providerConnectionReference: reference.providerConnectionReference,
        providerResourceReference: reference.providerResourceReference,
      }),
    });
  }

  async function prepare(context, operation) {
    const request = normalizeOperationInput(context);
    await requireAccess(context, operation, request);
    return request;
  }

  async function createAndFinalizeProviderEvent(
    context,
    request,
    reference,
    idempotencyKey,
    { allowDisconnectedCleanup = false } = {},
  ) {
    const created = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.CREATE, async () => {
      const input = {
        ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
        idempotencyKey,
        providerResourceReference: reference.providerResourceReference,
      };
      const result = normalizeCreateResult(
        await calendarProvider.createCalendarEvent(Object.freeze(input)),
      );
      if (result.providerResourceReference !== reference.providerResourceReference) {
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE, {
          operation: BOOKING_PROVIDER_OPERATION.CREATE,
        });
      }
      return result;
    });
    const auditEvent = successAudit(
      context,
      request,
      BOOKING_PROVIDER_OPERATION.CREATE,
      context.phase,
      { calendarState: reference.state },
      { calendarState: 'active' },
      created.disposition,
    );
    const authorityLossAuditEvent = successAudit(
      context,
      request,
      'create_authority_lost',
      context.phase,
      { calendarState: reference.state },
      { calendarState: 'compensating' },
      'reconciliation_started',
    );
    const stored = await repository.createProviderReference({
      tenantId: context.tenantContext.tenantId,
      requestId: request.id,
      integrationId: calendarProvider.integrationId,
      providerReference: created.providerReference,
      providerConnectionReference: calendarProvider.providerConnectionReference,
      providerResourceReference: created.providerResourceReference,
      idempotencyKey,
      correlationId: context.correlationId,
      changedAt: new Date(auditEvent.occurredAt),
      auditEvent,
      authorityLossAuditEvent,
      allowDisconnectedCleanup,
    });
    if (stored.authorityLost) {
      const cancelled = await providerCall(
        context,
        request,
        BOOKING_PROVIDER_OPERATION.CANCEL,
        async () => normalizeCancelResult(
          await calendarProvider.cancelCalendarEvent(Object.freeze({
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: stored.reference.providerReference,
            providerResourceReference: stored.reference.providerResourceReference,
          })),
          stored.reference.providerReference,
        ),
      );
      const compensatedAudit = successAudit(
        context,
        request,
        'create_authority_lost_compensate',
        context.phase,
        { calendarState: 'compensating' },
        { calendarState: 'compensated' },
        cancelled.disposition,
      );
      await repository.completeCompensatingProviderReference({
        tenantId: context.tenantContext.tenantId,
        requestId: request.id,
        integrationId: calendarProvider.integrationId,
        providerReference: stored.reference.providerReference,
        changedAt: new Date(compensatedAudit.occurredAt),
        auditEvent: compensatedAudit,
      });
      throw new BookingIntegrationError('BOOKING_CREATE_AUTHORITY_LOST', {
        operation: BOOKING_PROVIDER_OPERATION.CREATE,
      });
    }
    return Object.freeze({ created, stored });
  }

  async function reconcileReferenceForFreshCreate(context, request, reference) {
    let current = reference;
    if (current.state === 'pending') {
      const idempotencyKey = createIdempotencyKey(
        context.tenantContext.tenantId,
        request.id,
        calendarProvider.integrationId,
        current.attemptNumber,
      );
      if (current.idempotencyKey !== idempotencyKey) {
        throw new BookingIntegrationInputError('BOOKING_REFERENCE_IDEMPOTENCY_INVALID');
      }
      ({ stored: { reference: current } } = await createAndFinalizeProviderEvent(
        context,
        request,
        current,
        idempotencyKey,
      ));
    }
    if (current.state === 'active') {
      const beginAuditEvent = successAudit(
        context,
        request,
        'compensate_begin',
        context.phase,
        { calendarState: 'active' },
        { calendarState: 'compensating' },
        'started',
      );
      const compensating = await repository.beginCompensatingProviderReference({
        tenantId: context.tenantContext.tenantId,
        requestId: request.id,
        integrationId: calendarProvider.integrationId,
        providerReference: current.providerReference,
        expectedRequestVersion: request.version,
        changedAt: new Date(beginAuditEvent.occurredAt),
        auditEvent: beginAuditEvent,
      });
      if (!compensating) {
        throw new BookingIntegrationError('BOOKING_REFERENCE_RECONCILIATION_REQUIRED', {
          operation: BOOKING_PROVIDER_OPERATION.CREATE,
        });
      }
      current = compensating;
    }
    if (current.state !== 'compensating') {
      if (current.state === 'compensated') return current;
      throw new BookingIntegrationError('BOOKING_REFERENCE_RECONCILIATION_REQUIRED', {
        operation: BOOKING_PROVIDER_OPERATION.CREATE,
      });
    }
    const cancelled = await providerCall(
      context,
      request,
      BOOKING_PROVIDER_OPERATION.CANCEL,
      async () => normalizeCancelResult(
        await calendarProvider.cancelCalendarEvent(Object.freeze({
          ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
          providerReference: current.providerReference,
          providerResourceReference: current.providerResourceReference,
        })),
        current.providerReference,
      ),
    );
    const auditEvent = successAudit(
      context,
      request,
      'compensate',
      context.phase,
      { calendarState: 'compensating' },
      { calendarState: 'compensated' },
      cancelled.disposition,
    );
    return repository.completeCompensatingProviderReference({
      tenantId: context.tenantContext.tenantId,
      requestId: request.id,
      integrationId: calendarProvider.integrationId,
      providerReference: current.providerReference,
      changedAt: new Date(auditEvent.occurredAt),
      auditEvent,
    });
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
        let reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (reference && reference.state === 'cancelled') {
          throw new BookingIntegrationInputError('BOOKING_REFERENCE_CANCELLED');
        }
        if (
          reference
          && reference.state !== 'compensated'
          && (
            reference.providerConnectionReference !== calendarProvider.providerConnectionReference
          )
        ) {
          throw new BookingIntegrationInputError('BOOKING_PROVIDER_GENERATION_MISMATCH');
        }
        const resourceMatches = reference?.providerResourceReference
          === calendarProvider.providerResourceReference;
        if (reference?.state === 'active' && resourceMatches) {
          return Object.freeze({ disposition: 'existing', state: 'active' });
        }
        if (
          reference?.state === 'compensating'
          || reference?.state === 'active'
          || reference?.state === 'pending' && !resourceMatches
        ) {
          reference = await reconcileReferenceForFreshCreate(context, request, reference);
        }
        if (reference?.state === 'compensated') {
          const nextAttemptNumber = reference.attemptNumber + 1;
          const nextIdempotencyKey = createIdempotencyKey(
            context.tenantContext.tenantId,
            request.id,
            calendarProvider.integrationId,
            nextAttemptNumber,
          );
          const retryAudit = successAudit(
            context,
            request,
            BOOKING_PROVIDER_OPERATION.CREATE,
            context.phase,
            { calendarState: 'compensated', attemptNumber: reference.attemptNumber },
            { calendarState: 'pending', attemptNumber: nextAttemptNumber },
            'retry_resource_bound',
          );
          const retried = await repository.retryProviderResourceBinding({
            tenantId: context.tenantContext.tenantId,
            requestId: request.id,
            integrationId: calendarProvider.integrationId,
            providerConnectionReference: calendarProvider.providerConnectionReference,
            providerResourceReference: calendarProvider.providerResourceReference,
            nextAttemptNumber,
            idempotencyKey: nextIdempotencyKey,
            changedAt: new Date(retryAudit.occurredAt),
            auditEvent: retryAudit,
          });
          reference = retried.reference;
        }
        if (!reference) {
          const idempotencyKey = createIdempotencyKey(
            context.tenantContext.tenantId,
            request.id,
            calendarProvider.integrationId,
            1,
          );
          const bindingAudit = successAudit(
            context,
            request,
            BOOKING_PROVIDER_OPERATION.CREATE,
            context.phase,
            null,
            { calendarState: 'pending' },
            'resource_bound',
          );
          const reserved = await repository.reserveProviderResourceBinding({
            tenantId: context.tenantContext.tenantId,
            requestId: request.id,
            integrationId: calendarProvider.integrationId,
            providerConnectionReference: calendarProvider.providerConnectionReference,
            providerResourceReference: calendarProvider.providerResourceReference,
            idempotencyKey,
            correlationId: context.correlationId,
            changedAt: new Date(bindingAudit.occurredAt),
            auditEvent: bindingAudit,
          });
          reference = reserved.reference;
        }
        const idempotencyKey = createIdempotencyKey(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
          reference.attemptNumber,
        );
        if (reference.idempotencyKey !== idempotencyKey) {
          throw new BookingIntegrationInputError('BOOKING_REFERENCE_IDEMPOTENCY_INVALID');
        }
        const { created, stored } = await createAndFinalizeProviderEvent(
          context,
          request,
          reference,
          idempotencyKey,
        );
        return Object.freeze({
          disposition: stored.created ? created.disposition : 'existing',
          state: stored.reference.state,
        });
      });
    },

    async updateCalendarEvent(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.MODIFY, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.MODIFY);
        let reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (!reference || reference.state !== 'active') {
          throw new BookingIntegrationInputError('BOOKING_REFERENCE_NOT_ACTIVE');
        }
        if (
          reference.providerConnectionReference !== calendarProvider.providerConnectionReference
        ) {
          throw new BookingIntegrationInputError('BOOKING_PROVIDER_GENERATION_MISMATCH');
        }
        const updated = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.MODIFY, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: reference.providerReference,
            providerResourceReference: reference.providerResourceReference,
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
        let reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (!reference) return Object.freeze({ disposition: 'not_present', state: 'cancelled' });
        if (reference.state === 'cancelled') {
          return Object.freeze({ disposition: 'already_cancelled', state: 'cancelled' });
        }
        if (
          reference.providerConnectionReference !== calendarProvider.providerConnectionReference
        ) {
          throw new BookingIntegrationInputError('BOOKING_PROVIDER_GENERATION_MISMATCH');
        }
        if (reference.state === 'pending') {
          const idempotencyKey = createIdempotencyKey(
            context.tenantContext.tenantId,
            request.id,
            calendarProvider.integrationId,
            reference.attemptNumber,
          );
          if (reference.idempotencyKey !== idempotencyKey) {
            throw new BookingIntegrationInputError('BOOKING_REFERENCE_IDEMPOTENCY_INVALID');
          }
          ({ stored: { reference } } = await createAndFinalizeProviderEvent(
            context,
            request,
            reference,
            idempotencyKey,
            { allowDisconnectedCleanup: true },
          ));
        }
        const cancelled = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: reference.providerReference,
            providerResourceReference: reference.providerResourceReference,
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

    async cancelCalendarEventBeforeConfirmation(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.CANCEL);
        let reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (!reference) return preConfirmationCleanupResult('not_present', 'cancelled');
        if (reference.state === 'cancelled') {
          return preConfirmationCleanupResult('already_cancelled', 'cancelled');
        }
        if (
          reference.providerConnectionReference !== calendarProvider.providerConnectionReference
        ) {
          throw new BookingIntegrationInputError('BOOKING_PROVIDER_GENERATION_MISMATCH');
        }
        if (reference.state === 'pending') {
          const idempotencyKey = createIdempotencyKey(
            context.tenantContext.tenantId,
            request.id,
            calendarProvider.integrationId,
            reference.attemptNumber,
          );
          if (reference.idempotencyKey !== idempotencyKey) {
            throw new BookingIntegrationInputError('BOOKING_REFERENCE_IDEMPOTENCY_INVALID');
          }
          ({ stored: { reference } } = await createAndFinalizeProviderEvent(
            context,
            request,
            reference,
            idempotencyKey,
            { allowDisconnectedCleanup: true },
          ));
        }
        if (reference.state === 'active') {
          const beginAuditEvent = successAudit(
            context,
            request,
            'compensate_begin',
            context.phase,
            { calendarState: 'active' },
            { calendarState: 'compensating' },
            'started',
          );
          const compensating = await repository.beginCompensatingProviderReference({
            tenantId: context.tenantContext.tenantId,
            requestId: request.id,
            integrationId: calendarProvider.integrationId,
            providerReference: reference.providerReference,
            expectedRequestVersion: request.version,
            changedAt: new Date(beginAuditEvent.occurredAt),
            auditEvent: beginAuditEvent,
          });
          if (!compensating) {
            throw new BookingIntegrationError('BOOKING_REFERENCE_RECONCILIATION_REQUIRED', {
              operation: BOOKING_PROVIDER_OPERATION.CANCEL,
            });
          }
          reference = compensating;
        }
        if (reference.state === 'compensated') {
          return preConfirmationCleanupResult('already_cancelled', 'compensated', reference);
        }
        if (reference.state !== 'compensating') {
          throw new BookingIntegrationError('BOOKING_REFERENCE_RECONCILIATION_REQUIRED', {
            operation: BOOKING_PROVIDER_OPERATION.CANCEL,
          });
        }
        const cancelled = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: reference.providerReference,
            providerResourceReference: reference.providerResourceReference,
          };
          return normalizeCancelResult(
            await calendarProvider.cancelCalendarEvent(Object.freeze(input)),
            reference.providerReference,
          );
        });
        const auditEvent = successAudit(
          context,
          request,
          'compensate',
          context.phase,
          { calendarState: 'compensating' },
          { calendarState: 'compensated' },
          cancelled.disposition,
        );
        reference = await repository.completeCompensatingProviderReference({
          tenantId: context.tenantContext.tenantId,
          requestId: request.id,
          integrationId: calendarProvider.integrationId,
          providerReference: reference.providerReference,
          changedAt: new Date(auditEvent.occurredAt),
          auditEvent,
        });
        return preConfirmationCleanupResult(cancelled.disposition, 'compensated', reference);
      });
    },

    async compensateCalendarEvent(context) {
      return observedBooking(BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
        const request = await prepare(context, BOOKING_PROVIDER_OPERATION.CANCEL);
        let reference = await repository.findProviderReferenceByRequest(
          context.tenantContext.tenantId,
          request.id,
          calendarProvider.integrationId,
        );
        if (!reference) return Object.freeze({ disposition: 'not_present', state: 'compensated' });
        if (reference.state === 'compensated') {
          return Object.freeze({ disposition: 'already_cancelled', state: 'compensated' });
        }
        if (reference.state === 'cancelled') {
          return Object.freeze({ disposition: 'already_cancelled', state: 'cancelled' });
        }
        if (
          reference.providerConnectionReference !== calendarProvider.providerConnectionReference
        ) {
          throw new BookingIntegrationInputError('BOOKING_PROVIDER_GENERATION_MISMATCH');
        }
        if (reference.state === 'pending') {
          throw new BookingIntegrationError('BOOKING_REFERENCE_RECONCILIATION_REQUIRED', {
            operation: BOOKING_PROVIDER_OPERATION.CANCEL,
          });
        }
        if (reference.state === 'active') {
          const beginAuditEvent = successAudit(
            context,
            request,
            'compensate_begin',
            context.phase,
            { calendarState: 'active' },
            { calendarState: 'compensating' },
            'started',
          );
          const compensating = await repository.beginCompensatingProviderReference({
            tenantId: context.tenantContext.tenantId,
            requestId: request.id,
            integrationId: calendarProvider.integrationId,
            providerReference: reference.providerReference,
            expectedRequestVersion: request.version,
            changedAt: new Date(beginAuditEvent.occurredAt),
            auditEvent: beginAuditEvent,
          });
          if (!compensating) {
            return Object.freeze({ disposition: 'retained', state: 'active' });
          }
          reference = compensating;
        }
        const cancelled = await providerCall(context, request, BOOKING_PROVIDER_OPERATION.CANCEL, async () => {
          const input = {
            ...providerInput(request, context.tenantContext, context.correlationId, context.phase),
            providerReference: reference.providerReference,
            providerResourceReference: reference.providerResourceReference,
          };
          return normalizeCancelResult(
            await calendarProvider.cancelCalendarEvent(Object.freeze(input)),
            reference.providerReference,
          );
        });
        const auditEvent = successAudit(
          context,
          request,
          'compensate',
          context.phase,
          { calendarState: 'compensating' },
          { calendarState: 'compensated' },
          cancelled.disposition,
        );
        await repository.completeCompensatingProviderReference({
          tenantId: context.tenantContext.tenantId,
          requestId: request.id,
          integrationId: calendarProvider.integrationId,
          providerReference: reference.providerReference,
          changedAt: new Date(auditEvent.occurredAt),
          auditEvent,
        });
        return Object.freeze({ disposition: cancelled.disposition, state: 'compensated' });
      });
    },
  });
}
