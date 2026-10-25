import { definePlatformRouteModule } from './route-module.js';
import { createPlatformCustomerHandoffRouteModule } from './customer-handoff-routes.js';

export function createPlatformSyntheticHandoffRouteModule(options={}) {
  return definePlatformRouteModule(createPlatformCustomerHandoffRouteModule({
    ...options,kind: 'synthetic',directory: null }));
}
