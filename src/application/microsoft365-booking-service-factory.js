import { createHash } from 'node:crypto';
import { createBookingIntegrationService } from './booking-integration-service.js';
import { CAPABILITY } from '../entitlements/capabilities.js';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';

function moveIdempotencyKey(tenantId, requestId, changeId, suffix = 'target') {
  return createHash('sha256')
    .update(`calendar-move:v1:${tenantId}:${requestId}:${changeId}:${suffix}`, 'utf8')
    .digest('hex');
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

    async moveCalendarEvent(context, currentRequest, proposedRequest, changeId) {
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
      const validation = await targetProvider.validateReservation(input);
      if (!validation.valid) return Object.freeze({ status: 'blocked' });
      const idempotencyKey = moveIdempotencyKey(
        proposedRequest.tenantId,
        proposedRequest.id,
        changeId,
      );
      const created = await targetProvider.createCalendarEvent(Object.freeze({ ...input, idempotencyKey }));
      try {
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
        }));
      } catch (error) {
        try {
          await targetProvider.cancelCalendarEvent(Object.freeze({
            ...input,
            providerReference: created.providerReference,
            providerResourceReference: targetProvider.providerResourceReference,
          }));
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'BOOKING_ROOM_MOVE_RECONCILIATION_REQUIRED');
        }
        throw error;
      }
      await auditService.record({
        principal: context.principal,
        tenantContext: context.tenantContext,
        correlationId: context.correlationId,
        action: AUDIT_ACTION.CALENDAR_OPERATION,
        targetType: 'request',
        targetId: currentRequest.id,
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { operation: 'room_move', disposition: created.disposition },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      });
      return Object.freeze({
        status: 'moved',
        replacement: Object.freeze({
          integrationId: reference.integrationId,
          previousProviderReference: reference.providerReference,
          previousProviderResourceReference: reference.providerResourceReference,
          providerReference: created.providerReference,
          providerResourceReference: targetProvider.providerResourceReference,
          idempotencyKey,
        }),
        rollback: Object.freeze({ reference, oldProvider, targetProvider, created, input }),
      });
    },

    async rollbackCalendarMove(context, currentRequest, changeId, move) {
      const { reference, oldProvider, targetProvider, created, input } = move.rollback;
      await targetProvider.cancelCalendarEvent(Object.freeze({
        ...input,
        providerReference: created.providerReference,
        providerResourceReference: targetProvider.providerResourceReference,
      }));
      const idempotencyKey = moveIdempotencyKey(
        currentRequest.tenantId,
        currentRequest.id,
        changeId,
        'restore',
      );
      const restored = await oldProvider.createCalendarEvent(Object.freeze({
        tenantId: currentRequest.tenantId,
        requestId: currentRequest.id,
        roomId: currentRequest.roomId,
        startsAt: currentRequest.startsAt,
        endsAt: currentRequest.endsAt,
        phase: context.phase,
        correlationId: context.correlationId,
        providerResourceReference: reference.providerResourceReference,
        idempotencyKey,
      }));
      const changedAt = new Date(typeof clock === 'function' ? clock() : Date.now());
      const auditEvent = auditService.createEvent({
        principal: context.principal,
        tenantContext: context.tenantContext,
        correlationId: context.correlationId,
        action: AUDIT_ACTION.CALENDAR_OPERATION,
        targetType: 'request',
        targetId: currentRequest.id,
        previousState: { calendarState: 'move_failed' },
        newState: { calendarState: 'active' },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { operation: 'room_move_compensate' },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
        occurredAt: changedAt.toISOString(),
      });
      await repository.replaceActiveProviderReference({
        tenantId: currentRequest.tenantId,
        requestId: currentRequest.id,
        integrationId: reference.integrationId,
        expectedProviderReference: reference.providerReference,
        providerReference: restored.providerReference,
        providerResourceReference: reference.providerResourceReference,
        idempotencyKey,
        changedAt,
        auditEvent,
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
