import { defineRouteModule } from '../route-module.js';
import { createTenantConfigurationRouteContract } from '../tenant-configuration-route.js';

const contract = createTenantConfigurationRouteContract('/api/v1/tenant/cost-allocation');

export const costAllocationConfigurationRouteModule = defineRouteModule({
  id: 'tenant-cost-allocation',
  routeKey: contract.routeKey,
  createHandler(runtime) {
    return contract.createHandler({
      ...runtime,
      service: runtime.tenantConfigurationServices?.costAllocation || null,
    });
  },
});
