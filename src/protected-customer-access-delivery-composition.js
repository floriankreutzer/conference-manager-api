import { createCustomerAccessDeliveryWorker } from './application/customer-access-delivery-worker.js';
import { createPostgresCustomerAccessDeliveryRepository } from './persistence/postgres/customer-access-delivery-repository.js';
import { createPostgresProtectedInvitedTenantScope } from './persistence/postgres/protected-invited-tenant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';

// Composition owns both eligibility and the enclosing deployment lease. Neither
// a supplied repository nor a Tenant-only selection can bypass current member qualification.
// Provider configuration, fixed destination and bounded transport remain with
// the existing server-owned transactional email adapter.
export function createProtectedCustomerAccessDeliveryWorker({ pool,leasePool,environment,securityEpoch,
  cipher,provider,random,syntheticParticipantsEnabled=false }={}) {
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch });
  const tenantEligibility=createPostgresProtectedInvitedTenantScope(pool,{ environment,securityEpoch,syntheticParticipantsEnabled });
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
