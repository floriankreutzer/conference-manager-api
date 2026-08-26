import { DEFAULT_COST_ALLOCATION_CONFIGURATION } from '../../domain/tenant-configuration/cost-allocation.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createPostgresConfigurationDomainRepository } from './configuration-domain-repository.js';

export function createPostgresCostAllocationRepository(store) {
  return createPostgresConfigurationDomainRepository({
    store,
    domain: TENANT_CONFIGURATION_DOMAIN.COST_ALLOCATION,
    initialize: async () => DEFAULT_COST_ALLOCATION_CONFIGURATION,
    applyProjection: async () => {},
  });
}
