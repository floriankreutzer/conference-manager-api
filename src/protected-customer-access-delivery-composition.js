import { createCustomerAccessDeliveryWorker } from './application/customer-access-delivery-worker.js';
import { createPostgresCustomerAccessDeliveryRepository } from './persistence/postgres/customer-access-delivery-repository.js';
import { createPostgresProtectedRealDeliveryEligibility } from './persistence/postgres/protected-real-delivery-eligibility.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';

// Composition owns both eligibility and the enclosing deployment lease. Neither
// a supplied repository nor a caller-selected mode can bypass REAL qualification.
// Provider configuration, fixed destination and bounded transport remain with
// the existing server-owned transactional email adapter.
export function createProtectedCustomerAccessDeliveryWorker({ pool,leasePool,environment,securityEpoch,
  cipher,provider,random }={}) {
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch });
  const tenantEligibility=createPostgresProtectedRealDeliveryEligibility(pool,{ environment,securityEpoch });
  const repository=createPostgresCustomerAccessDeliveryRepository(pool,{ environment,cipher,tenantEligibility });
  const worker=createCustomerAccessDeliveryWorker({ repository,provider,random });let running=false;
  return Object.freeze({
    async runOnce() {
      if (running) return Object.freeze({ status: 'busy' });
      running=true;
      try { return await scopes.withShared(()=>worker.runOnce()); }
      finally { running=false; }
    },
  });
}
