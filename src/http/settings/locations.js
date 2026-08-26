import { defineRouteModule } from '../route-module.js';
import { createTenantConfigurationRouteContract } from '../tenant-configuration-route.js';

const contract = createTenantConfigurationRouteContract('/api/v1/tenant/locations');

export const locationConfigurationRouteModule = defineRouteModule({
  id: 'tenant-locations',
  routeKey: contract.routeKey,
  createHandler(runtime) {
    return contract.createHandler({
      ...runtime,
      service: runtime.tenantConfigurationServices?.locations || null,
    });
  },
});
