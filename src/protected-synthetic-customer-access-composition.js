import { normalizeSyntheticHandoffScope } from './domain/synthetic-handoff.js';
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
export function createProtectedSyntheticCustomerAccess({ pool,leasePool,scope,browserSecret,sourceSecret,
  auditHmacSecret,csrfSecret,sessionTtlSeconds,clock }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,...protection });
  const browserBinding=createSyntheticHandoffBrowserBinding({ scope,secret: browserSecret });
  const sourceKey=createCustomerEmailSourceKey({ environment: scope.environment,secret: sourceSecret });
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: auditHmacSecret });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy: createAuthorizationPolicy(),clock });
  const base=createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: scope.customerOrigin,csrfSecret,sessionTtlSeconds,clock,
    securityNamespace: createProtectedCustomerSessionNamespace(protection) });
  const real=createPostgresProtectedCustomerAccessRepository(pool,protection);
  const synthetic=createPostgresSyntheticCustomerAccessRepository(pool,{ scope });
  const qualified=createProtectedCustomerSessionService({ ...protection,sessionService: base,accessRepository: {
    resolveCurrentAccess: input=>input?.principal?.providerIdentity?.provider==='platform_delegation'
      ? synthetic.resolveCurrentAccess(input) : real.resolveCurrentAccess(input),
  } });
  const startRepository=createPostgresSyntheticHandoffStartRepository(pool,{ scope,browserBinding });
  const repository=createPostgresSyntheticCustomerHandoffRepository(pool,{ scope,browserBinding,sessionService: base });
  const sessionService=Object.freeze({
    resolvePrincipal: request=>scopes.withShared(()=>qualified.resolvePrincipal(request)),
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
  });
}
