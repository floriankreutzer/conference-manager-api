import { createPostgresCustomerHandoffAdmissionRepository } from './customer-handoff-admission-repository.js';

// Preserve the legacy fixed synthetic custody and public factory contract.
export function createPostgresSyntheticCustomerHandoffRepository(pool,options={}) {
  return createPostgresCustomerHandoffAdmissionRepository(pool,{ ...options,kind: 'synthetic' });
}
