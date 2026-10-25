import { createPostgresCustomerHandoffStartRepository } from './customer-handoff-start-repository.js';

// Preserve the existing fixed synthetic contract; callers cannot select REAL.
export function createPostgresSyntheticHandoffStartRepository(pool,options={}) {
  return createPostgresCustomerHandoffStartRepository(pool,{ ...options,kind: 'synthetic' });
}
