import { isInternalUuid } from './domain/identifiers.js';
import { normalizeSyntheticHandoffScope } from './domain/synthetic-handoff.js';
import { createProtectedInvitedCustomerAccess } from './protected-invited-customer-access-composition.js';
import { createProtectedSyntheticCustomerAccess } from './protected-synthetic-customer-access-composition.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';
import { createCustomerEmailAuthenticationRouteModule } from './http/customer-email-authentication-routes.js';
import { createCustomerMicrosoftAuthenticationRouteModule } from './http/customer-microsoft-authentication-routes.js';
import { createCustomerInvitationRouteModule } from './http/customer-invitation-routes.js';
import { createSyntheticCustomerHandoffRouteModule } from './http/synthetic-customer-handoff-routes.js';
import { createMicrosoftRoleMappingRouteModule } from './http/settings/microsoft-role-mapping-routes.js';

const HTTP_METHODS=['resolvePrincipal','revoke','verifyCsrf','csrfTokenForPrincipal','clearCookie'];
function syntheticConfiguration(value,environment,securityEpoch,customerOrigin) {
  if (value===null) return null;
  const keys=['platformOrigin','platformSecurityEpoch','browserSecret','sourceSecret'];
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length!==keys.length || Reflect.ownKeys(value).some(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key);
      return !keys.includes(key) || !Object.hasOwn(field,'value');
    })) throw new TypeError('PROTECTED_CUSTOMER_AUTHENTICATION_CONFIGURATION_INVALID');
  return Object.freeze({ scope: normalizeSyntheticHandoffScope({ environment,securityEpoch,customerOrigin,
    platformOrigin: value.platformOrigin,platformSecurityEpoch: value.platformSecurityEpoch }),
    browserSecret: value.browserSecret,sourceSecret: value.sourceSecret });
}

// Own both admission factories and the combined resolver. Only the five normal
// HTTP session functions escape: no generic issuer/rotation/JIT or supplied
// session implementation can replace persistent REAL/delegation qualification.
export function createProtectedCustomerAuthentication({ config,persistence,leasePool,environment,securityEpoch,cipher,
  emailFlowSecret,emailCodeSecret,emailSourceSecret,microsoftClient=null,microsoftFlowSecret,synthetic=null }={}) {
  if (!config || !persistence || !isInternalUuid(securityEpoch) || !['dev','int','prod'].includes(environment)
    || config.deploymentEnvironment!==environment) throw new TypeError('PROTECTED_CUSTOMER_AUTHENTICATION_CONFIGURATION_INVALID');
  const selected=syntheticConfiguration(synthetic,environment,securityEpoch,config.publicOrigin);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: persistence.pool,leasePool,environment,securityEpoch });
  const options={ pool: persistence.pool,leasePool,environment,securityEpoch,publicOrigin: config.publicOrigin,cipher,
    auditHmacSecret: config.auditHmacSecret,csrfSecret: config.csrfSecret,sessionTtlSeconds: config.sessionTtlSeconds,
    emailFlowSecret,emailCodeSecret,emailSourceSecret,microsoftClient,microsoftFlowSecret };
  const invited=createProtectedInvitedCustomerAccess(options);
  const delegated=selected===null ? null : createProtectedSyntheticCustomerAccess({ ...options,scope: selected.scope,
    browserSecret: selected.browserSecret,sourceSecret: selected.sourceSecret });
  // The delegated factory's resolver already dispatches to actual REAL membership
  // or current synthetic delegation custody within the same namespace. Issuers
  // remain private to the separate code/Microsoft and consumed-handoff protocols.
  const resolver=delegated?.sessionService ?? invited.sessionService;
  const sessionService=Object.freeze(Object.fromEntries(HTTP_METHODS.map(name=>[name,
    ['resolvePrincipal','revoke'].includes(name) ? (...args)=>scopes.withShared(()=>resolver[name](...args))
      : resolver[name].bind(resolver)])));
  const routeModules=Object.freeze([
    createMicrosoftRoleMappingRouteModule({ service: invited.groupRoleService,publicOrigin: config.publicOrigin }),
    createCustomerEmailAuthenticationRouteModule({ service: invited.service,publicOrigin: config.publicOrigin }),
    createCustomerInvitationRouteModule({ service: invited.invitationService,publicOrigin: config.publicOrigin }),
    ...(invited.microsoft===null ? [] : [createCustomerMicrosoftAuthenticationRouteModule({ ...invited.microsoft,
      sessionService,publicOrigin: config.publicOrigin })]),
    ...(delegated===null ? [] : [createSyntheticCustomerHandoffRouteModule({ service: delegated,scope: selected.scope })]),
  ]);
  return Object.freeze({ routeModules,
    authenticationFactory(context) {
      if (context?.config!==config || context?.persistence!==persistence) {
        throw new TypeError('PROTECTED_CUSTOMER_AUTHENTICATION_CONTEXT_INVALID');
      }
      return Object.freeze({ sessionService });
    },
  });
}
