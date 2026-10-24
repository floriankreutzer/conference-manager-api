import { createCustomerInvitationService } from './application/customer-invitation-service.js';
import { createAuditService } from './audit/audit-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { createCustomerEmailAdmissionService } from './identity/customer-email-admission-service.js';
import { createCustomerEmailAuthenticationService } from './identity/customer-email-authentication-service.js';
import { createCustomerEmailFlowBinding } from './identity/customer-email-flow-binding.js';
import { createCustomerMicrosoftFlowBinding } from './identity/customer-microsoft-flow-binding.js';
import { createCustomerMicrosoftAuthenticationService } from './identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftAdmissionService } from './identity/customer-microsoft-admission-service.js';
import { createCustomerEmailSourceKey } from './identity/customer-email-source-key.js';
import { createEmailMailboxProofFactory } from './identity/email-code-proof.js';
import { createProtectedInvitedCustomerSessions } from './identity/protected-invited-customer-sessions.js';
import { deriveProtectedAuthenticationFlowSecret } from './identity/protected-authentication-flow-secret.js';
import { createCustomerAccessEmailContent } from './integrations/customer-access-email-content.js';
import { createPostgresAuditRepository } from './persistence/postgres/audit-repository.js';
import { createPostgresCustomerInvitationRepository } from './persistence/postgres/customer-invitation-repository.js';
import { createPostgresCustomerEmailAdmissionRepository } from './persistence/postgres/customer-email-admission-repository.js';
import { createPostgresCustomerMicrosoftFlowRepository } from './persistence/postgres/customer-microsoft-flow-repository.js';
import { createPostgresCustomerEmailChallengeRepository } from './persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from './persistence/postgres/protected-customer-access-repository.js';
import { createPostgresProtectedInvitedSessionRepository } from './persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedRealTenantScope } from './persistence/postgres/protected-real-tenant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresTenantMicrosoftRoleRepository } from './persistence/postgres/tenant-microsoft-role-repository.js';
import { createTenantMicrosoftRoleService } from './application/tenant-microsoft-role-service.js';

// Inactive owned composition: no route installation, provider call or timer.
// Every anonymous entry acquires current deployment custody, including neutral
// unknown-recipient flows which never reach the REAL qualification predicate.
export function createProtectedInvitedCustomerAccess({ pool,leasePool,environment,securityEpoch,publicOrigin,cipher,
  auditHmacSecret,csrfSecret,emailFlowSecret,emailCodeSecret,emailSourceSecret,sessionTtlSeconds,clock,
  microsoftClient=null,microsoftFlowSecret } = {}) {
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch });
  const protection={ environment,securityEpoch: securityEpoch.toLowerCase() };
  const tenantScope=createPostgresProtectedRealTenantScope(pool,protection);
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: auditHmacSecret });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy: createAuthorizationPolicy(),clock });
  const groupRoleAdministration=createTenantMicrosoftRoleService({
    repository: createPostgresTenantMicrosoftRoleRepository(pool,{ auditRepository,tenantEligibility: tenantScope }),
    authorizationPolicy: createAuthorizationPolicy(),auditService,
  });
  const groupRoleService=Object.freeze({ get: context=>scopes.withShared(()=>groupRoleAdministration.get(context)),
    replace: (context,command)=>scopes.withShared(()=>groupRoleAdministration.replace(context,command)) });
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
  let microsoft=null;
  if (microsoftClient!==null) {
    const microsoftBinding=createCustomerMicrosoftFlowBinding({ environment,
      secret: deriveProtectedAuthenticationFlowSecret({ ...protection,secret: microsoftFlowSecret,
        purpose: 'customer-microsoft-flow' }) });
    const repository=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment,flowBinding: microsoftBinding,
      auditRepository,tenantEligibility: tenantScope });
    const authentication=createCustomerMicrosoftAuthenticationService({ repository,entraClient: microsoftClient,
      flowBinding: microsoftBinding });
    const admissionService=createCustomerMicrosoftAdmissionService({ repository,auditService,sessionService });
    microsoft=Object.freeze({
      authenticationService: Object.freeze({
        startLogin: input=>scopes.withShared(()=>authentication.startLogin(input)),
        startLink: input=>scopes.withShared(()=>authentication.startLink(input)),
        complete: input=>scopes.withShared(()=>authentication.complete(input)),
        clearCookie: authentication.clearCookie,
      }),
      admissionService: Object.freeze({
        accountState: input=>scopes.withShared(()=>admissionService.accountState(input)),
        choices: input=>scopes.withShared(()=>admissionService.choices(input)),
        select: (input,command)=>scopes.withShared(()=>admissionService.select(input,command)),
        linkConfirmation: input=>scopes.withShared(()=>admissionService.linkConfirmation(input)),
        confirmLink: (input,command)=>scopes.withShared(()=>admissionService.confirmLink(input,command)),
      }),
      sourceKey: Object.freeze({ fingerprint: sourceKey.fingerprint }),
    });
  }
  const invitationRepository=createPostgresCustomerInvitationRepository(pool,{ environment,cipher,content,auditRepository,
    tenantEligibility: { allowsWithClient: tenantScope.lockAdmissionWithClient } });
  const invitations=createCustomerInvitationService({ environment,repository: invitationRepository,auditService,
    authorizationPolicy: createAuthorizationPolicy() });
  const invitationService=Object.freeze({
    list: (context,command)=>scopes.withShared(()=>invitations.list(context,command)),
    issueBatch: (context,command)=>scopes.withShared(()=>invitations.issueBatch(context,command)),
    reissue: (context,command)=>scopes.withShared(()=>invitations.reissue(context,command)),
    revoke: (context,command)=>scopes.withShared(()=>invitations.revoke(context,command)),
  });
  return Object.freeze({ service,sessionService,microsoft,invitationService,groupRoleService });
}
