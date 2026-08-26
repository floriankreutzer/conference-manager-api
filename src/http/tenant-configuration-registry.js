import { createRouteModuleRegistry } from './route-module.js';
import { bookingPolicyConfigurationRouteModule } from './settings/booking-policies.js';
import { catalogConfigurationRouteModule } from './settings/catalog.js';
import { costAllocationConfigurationRouteModule } from './settings/cost-allocation.js';
import { locationConfigurationRouteModule } from './settings/locations.js';
import { organizationConfigurationRouteModule } from './settings/organization.js';

const registry = createRouteModuleRegistry([
  organizationConfigurationRouteModule,
  locationConfigurationRouteModule,
  catalogConfigurationRouteModule,
  bookingPolicyConfigurationRouteModule,
  costAllocationConfigurationRouteModule,
]);

export function tenantConfigurationRouteKey(path) {
  return registry.routeKey(path);
}

export function createTenantConfigurationHttpHandler(runtime) {
  return registry.createDispatcher(runtime);
}
