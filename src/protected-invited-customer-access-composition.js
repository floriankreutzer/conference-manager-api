import { createAuditService } from './audit/audit-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { createCustomerEmailAdmissionService } from './identity/customer-email-admission-service.js';
import { createCustomerEmailAuthenticationService } from './identity/customer-email-authentication-service.js';
import { createCustomerEmailFlowBinding } from './identity/customer-email-flow-binding.js';
import { createCustomerEmailSourceKey } from './identity/customer-email-source-key.js';
import { createEmailMailboxProofFactory } from './identity/email-code-proof.js';
import { createProtectedInvitedCustomerSessions } from './identity/protected-invited-customer-sessions.js';
import { deriveProtectedAuthenticationFlowSecret } from './identity/protected-authentication-flow-secret.js';
import { createCustomerAccessEmailContent } from './integrations/customer-access-email-content.js';
import { createPostgresAuditRepository } from './persistence/postgres/audit-repository.js';
import { createPostgresCustomerEmailAdmissionRepository } from './persistence/postgres/customer-email-admission-repository.js';
import { createPostgresCustomerEmailChallengeRepository } from './persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from './persistence/postgres/protected-customer-access-repository.js';
import { createPostgresProtectedInvitedSessionRepository } from './persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedRealTenantScope } from './persistence/postgres/protected-real-tenant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';

// Inactive owned composition: no route installation, provider call or timer.
// Every anonymous entry acquires current deployment custody, including neutral
// unknown-recipient flows which never reach the REAL qualification predicate.
export function createProtectedInvitedCustomerAccess({ pool,leasePool,environment,securityEpoch,publicOrigin,cipher,
  auditHmacSecret,csrfSecret,emailFlowSecret,emailCodeSecret,emailSourceSecret,sessionTtlSeconds,clock } = {}) {
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch });
  const protection={ environment,securityEpoch: securityEpoch.toLowerCase() };
  const tenantScope=createPostgresProtectedRealTenantScope(pool,protection);
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: auditHmacSecret });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy: createAuthorizationPolicy(),clock });
  const sessionRepository=createPostgresProtectedInvitedSessionRepository(pool,{ ...protection,auditRepository });
  const accessRepository=createPostgresProtectedCustomerAccessRepository(pool,protection);
  const sessionService=createProtectedInvitedCustomerSessions({ ...protection,sessionRepository,accessRepository,
    auditService,publicOrigin,csrfSecret,sessionTtlSeconds,clock });
  const flowBinding=createCustomerEmailFlowBinding({ environment,
    secret: deriveProtectedAuthenticationFlowSecret({ ...protection,secret: emailFlowSecret,purpose: 'customer-email-flow' }) });
  const proofFactory=createEmailMailboxProofFactory({ environment,
    secret: deriveProtectedAuthenticationFlowSecret({ ...protection,secret: emailCodeSecret,purpose: 'customer-email-code' }) });
  // Stable across epochs so cutover cannot replenish source abuse budgets.
  const sourceKey=createCustomerEmailSourceKey({ environment,secret: emailSourceSecret });
  const content=createCustomerAccessEmailContent({ publicOrigin,environment });
  const challenges=createPostgresCustomerEmailChallengeRepository(pool,{ environment,cipher,flowBinding,proofFactory,content,
    tenantEligibility: tenantScope });
  const admissionRepository=createPostgresCustomerEmailAdmissionRepository(pool,{ environment,flowBinding,auditRepository,
    tenantEligibility: { allowsWithClient: tenantScope.lockAdmissionWithClient } });
  const admission=createCustomerEmailAdmissionService({ repository: admissionRepository,auditService,sessionService });
  const ordinary=createCustomerEmailAuthenticationService({ challenges,admission,sourceKey });
  const service=Object.freeze({
    request: input=>scopes.withShared(()=>ordinary.request(input)),
    pending: input=>scopes.withShared(()=>ordinary.pending(input)),
    verify: input=>scopes.withShared(()=>ordinary.verify(input)),
    choices: input=>scopes.withShared(()=>ordinary.choices(input)),
    select: (input,command)=>scopes.withShared(()=>ordinary.select(input,command)),
  });
  return Object.freeze({ service,sessionService });
}
