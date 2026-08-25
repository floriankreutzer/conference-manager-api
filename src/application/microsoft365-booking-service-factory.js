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
  if (!repository) throw new TypeError('MICROSOFT365_BOOKING_REPOSITORY_REQUIRED');
  if (!calendarProviderFactory || typeof calendarProviderFactory.forRoom !== 'function') {
    throw new TypeError('MICROSOFT365_BOOKING_PROVIDER_FACTORY_REQUIRED');
  }
  if (!entitlementService || typeof entitlementService.requireAccess !== 'function') {
    throw new TypeError('MICROSOFT365_BOOKING_ENTITLEMENT_REQUIRED');
  }
  if (!auditService) throw new TypeError('MICROSOFT365_BOOKING_AUDIT_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.authorizeBookingOperation !== 'function') {
    throw new TypeError('MICROSOFT365_BOOKING_AUTHORIZATION_REQUIRED');
  }

  return Object.freeze({
    async forRequest(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request) || !request.roomId) {
        throw new TypeError('MICROSOFT365_BOOKING_REQUEST_INVALID');
      }
      const provider = await calendarProviderFactory.forRoom({
        tenantId: request.tenantId,
        roomId: request.roomId,
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
