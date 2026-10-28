import { normalizeOwnerCustomerAccessScope } from './domain/owner-customer-handoff.js';
import { createProtectedCustomerWriteCustody } from './protected-customer-write-composition.js';

// Compatibility construction retains the synchronous owner observation contract
// and the exact current owner/source locks. Participant selection stays absent.
export function createProtectedOwnerCustomerWriteCustody({ pool,scope: rawScope }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope);
  return createProtectedCustomerWriteCustody({ pool,environment: scope.environment,securityEpoch: scope.securityEpoch,ownerScope: scope });
}
