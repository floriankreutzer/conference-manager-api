import { normalizeOrganizationConfiguration } from '../../domain/tenant-configuration/organization.js';
import { TENANT_CONFIGURATION_DOMAIN } from '../../domain/tenant-configuration/protocol.js';
import { createVersionedTenantConfigurationService } from './versioned-service.js';

export function createOrganizationAdministrationService(options = {}) {
  return createVersionedTenantConfigurationService({
    ...options,
    domain: TENANT_CONFIGURATION_DOMAIN.ORGANIZATION,
    normalize: normalizeOrganizationConfiguration,
  });
}
