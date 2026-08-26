import { defineRouteModule } from '../route-module.js';
import { createTenantConfigurationRouteContract } from '../tenant-configuration-route.js';

const contract = createTenantConfigurationRouteContract('/api/v1/tenant/catalog');

export const catalogConfigurationRouteModule = defineRouteModule({
  id: 'tenant-catalog',
  routeKey: contract.routeKey,
  createHandler(runtime) {
    return contract.createHandler({
      ...runtime,
      service: runtime.tenantConfigurationServices?.catalog || null,
    });
  },
});
