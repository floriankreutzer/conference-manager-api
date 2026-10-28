import { createPostgresProtectedRealTenantScope } from './protected-real-tenant-scope.js';
import { createPostgresPlatformCustomerInvitationRepository } from './platform-customer-invitation-repository.js';

// Current Platform authorization, exact mutation proof, receipts and both audit
// domains remain canonical. The server-owned REAL predicate cannot be replaced
// through configuration and requires the exact enclosing shared deployment lease.
export function createPostgresProtectedPlatformCustomerInvitationRepository(pool,configuration={}) {
  const { environment,securityEpoch }=configuration;
  const tenantEligibility=createPostgresProtectedRealTenantScope(pool,{ environment,securityEpoch });
  return createPostgresPlatformCustomerInvitationRepository(pool,{ ...configuration,tenantEligibility,invitationCreatedWithClient: null });
}
