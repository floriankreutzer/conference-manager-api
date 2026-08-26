import { defineRouteModule } from '../route-module.js';
import { createTenantConfigurationRouteContract } from '../tenant-configuration-route.js';

const contract = createTenantConfigurationRouteContract('/api/v1/tenant/organization');

export const organizationConfigurationRouteModule = defineRouteModule({
  id: 'tenant-organization',
  routeKey: contract.routeKey,
  createHandler(runtime) {
    return contract.createHandler({
      ...runtime,
      service: runtime.tenantConfigurationServices?.organization || null,
    });
  },
});
