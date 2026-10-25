import { createPostgresCustomerHandoffAdmissionRepository } from './customer-handoff-admission-repository.js';

// REAL own identity admission only; no synthetic provider/generation fallback.
export function createPostgresOwnerCustomerHandoffRepository(pool,options={}) {
  return createPostgresCustomerHandoffAdmissionRepository(pool,{ ...options,kind: 'owner_real' });
}
