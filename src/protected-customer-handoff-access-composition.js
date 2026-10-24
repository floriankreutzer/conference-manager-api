import { normalizeSyntheticHandoffScope } from './domain/synthetic-handoff.js';
import { normalizeOwnerCustomerAccessScope } from './domain/owner-customer-handoff.js';
import { createOwnerCustomerHandoffBrowserBinding } from './identity/owner-customer-handoff-browser-binding.js';
import { createPostgresOwnerCustomerHandoffStartRepository }
  from './persistence/postgres/owner-customer-handoff-start-repository.js';
import { createPostgresOwnerCustomerHandoffRepository } from './persistence/postgres/owner-customer-handoff-repository.js';
import { createPostgresOwnerCustomerAccessRepository } from './persistence/postgres/owner-customer-access-repository.js';
import { createAuditService } from './audit/audit-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { createSyntheticHandoffBrowserBinding } from './identity/synthetic-handoff-browser-binding.js';
import { createCustomerEmailSourceKey } from './identity/customer-email-source-key.js';
import { createSessionService } from './identity/session-service.js';
import { createProtectedCustomerSessionNamespace } from './identity/protected-customer-session-namespace.js';
import { createProtectedCustomerSessionService } from './identity/protected-customer-session-service.js';
import { createPostgresSyntheticHandoffStartRepository } from './persistence/postgres/synthetic-handoff-start-repository.js';
import { createPostgresAuditRepository } from './persistence/postgres/audit-repository.js';
import { createPostgresSessionRepository } from './persistence/postgres/session-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from './persistence/postgres/protected-customer-access-repository.js';
import { createPostgresSyntheticCustomerAccessRepository } from './persistence/postgres/synthetic-customer-access-repository.js';
import { createPostgresSyntheticCustomerHandoffRepository } from './persistence/postgres/synthetic-customer-handoff-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';

// Inactive owned Customer half. The unrestricted base issuer stays private and
// can be reached only by the atomic consumed-handoff repository. Existing REAL
// admission retains its independent invited-only issuer with the same namespace.
export function createProtectedCustomerHandoffAccess({ pool,leasePool,scope,browserSecret,sourceSecret,
  auditHmacSecret,csrfSecret,sessionTtlSeconds,clock,kind,fallbackSessionService=null }={}) {
  if (!['synthetic','owner_real'].includes(kind)) throw new TypeError('PROTECTED_CUSTOMER_HANDOFF_KIND_INVALID');
  const legacy=kind==='synthetic';
  if (!legacy && typeof fallbackSessionService?.resolvePrincipal!=='function') {
    throw new TypeError('PROTECTED_OWNER_CUSTOMER_FALLBACK_REQUIRED');
  }
  scope=legacy ? normalizeSyntheticHandoffScope(scope) : normalizeOwnerCustomerAccessScope(scope);
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,...protection });
  const browserBinding=(legacy ? createSyntheticHandoffBrowserBinding : createOwnerCustomerHandoffBrowserBinding)(
    { scope,secret: browserSecret });
  const sourceKey=createCustomerEmailSourceKey({ environment: scope.environment,secret: sourceSecret });
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: auditHmacSecret });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy: createAuthorizationPolicy(),clock });
  const base=createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: scope.customerOrigin,csrfSecret,sessionTtlSeconds,clock,
    securityNamespace: createProtectedCustomerSessionNamespace(protection) });
  const real=createPostgresProtectedCustomerAccessRepository(pool,protection);
  const delegated=(legacy ? createPostgresSyntheticCustomerAccessRepository : createPostgresOwnerCustomerAccessRepository)(pool,{ scope });
  const provider=legacy ? 'platform_delegation' : 'platform_owner';
  const qualified=createProtectedCustomerSessionService({ ...protection,sessionService: base,accessRepository: {
    resolveCurrentAccess: input=>input?.principal?.providerIdentity?.provider===provider
      ? delegated.resolveCurrentAccess(input) : real.resolveCurrentAccess(input),
  } });
  const startRepository=(legacy ? createPostgresSyntheticHandoffStartRepository : createPostgresOwnerCustomerHandoffStartRepository)(
    pool,{ scope,browserBinding });
  const repository=(legacy ? createPostgresSyntheticCustomerHandoffRepository : createPostgresOwnerCustomerHandoffRepository)(
    pool,{ scope,browserBinding,sessionService: base });
  async function resolve(request) {
    if (legacy) return qualified.resolvePrincipal(request);
    const ordinary=await base.resolvePrincipal(request);
    if (!ordinary) return null;
    return ordinary.providerIdentity.provider===provider ? qualified.resolvePrincipal(request)
      : fallbackSessionService.resolvePrincipal(request);
  }
  const sessionService=Object.freeze({
    resolvePrincipal: request=>scopes.withShared(()=>resolve(request)),
    revoke: (principal,options)=>scopes.withShared(()=>qualified.revoke(principal,options)),
    verifyCsrf: qualified.verifyCsrf,csrfTokenForPrincipal: qualified.csrfTokenForPrincipal,clearCookie: qualified.clearCookie,
  });
  return Object.freeze({ sessionService,
    start: address=>scopes.withShared(()=>{
      return startRepository.start({ sourceKey: sourceKey.fingerprint(address) });
    }),
    callback: input=>scopes.withShared(()=>repository.callback(input)),
    confirmation: input=>scopes.withShared(()=>repository.confirmation(input)),
    complete: input=>scopes.withShared(()=>repository.complete(input)),
    logout: input=>scopes.withShared(()=>repository.logout(input)),
  });
}
