import { createCustomerHandoffRouteModule } from './customer-handoff-routes.js';

// Separate REAL owner transport; never infers authority from browser selection.
export function createOwnerCustomerHandoffRouteModule(options={}) {
  return createCustomerHandoffRouteModule({ ...options,kind: 'owner_real' });
}
