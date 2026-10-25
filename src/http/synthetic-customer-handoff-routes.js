import { createCustomerHandoffRouteModule } from './customer-handoff-routes.js';

// Legacy namespace and transport remain fixed by the owning composition.
export function createSyntheticCustomerHandoffRouteModule(options={}) {
  return createCustomerHandoffRouteModule({ ...options,kind: 'synthetic' });
}
