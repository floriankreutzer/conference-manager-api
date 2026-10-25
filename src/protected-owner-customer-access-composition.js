import { createProtectedCustomerHandoffAccess } from './protected-customer-handoff-access-composition.js';

// Private owned root: the unrestricted issuer remains reachable only through
// actual one-use consumed owner handoff custody. No JIT/rotation port escapes.
export function createProtectedOwnerCustomerAccess(options={}) {
  return createProtectedCustomerHandoffAccess({ ...options,kind: 'owner_real' });
}
