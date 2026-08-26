import { normalizeBookingPolicyConfiguration } from '../../domain/tenant-configuration/booking-policies.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createVersionedTenantConfigurationService } from './versioned-service.js';

export function createBookingPolicyAdministrationService(options = {}) {
  return createVersionedTenantConfigurationService({
    ...options,
    domain: TENANT_CONFIGURATION_DOMAIN.BOOKING_POLICIES,
    normalize: normalizeBookingPolicyConfiguration,
  });
}
