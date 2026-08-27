import { createTenantBookingPolicyRouteModule } from './tenant-booking-policy-routes.js';
import { createTenantCatalogRouteModule } from './tenant-catalog-routes.js';
import { createTenantCostAllocationRouteModule } from './tenant-cost-allocation-routes.js';
import { createTenantLocationsRouteModule } from './tenant-locations-routes.js';
import { createTenantOrganizationRouteModule } from './tenant-organization-routes.js';

export function createTenantSettingsRouteModules({
  organizationService,
  locationsService,
  catalogService,
  bookingPolicyService,
  costAllocationService,
} = {}) {
  return Object.freeze([
    createTenantOrganizationRouteModule({ service: organizationService }),
    createTenantLocationsRouteModule({ service: locationsService }),
    createTenantCatalogRouteModule({ service: catalogService }),
    createTenantBookingPolicyRouteModule({ service: bookingPolicyService }),
    createTenantCostAllocationRouteModule({ service: costAllocationService }),
  ]);
}
