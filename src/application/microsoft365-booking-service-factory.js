import { createBookingIntegrationService } from './booking-integration-service.js';
import { CAPABILITY } from '../entitlements/capabilities.js';

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
