import { normalizeLocationsConfiguration } from '../../domain/tenant-configuration/locations.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createVersionedTenantConfigurationService } from './versioned-service.js';

export function createLocationAdministrationService(options = {}) {
  return createVersionedTenantConfigurationService({
    ...options,
    domain: TENANT_CONFIGURATION_DOMAIN.LOCATIONS,
    normalize: normalizeLocationsConfiguration,
  });
}
