import { defineRouteModule } from '../route-module.js';
import { createTenantConfigurationRouteContract } from '../tenant-configuration-route.js';

const contract = createTenantConfigurationRouteContract('/api/v1/tenant/booking-policies');

export const bookingPolicyConfigurationRouteModule = defineRouteModule({
  id: 'tenant-booking-policies',
  routeKey: contract.routeKey,
  createHandler(runtime) {
    return contract.createHandler({
      ...runtime,
      service: runtime.tenantConfigurationServices?.bookingPolicies || null,
    });
  },
});
