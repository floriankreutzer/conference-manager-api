import { createEntraAuthService } from './identity/entra-auth-service.js';
import { createJitUserService } from './identity/jit-user-service.js';
import { createPendingProviderIdentityResolver } from './identity/provider-identity-resolver.js';
import { createSessionService } from './identity/session-service.js';
import { createTenantOnboardingService } from './onboarding/tenant-onboarding-service.js';

const HTTP_SESSION_METHODS=Object.freeze(['resolvePrincipal','verifyCsrf','csrfTokenForPrincipal','revoke','clearCookie']);

function ownedHttpSession(factory,context) {
  if (typeof factory!=='function' || context.entraClient!==null) {
    throw new TypeError('CUSTOMER_AUTHENTICATION_COMPOSITION_INVALID');
  }
  const result=factory(Object.freeze({ config: context.config,persistence: context.persistence,auditService: context.auditService }));
  if (!result || ![Object.prototype,null].includes(Object.getPrototypeOf(result))
    || Reflect.ownKeys(result).length!==1 || !Object.hasOwn(result,'sessionService')
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(result,'sessionService'),'value')) {
    throw new TypeError('CUSTOMER_AUTHENTICATION_COMPOSITION_INVALID');
  }
  const service=result.sessionService;
  if (!service || ![Object.prototype,null].includes(Object.getPrototypeOf(service))) {
    throw new TypeError('CUSTOMER_AUTHENTICATION_COMPOSITION_INVALID');
  }
  const methods=HTTP_SESSION_METHODS.map(name=>{
    const own=Object.getOwnPropertyDescriptor(service,name);
    if (!own || !Object.hasOwn(own,'value') || typeof own.value!=='function') {
      throw new TypeError('CUSTOMER_AUTHENTICATION_COMPOSITION_INVALID');
    }
    return [name,own.value.bind(service)];
  });
  // No issue/rotate/JIT/provider admission escapes through the public HTTP port.
  // The owned composition retains its private canonical issuers and flow proof.
  return Object.freeze(Object.fromEntries(methods));
}

// Optional server-construction port only, never an environment/browser switch.
// The owned path never constructs a generic session/JIT/onboarding/OIDC service.
// Default construction below retains the existing generic Customer contract.
export function createCustomerAuthenticationComposition({ config,persistence,auditService,entraClient=null,
  authenticationFactory=null }={}) {
  if (authenticationFactory!==null) return Object.freeze({
    sessionService: ownedHttpSession(authenticationFactory,{ config,persistence,auditService,entraClient }),
    onboardingService: null,entraAuthService: null,
  });
const sessionService = persistence
  ? createSessionService({
    repository: persistence.sessionRepository,
    auditService,
    publicOrigin: config.publicOrigin,
    csrfSecret: config.csrfSecret,
    sessionTtlSeconds: config.sessionTtlSeconds,
  })
  : null;
const onboardingService = persistence && auditService
  ? createTenantOnboardingService({
    repository: persistence.tenantOnboardingRepository,
    auditService,
    transactionSecret: config.oidcTransactionSecret,
    publicOrigin: config.publicOrigin,
  })
  : null;
const jitUserService = persistence && auditService
  ? createJitUserService({
    bindingRepository: persistence.tenantOnboardingRepository,
    userRepository: persistence.jitUserRepository,
    auditService,
  })
  : null;
const identityResolver = createPendingProviderIdentityResolver({ onboardingService, jitUserService });
const entraAuthService = persistence && entraClient && sessionService
  ? createEntraAuthService({
    repository: persistence.oidcTransactionRepository,
    entraClient,
    identityResolver,
    sessionService,
    transactionSecret: config.oidcTransactionSecret,
    publicOrigin: config.publicOrigin,
    transactionTtlSeconds: config.oidcTransactionTtlSeconds,
  })
  : null;
  return Object.freeze({ sessionService,onboardingService,entraAuthService });
}
