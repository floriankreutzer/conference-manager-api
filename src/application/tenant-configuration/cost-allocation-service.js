import { normalizeCostAllocationConfiguration } from '../../domain/tenant-configuration/cost-allocation.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createVersionedTenantConfigurationService } from './versioned-service.js';

export function createCostAllocationAdministrationService(options = {}) {
  return createVersionedTenantConfigurationService({
    ...options,
    domain: TENANT_CONFIGURATION_DOMAIN.COST_ALLOCATION,
    normalize: normalizeCostAllocationConfiguration,
  });
}
