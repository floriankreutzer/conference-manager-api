import { createPostgresCustomerHandoffStartRepository } from './customer-handoff-start-repository.js';

// Anonymous original-browser custody only, with no target lookup or authority.
export function createPostgresOwnerCustomerHandoffStartRepository(pool,options={}) {
  return createPostgresCustomerHandoffStartRepository(pool,{ ...options,kind: 'owner_real' });
}
