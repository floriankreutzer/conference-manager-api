import { normalizeCatalogConfiguration } from '../../domain/tenant-configuration/catalog.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createVersionedTenantConfigurationService } from './versioned-service.js';

export function createCatalogAdministrationService(options = {}) {
  return createVersionedTenantConfigurationService({
    ...options,
    domain: TENANT_CONFIGURATION_DOMAIN.CATALOG,
    normalize: normalizeCatalogConfiguration,
  });
}
