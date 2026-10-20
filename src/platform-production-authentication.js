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

function passkeyAuthentication({ config, persistence, platformAuditService, platformSessionService }) {
  const environment = config.deploymentEnvironment;
  const securityEpoch = config.securityEpoch;
  const active = config.assuranceMode === 'application_passkey';
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
  const repository = createPostgresPlatformPasskeyAuthRepository(persistence.pool,
    { verifier, auditRepository: persistence.auditRepository });
  const enrollmentRepository = createPostgresPlatformPasskeyEnrollmentRepository(persistence.pool,
    { auditRepository: persistence.auditRepository });
  const primaryOperatorService = createPlatformPrimaryOperatorService({ primaryClient,
    operatorRepository: persistence.operatorRepository, auditService: platformAuditService });
  const authService = createPlatformPasskeyAuthService({ repository, primaryOperatorService, verifier,
    sessionService: platformSessionService, environment, securityEpoch, transactionSecret: config.passkeyTransactionSecret,
    allowBusinessLogin: active, minimumCredentialCount: 2 });
  const lifecycleService = createPlatformPasskeyLifecycleService({ authService, sessionService: platformSessionService,
    repository: enrollmentRepository, environment, securityEpoch });
  const enrollmentFlow = createPlatformPasskeyEnrollmentFlow({ authService, lifecycleService,
    repository: enrollmentRepository, verifier, environment, securityEpoch });
  const platformPasskeyService = createPlatformPasskeyHttpService({ authService, enrollmentFlow, lifecycleService,
    assuranceMode: config.assuranceMode, environment });
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
  const operational = active ? PLATFORM_OPERATIONAL_ROUTE_MODULES.map(module => protectPlatformPasskeyRoute(module,
    { authService, environment, securityEpoch })) : PLATFORM_OPERATIONAL_ROUTE_MODULES;
  return Object.freeze({ ...oidc, platformPasskeyService, platformHttpSessionService,
    routeModules: Object.freeze([platformPasskeyAuthenticationRoutes,platformPasskeyRoutes,...operational]) });
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
