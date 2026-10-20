import { createSessionService } from './session-service.js';
import { createProtectedCustomerSessionNamespace } from './protected-customer-session-namespace.js';
import { createProtectedCustomerSessionService } from './protected-customer-session-service.js';
import { normalizeTrustedIdentity,normalizePrincipal } from './principal.js';

function requireInvitedProvider(identity) {
  if (!['email_code','microsoft_entra'].includes(identity.providerIdentity.provider)) {
    throw new TypeError('PROTECTED_CUSTOMER_SESSION_PROVIDER_DENIED');
  }
  return identity;
}

// Own construction of the base hash namespace. A browser-supplied environment,
// old Demo session service or custom hash prefix cannot select this boundary.
export function createProtectedInvitedCustomerSessions({ environment,securityEpoch,sessionRepository,accessRepository,
  auditService,publicOrigin,csrfSecret,sessionTtlSeconds,clock,tokenFactory,idFactory }={}) {
  const securityNamespace=createProtectedCustomerSessionNamespace({ environment,securityEpoch });
  if (typeof sessionRepository?.matchesProtectionScope!=='function'
    || sessionRepository.matchesProtectionScope({ environment,securityEpoch })!==true) {
    throw new TypeError('PROTECTED_CUSTOMER_SESSION_REPOSITORY_REQUIRED');
  }
  const base=createSessionService({ repository: sessionRepository,auditService,publicOrigin,csrfSecret,
    sessionTtlSeconds,securityNamespace,clock,tokenFactory,idFactory });
  const sessionService=Object.freeze({ ...base,
    issue(identity,options) { return base.issue(requireInvitedProvider(normalizeTrustedIdentity(identity)),options); },
    rotate(principal,identity,options) {
      return base.rotate(requireInvitedProvider(normalizePrincipal(principal)),
        requireInvitedProvider(normalizeTrustedIdentity(identity)),options);
    },
  });
  return createProtectedCustomerSessionService({ sessionService,accessRepository,environment,securityEpoch });
}
