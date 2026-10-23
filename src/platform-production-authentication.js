import { requirePlatformPasskeyMinimum } from './platform/identity/passkey-policy.js';
import { loadPlatformConfig } from './platform/config.js';
import { createPlatformAuthorizationPolicy } from './platform/identity/policy.js';
import { createPlatformTenantTargetPolicy } from './platform/identity/tenant-target-policy.js';
import { createPlatformAuditService } from './platform/audit/audit-service.js';
import { createProtectedPlatformSessions } from './platform/identity/protected-platform-sessions.js';
import { deriveProtectedAuthenticationFlowSecret } from './identity/protected-authentication-flow-secret.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresProtectedPlatformPasskeyAuthRepository }
  from './persistence/postgres/platform-protected-passkey-auth-repository.js';
import { createPostgresPlatformAuditRepository } from './persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformOperatorRepository } from './persistence/postgres/platform-operator-repository.js';
import { createPostgresPlatformSessionRepository } from './persistence/postgres/platform-session-repository.js';
import { createPostgresPlatformOidcTransactionRepository } from './persistence/postgres/platform-oidc-transaction-repository.js';

import { createPlatformClaimPolicy } from './platform/identity/claim-policy.js';
import { createPlatformEntraAuthService } from './platform/identity/entra-auth-service.js';
import { createPlatformEntraClient } from './platform/identity/entra-client.js';
import { createPlatformIdentityService } from './platform/identity/identity-service.js';
import { createPlatformEntraPrimaryClient } from './platform/identity/entra-client.js';
import { createPlatformEntraPrimaryAuthService } from './platform/identity/entra-auth-service.js';
import { createPlatformPrimaryOperatorService } from './platform/identity/primary-operator-service.js';
import { createPlatformPasskeyVerifier } from './platform/identity/passkey-verifier.js';
import { createPlatformPasskeyAuthService } from './platform/identity/passkey-auth-service.js';
import { createPlatformPasskeyLifecycleService } from './platform/identity/passkey-lifecycle-service.js';
import { createPlatformPasskeyEnrollmentFlow } from './platform/identity/passkey-enrollment-flow.js';
import { createPlatformPasskeyHttpService } from './platform/identity/passkey-http-service.js';
import { createPostgresPlatformPasskeyAuthRepository } from './persistence/postgres/platform-passkey-auth-repository.js';
import { createPostgresPlatformPasskeyEnrollmentRepository } from './persistence/postgres/platform-passkey-enrollment-repository.js';
import { PLATFORM_OPERATIONAL_ROUTE_MODULES } from './platform/app.js';
import { platformPasskeyAuthenticationRoutes } from './platform/http/passkey-authentication-routes.js';
import { platformPasskeyRoutes } from './platform/http/passkey-routes.js';
import { protectPlatformPasskeyRoute } from './platform/http/passkey-operation-route.js';

function scopedFunctions(service,scopes,synchronous=[]) {
  return Object.freeze(Object.fromEntries(Object.entries(service).map(([name,value])=>[name,
    typeof value==='function' && !synchronous.includes(name) ? (...args)=>scopes.withShared(()=>value(...args)) : value])));
}

function passkeyAuthentication({ config, persistence, platformAuditService, platformSessionService,protectedRuntime=null }) {
  const environment = config.deploymentEnvironment;
  const securityEpoch = config.securityEpoch;
  const active = config.assuranceMode === 'application_passkey';
  const minimumCredentialCount=requirePlatformPasskeyMinimum(environment,config.minimumCredentialCount);
  if (!['dev','int','prod'].includes(environment) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 2
    || config.authenticationMaxAgeSeconds !== 300 || config.oidcTransactionTtlSeconds !== 300
    || typeof config.passkeyTransactionSecret !== 'string'
    || [config.oidcTransactionSecret, config.csrfSecret, config.auditHmacSecret, config.cursorSecret,
      config.tenantAuditHmacSecret, config.entraClientSecret].includes(config.passkeyTransactionSecret)) {
    throw new TypeError('PLATFORM_PASSKEY_COMPOSITION_CONFIGURATION_INVALID');
  }
  const primaryClient = createPlatformEntraPrimaryClient({ clientId: config.entraClientId, clientSecret: config.entraClientSecret,
    tenantReference: config.entraTenantId, authority: config.entraAuthority, redirectUri: config.entraRedirectUri,
    publicOrigin: config.publicOrigin, authenticationMaxAgeSeconds: 300 });
  const verifier = createPlatformPasskeyVerifier({ publicOrigin: config.publicOrigin, environment });
  const repository = protectedRuntime
    ? createPostgresProtectedPlatformPasskeyAuthRepository(persistence.pool,{ verifier,auditRepository: persistence.auditRepository,
      environment,securityEpoch: protectedRuntime.securityEpoch })
    : createPostgresPlatformPasskeyAuthRepository(persistence.pool,{ verifier,auditRepository: persistence.auditRepository });
  const enrollmentRepository = createPostgresPlatformPasskeyEnrollmentRepository(persistence.pool,
    { auditRepository: persistence.auditRepository });
  const primaryOperatorService = createPlatformPrimaryOperatorService({ primaryClient,
    operatorRepository: persistence.operatorRepository, auditService: platformAuditService });
  const ordinaryAuthService = createPlatformPasskeyAuthService({ repository, primaryOperatorService, verifier,
    sessionService: platformSessionService, environment, securityEpoch, transactionSecret: config.passkeyTransactionSecret,
    allowBusinessLogin: active, minimumCredentialCount });
  const pureProofMethods=['verifiedOperationPrincipal','verifiedOperationWithContinuation'];
  const authService=protectedRuntime ? scopedFunctions(ordinaryAuthService,protectedRuntime.scopes,pureProofMethods) : ordinaryAuthService;
  const lifecycleService = createPlatformPasskeyLifecycleService({ authService, sessionService: platformSessionService,
    repository: enrollmentRepository, environment, securityEpoch });
  const enrollmentFlow = createPlatformPasskeyEnrollmentFlow({ authService, lifecycleService,
    repository: enrollmentRepository, verifier, environment, securityEpoch });
  const ordinaryHttp=createPlatformPasskeyHttpService({ authService,enrollmentFlow,lifecycleService,
    assuranceMode: config.assuranceMode,environment,minimumCredentialCount });
  const platformPasskeyService=protectedRuntime ? scopedFunctions(ordinaryHttp,protectedRuntime.scopes,['configuration']) : ordinaryHttp;
  const oidc = createPlatformEntraPrimaryAuthService({ repository: persistence.oidcTransactionRepository,
    entraClient: primaryClient, passkeyAuthService: authService, auditService: platformAuditService,
    transactionSecret: config.oidcTransactionSecret, publicOrigin: config.publicOrigin, securityEpoch });
  const platformHttpSessionService = Object.freeze({ ...platformSessionService,
    async resolvePrincipal(request) {
      if (!active) return null;
      const principal = await platformSessionService.resolvePrincipal(request);
      return principal?.assurance?.authenticationContext === 'cm:pk:v1' ? principal : null;
    },
  });
  const operational = protectedRuntime ? [] : active
    ? PLATFORM_OPERATIONAL_ROUTE_MODULES.map(module => protectPlatformPasskeyRoute(module,
    { authService, environment, securityEpoch })) : PLATFORM_OPERATIONAL_ROUTE_MODULES;
  if (!protectedRuntime) return Object.freeze({ ...oidc,platformPasskeyService,platformHttpSessionService,
    routeModules: Object.freeze([platformPasskeyAuthenticationRoutes,platformPasskeyRoutes,...operational]) });
  const { scopes }=protectedRuntime;
  const qualifiedHttpSession=Object.freeze({
    resolvePrincipal: request=>scopes.withShared(async()=>{
      const principal=await platformHttpSessionService.resolvePrincipal(request);
      if (!principal || principal.assurance.level!=='mfa') return null;
      const ids=await repository.listActiveCredentialIds({ operatorId: principal.operatorId,
        operatorSecurityVersion: principal.securityVersion,environment });
      return new Set(ids).size>=minimumCredentialCount ? principal : null;
    }),
    revoke: (principal,options)=>scopes.withShared(()=>platformSessionService.revoke(principal,options)),
    verifyCsrf: platformSessionService.verifyCsrf,csrfTokenForPrincipal: platformSessionService.csrfTokenForPrincipal,
    clearCookie: platformSessionService.clearCookie,
  });
  let syntheticPasskeyService=null;
  if (active && environment!=='prod') {
    const exclusive=createPlatformPasskeyAuthService({ primaryOperatorService,verifier,sessionService: platformSessionService,
      environment,securityEpoch,transactionSecret: config.passkeyTransactionSecret,allowBusinessLogin: active,minimumCredentialCount: 2,
      repository: createPostgresProtectedPlatformPasskeyAuthRepository(persistence.pool,{ verifier,
        auditRepository: persistence.auditRepository,environment,securityEpoch: protectedRuntime.securityEpoch,
        stepUpTransaction: scopes.withSyntheticExclusive }) });
    syntheticPasskeyService=Object.freeze({
      startStepUp: (...args)=>scopes.withShared(()=>exclusive.startStepUp(...args)),
      executeStepUp: exclusive.executeStepUp,executeStepUpWithContinuation: exclusive.executeStepUpWithContinuation,
      verifiedOperationPrincipal: exclusive.verifiedOperationPrincipal,
      verifiedOperationWithContinuation: exclusive.verifiedOperationWithContinuation,
    });
  }
  return Object.freeze({ ...scopedFunctions(oidc,scopes,['clearCookie']),platformPasskeyService,
    platformHttpSessionService: qualifiedHttpSession,normalPasskeyService: authService,syntheticPasskeyService,
    routeModules: Object.freeze([platformPasskeyAuthenticationRoutes,platformPasskeyRoutes]) });
}


export function createProductionPlatformAuthentication({
  config,
  persistence,
  platformAuditService,
  platformSessionService,
} = {}) {
  if (!config || !persistence || !platformAuditService || !platformSessionService) {
    throw new TypeError('PLATFORM_PRODUCTION_AUTHENTICATION_DEPENDENCIES_REQUIRED');
  }
  const assuranceMode = config.assuranceMode || 'conditional_access';
  if (['passkey_setup','application_passkey'].includes(assuranceMode)) {
    return passkeyAuthentication({ config, persistence, platformAuditService, platformSessionService });
  }
  if (assuranceMode !== 'conditional_access') throw new TypeError('PLATFORM_ASSURANCE_MODE_INVALID');
  const entraClient = createPlatformEntraClient({
    clientId: config.entraClientId,
    clientSecret: config.entraClientSecret,
    tenantReference: config.entraTenantId,
    authority: config.entraAuthority,
    redirectUri: config.entraRedirectUri,
    publicOrigin: config.publicOrigin,
    mfaAuthenticationContext: config.mfaAuthenticationContext,
    stepUpAuthenticationContext: config.stepUpAuthenticationContext,
    authenticationMaxAgeSeconds: config.authenticationMaxAgeSeconds,
  });
  const claimPolicy = createPlatformClaimPolicy({
    provider: 'microsoft_entra',
    issuer: `${config.entraAuthority}/v2.0`,
    audience: config.entraClientId,
    tenantReference: config.entraTenantId,
    mfaAuthenticationContext: config.mfaAuthenticationContext,
    stepUpAuthenticationContext: config.stepUpAuthenticationContext,
  });
  const identityService = createPlatformIdentityService({
    claimVerifier: entraClient,
    claimPolicy,
    operatorRepository: persistence.operatorRepository,
    auditService: platformAuditService,
  });
  return createPlatformEntraAuthService({
    repository: persistence.oidcTransactionRepository,
    entraClient,
    identityService,
    sessionService: platformSessionService,
    auditService: platformAuditService,
    transactionSecret: config.oidcTransactionSecret,
    publicOrigin: config.publicOrigin,
    securityEpoch: config.securityEpoch,
    mfaAuthenticationContext: config.mfaAuthenticationContext,
    stepUpAuthenticationContext: config.stepUpAuthenticationContext,
    transactionTtlSeconds: config.oidcTransactionTtlSeconds,
  });
}


// Inactive owned construction. Environment parsing, actual repositories, current
// UUID leases, protected session namespace, environment-bound key minimum and both
// pending-flow MAC purposes are fixed here. No arbitrary legacy session/auth
// instance or caller repository can replace them. No route/process is started.
export function createProtectedPlatformAuthentication({ env,pool,leasePool,protectedSecurityEpoch,protectedEnvironment=null,
  auditSegment=null,minimumCredentialCount=2 }={}) {
  if (protectedEnvironment!==null && (!['dev','int','prod'].includes(protectedEnvironment)
    || env?.NODE_ENV!=='production' || Object.hasOwn(env,'DEPLOYMENT_ENVIRONMENT'))) {
    throw new TypeError('PROTECTED_PLATFORM_ENVIRONMENT_CONFIGURATION_INVALID');
  }
  const canonical=loadPlatformConfig(env),config=protectedEnvironment===null ? canonical
    : Object.freeze({ ...canonical,deploymentEnvironment: protectedEnvironment });
  const environment=config.deploymentEnvironment;
  requirePlatformPasskeyMinimum(environment,minimumCredentialCount);
  if (!['passkey_setup','application_passkey'].includes(config.assuranceMode)) {
    throw new TypeError('PROTECTED_PLATFORM_PASSKEY_PROFILE_REQUIRED');
  }
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch: protectedSecurityEpoch });
  const protection={ environment,securityEpoch: protectedSecurityEpoch };
  const auditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: config.auditHmacSecret,segment: auditSegment });
  const operatorRepository=createPostgresPlatformOperatorRepository(pool,{ auditRepository,protectedRuntime: protection });
  const sessionRepository=createPostgresPlatformSessionRepository(pool,{ auditRepository });
  const oidcTransactionRepository=createPostgresPlatformOidcTransactionRepository(pool);
  const platformAuditService=createPlatformAuditService({ repository: auditRepository,
    authorizationPolicy: createPlatformAuthorizationPolicy(),
    tenantTargetPolicy: createPlatformTenantTargetPolicy({ operatorRepository }) });
  const sessions=createProtectedPlatformSessions({ repository: sessionRepository,environment,protectedSecurityEpoch,
    publicOrigin: config.publicOrigin,csrfSecret: config.csrfSecret,securityEpoch: config.securityEpoch,
    sessionTtlSeconds: config.sessionTtlSeconds,stepUpTtlSeconds: config.stepUpTtlSeconds,
    authenticationMaxAgeSeconds: config.authenticationMaxAgeSeconds });
  const scopedConfig={ ...config,minimumCredentialCount,
    passkeyTransactionSecret: deriveProtectedAuthenticationFlowSecret({ ...protection,secret: config.passkeyTransactionSecret,
      purpose: 'platform-passkey-flow' }),
    oidcTransactionSecret: deriveProtectedAuthenticationFlowSecret({ ...protection,secret: config.oidcTransactionSecret,
      purpose: 'platform-microsoft-flow' }),
  };
  const authentication=passkeyAuthentication({ config: scopedConfig,
    persistence: { pool,auditRepository,operatorRepository,sessionRepository,oidcTransactionRepository },
    platformAuditService,platformSessionService: sessions,protectedRuntime: { scopes,securityEpoch: protectedSecurityEpoch } });
  return Object.freeze({ ...authentication,platformAuditService,withPreparationScope: scopes.withShared });
}
