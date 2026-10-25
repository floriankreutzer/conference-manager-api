import { definePlatformRouteModule } from './route-module.js';
import { createPlatformCustomerHandoffRouteModule } from './customer-handoff-routes.js';

export function createPlatformOwnerCustomerHandoffRouteModule(options={}) {
  return definePlatformRouteModule(createPlatformCustomerHandoffRouteModule({
    ...options,kind: 'owner_real',assuranceMode: 'microsoft_mfa' }));
}
