import { normalizePrincipal } from './principal.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { requireProtectedTenantRuntime } from '../tenancy/protected-tenant-runtime.js';

const REAL_PROVIDERS=new Set(['email_code','microsoft_entra']);

// The repository must resolve membership/delegation against current persistent
// custody, including ordinary session ID/version and the deployment epoch. A
// descriptor or a provider name alone is never an authentication grant.
export function createProtectedCustomerSessionService({ sessionService,accessRepository,environment,securityEpoch }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch) || !sessionService
    || ['resolvePrincipal','issue','rotate','revoke','verifyCsrf','csrfTokenForPrincipal','clearCookie']
      .some(name=>typeof sessionService[name]!=='function')
    || typeof accessRepository?.resolveCurrentAccess!=='function') {
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
        if (access.kind!=='invited_membership' || !REAL_PROVIDERS.has(principal.providerIdentity.provider)) return null;
      } else if (access.kind!=='operator_delegation' || principal.providerIdentity.provider!=='platform_delegation') return null;
      return principal;
    },
  });
}
