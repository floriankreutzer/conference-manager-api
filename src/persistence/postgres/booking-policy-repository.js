import { DEFAULT_BOOKING_POLICY_CONFIGURATION } from '../../domain/tenant-configuration/booking-policies.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createPostgresConfigurationDomainRepository } from './configuration-domain-repository.js';

export function createPostgresBookingPolicyRepository(store) {
  return createPostgresConfigurationDomainRepository({
    store,
    domain: TENANT_CONFIGURATION_DOMAIN.BOOKING_POLICIES,
    initialize: async () => DEFAULT_BOOKING_POLICY_CONFIGURATION,
    applyProjection: async () => {},
  });
}
