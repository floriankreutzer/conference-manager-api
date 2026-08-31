import { createPlatformClaimPolicy } from './platform/identity/claim-policy.js';
import { createPlatformEntraAuthService } from './platform/identity/entra-auth-service.js';
import { createPlatformEntraClient } from './platform/identity/entra-client.js';
import { createPlatformIdentityService } from './platform/identity/identity-service.js';

export function createProductionPlatformAuthentication({
  config,
  persistence,
  platformAuditService,
  platformSessionService,
} = {}) {
  if (!config || !persistence || !platformAuditService || !platformSessionService) {
    throw new TypeError('PLATFORM_PRODUCTION_AUTHENTICATION_DEPENDENCIES_REQUIRED');
  }
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
