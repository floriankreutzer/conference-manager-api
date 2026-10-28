import { normalizePrincipal } from './principal.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { requireProtectedTenantRuntime } from '../tenancy/protected-tenant-runtime.js';

const REAL_PROVIDERS=new Set(['email_code','microsoft_entra']);

// The repository must resolve membership/delegation against current persistent
// custody, including ordinary session ID/version and the deployment epoch. A
// descriptor or a provider name alone is never an authentication grant.
export function createProtectedCustomerSessionService({ sessionService,accessRepository,environment,securityEpoch,
  syntheticParticipantsEnabled=false }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch) || !sessionService
    || ['resolvePrincipal','issue','rotate','revoke','verifyCsrf','csrfTokenForPrincipal','clearCookie']
      .some(name=>typeof sessionService[name]!=='function')
    || typeof accessRepository?.resolveCurrentAccess!=='function' || typeof syntheticParticipantsEnabled!=='boolean'
    || syntheticParticipantsEnabled && !['dev','int'].includes(environment)) {
    throw new TypeError('PROTECTED_CUSTOMER_SESSION_CONFIGURATION_INVALID');
  }
  return Object.freeze({ ...sessionService,
    async resolvePrincipal(request) {
      const resolved=await sessionService.resolvePrincipal(request);
      if (!resolved) return null;
      const principal=normalizePrincipal(resolved);
      const access=await accessRepository.resolveCurrentAccess({ environment,securityEpoch,principal });
      if (!access || typeof access!=='object' || Array.isArray(access)
        || Object.keys(access).sort().join(',')!=='kind,runtime') return null;
      let runtime;
      try { runtime=requireProtectedTenantRuntime({ environment,securityEpoch,tenantId: principal.tenantId },access.runtime); }
      catch { return null; }
      if (runtime.mode==='real') {
        const invited=access.kind==='invited_membership' && REAL_PROVIDERS.has(principal.providerIdentity.provider);
        const owner=access.kind==='owner_delegation' && principal.providerIdentity.provider==='platform_owner';
        if (!invited && !owner) return null;
      } else {
        const delegated=access.kind==='operator_delegation' && principal.providerIdentity.provider==='platform_delegation';
        const participant=syntheticParticipantsEnabled && access.kind==='synthetic_participant'
          && REAL_PROVIDERS.has(principal.providerIdentity.provider);
        if (!delegated && !participant) return null;
      }
      return principal;
    },
  });
}
