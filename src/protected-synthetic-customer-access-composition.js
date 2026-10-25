import { createProtectedCustomerHandoffAccess } from './protected-customer-handoff-access-composition.js';

export function createProtectedSyntheticCustomerAccess(options={}) {
  return createProtectedCustomerHandoffAccess({ ...options,kind: 'synthetic',fallbackSessionService: null });
}
