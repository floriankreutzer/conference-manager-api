import { createTenantBookingPolicyRouteModule } from './tenant-booking-policy-routes.js';
import { createTenantCatalogRouteModule } from './tenant-catalog-routes.js';
import { createTenantCostAllocationRouteModule } from './tenant-cost-allocation-routes.js';
import { createTenantLocationsRouteModule } from './tenant-locations-routes.js';
import { createTenantOrganizationRouteModule } from './tenant-organization-routes.js';

const BRAND_ASSET_PATH = /^\/api\/v1\/tenant\/organization\/logo-assets\/([0-9a-f-]{36})$/i;
const ROUTE_KEYS = Object.freeze(new Map([
  ['/api/v1/tenant/organization', 'tenant_organization'],
  ['/api/v1/tenant/organization/logo-assets', 'tenant_organization_logo_assets'],
  ['/api/v1/tenant/locations', 'tenant_locations'],
  ['/api/v1/tenant/catalog', 'tenant_catalog'],
  ['/api/v1/tenant/booking-policy', 'tenant_booking_policy'],
  ['/api/v1/tenant/cost-allocation', 'tenant_cost_allocation'],
]));

export function tenantSettingsRouteKey(path) {
  if (BRAND_ASSET_PATH.test(path)) return 'tenant_organization_logo_asset';
  return ROUTE_KEYS.get(path) || null;
}

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
