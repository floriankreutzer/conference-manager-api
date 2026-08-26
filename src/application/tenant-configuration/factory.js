import { createBookingPolicyAdministrationService } from './booking-policy-service.js';
import { createCatalogAdministrationService } from './catalog-service.js';
import { createCostAllocationAdministrationService } from './cost-allocation-service.js';
import { createLocationAdministrationService } from './location-service.js';
import { createOrganizationAdministrationService } from './organization-service.js';

export function createTenantConfigurationServices({
  repositories,
  authorizationPolicy,
  auditService,
  clock,
} = {}) {
  if (!repositories || typeof repositories !== 'object') {
    throw new TypeError('TENANT_CONFIGURATION_REPOSITORIES_REQUIRED');
  }
  const shared = { authorizationPolicy, auditService, ...(clock ? { clock } : {}) };
  return Object.freeze({
    organization: createOrganizationAdministrationService({
      ...shared,
      repository: repositories.organization,
    }),
    locations: createLocationAdministrationService({
      ...shared,
      repository: repositories.locations,
    }),
    catalog: createCatalogAdministrationService({
      ...shared,
      repository: repositories.catalog,
    }),
    bookingPolicies: createBookingPolicyAdministrationService({
      ...shared,
      repository: repositories.bookingPolicies,
    }),
    costAllocation: createCostAllocationAdministrationService({
      ...shared,
      repository: repositories.costAllocation,
    }),
  });
}
