import { randomUUID } from 'node:crypto';
import { createAuditService } from './audit/audit-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { createCapabilityPolicy } from './entitlements/capabilities.js';
import { createHealthMonitor } from './observability/health.js';
import { createTenantInvitationSecretFactory } from './onboarding/invitation-policy.js';
import { createPostgresPlatformPersistence } from './persistence/postgres/platform-index.js';
import { createPlatformDiagnosticOperationsService } from './platform/application/diagnostic-operations-service.js';
import { createPlatformEntitlementOperationsService } from './platform/application/entitlement-operations-service.js';
import { createPlatformFleetReadinessService } from './platform/application/fleet-readiness-service.js';
import {
  createPlatformMeteringService,
  createPlatformUsageEventSourceAuthority,
} from './platform/application/metering-service.js';
import {
  createPlatformMicrosoftFleetHealthService,
} from './platform/application/microsoft-fleet-health-service.js';
import { createPlatformOperationEvidenceFactory } from './persistence/postgres/platform-operations-evidence.js';
import { createPlatformRecoveryOperationsService } from './platform/application/recovery-operations-service.js';
import { createPlatformRuntimeStatusService } from './platform/application/runtime-status-service.js';
import { createPlatformTenantOperationsService } from './platform/application/tenant-operations-service.js';
import { createPlatformAuditService } from './platform/audit/audit-service.js';
import { loadPlatformConfig } from './platform/config.js';
import { createPlatformClaimPolicy } from './platform/identity/claim-policy.js';
import { createPlatformEntraAuthService } from './platform/identity/entra-auth-service.js';
import { createPlatformEntraClient } from './platform/identity/entra-client.js';
import { createPlatformIdentityService } from './platform/identity/identity-service.js';
import { createPlatformAuthorizationPolicy } from './platform/identity/policy.js';
import { createPlatformBreakGlassService } from './platform/identity/break-glass-service.js';
import { createPlatformSessionService } from './platform/identity/session-service.js';
import { createPlatformTenantTargetPolicy } from './platform/identity/tenant-target-policy.js';
import { createPlatformProcess } from './platform/index.js';
import { createPlatformProjectionWorker } from './platform/projection-worker.js';
import { createTenantLifecyclePolicy } from './tenancy/tenant-lifecycle-policy.js';
import { createTenantReadinessPolicy } from './tenancy/tenant-readiness-policy.js';

const HEALTH_PRESENTATION_CONTRACT = Object.freeze({
  capabilities: Object.freeze(['places', 'free_busy', 'calendar_write']),
  connectionStates: Object.freeze(['not_configured', 'connected', 'degraded', 'disconnected']),
  permissionStates: Object.freeze(['granted', 'missing', 'unknown']),
  healthStatuses: Object.freeze([
    'healthy', 'degraded', 'unavailable', 'revoked',
    'permission_missing', 'not_configured', 'unknown',
  ]),
  incidentScopes: Object.freeze(['provider', 'tenant', 'unknown']),
});

export function createPlatformComposition({
  config = loadPlatformConfig(),
  persistence = createPostgresPlatformPersistence(config),
} = {}) {
  const authorizationPolicy = createPlatformAuthorizationPolicy();
  const tenantTargetPolicy = createPlatformTenantTargetPolicy({
    operatorRepository: persistence.operatorRepository,
  });
  const platformAuditService = createPlatformAuditService({
    repository: persistence.auditRepository,
    authorizationPolicy,
    tenantTargetPolicy,
  });
  const platformBreakGlassService = createPlatformBreakGlassService({
    repository: persistence.breakGlassRepository,
    authorizationPolicy,
    tenantTargetPolicy,
    auditService: platformAuditService,
  });
  const customerAuditService = createAuditService({
    repository: persistence.tenantAuditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const operationEvidenceFactory = createPlatformOperationEvidenceFactory({
    tenantAuditService: customerAuditService,
    platformAuditService,
  });
  const sessionService = createPlatformSessionService({
    repository: persistence.sessionRepository,
    publicOrigin: config.publicOrigin,
    csrfSecret: config.csrfSecret,
    securityEpoch: config.securityEpoch,
    sessionTtlSeconds: config.sessionTtlSeconds,
    stepUpTtlSeconds: config.stepUpTtlSeconds,
    authenticationMaxAgeSeconds: config.authenticationMaxAgeSeconds,
  });
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
  const platformAuthService = createPlatformEntraAuthService({
    repository: persistence.oidcTransactionRepository,
    entraClient,
    identityService,
    sessionService,
    auditService: platformAuditService,
    transactionSecret: config.oidcTransactionSecret,
    publicOrigin: config.publicOrigin,
    securityEpoch: config.securityEpoch,
    mfaAuthenticationContext: config.mfaAuthenticationContext,
    stepUpAuthenticationContext: config.stepUpAuthenticationContext,
    transactionTtlSeconds: config.oidcTransactionTtlSeconds,
  });
  const common = Object.freeze({
    platformAuthorizationPolicy: authorizationPolicy,
    tenantTargetPolicy,
    operationEvidenceFactory,
  });
  const tenantOperations = persistence.tenantOperationsRepository;
  const platformTenantOperationsService = createPlatformTenantOperationsService({
    ...tenantOperations,
    operationReceiptReader: persistence.operationReceiptRepository,
    lifecyclePolicy: createTenantLifecyclePolicy(),
    ...common,
    idFactory: randomUUID,
    invitationSecretFactory: createTenantInvitationSecretFactory(),
  });
  const platformEntitlementOperationsService = createPlatformEntitlementOperationsService({
    capabilityPolicy: createCapabilityPolicy(),
    ...persistence.entitlementOperationsRepository,
    operationReceiptReader: persistence.operationReceiptRepository,
    ...common,
  });
  const recovery = persistence.recoveryRepository;
  const platformRecoveryOperationsService = createPlatformRecoveryOperationsService({
    ...recovery,
    operationReceiptReader: persistence.operationReceiptRepository,
    lifecyclePolicy: createTenantLifecyclePolicy(),
    ...common,
  });
  const platformFleetReadinessService = createPlatformFleetReadinessService({
    readinessSnapshotReader: persistence.readinessSnapshotRepository,
    readinessPolicy: createTenantReadinessPolicy(),
    platformAuthorizationPolicy: authorizationPolicy,
    tenantTargetPolicy,
  });
  const platformMicrosoftFleetHealthService = createPlatformMicrosoftFleetHealthService({
    healthSnapshotReader: persistence.microsoftHealthSnapshotRepository,
    healthPresentationPolicy: Object.freeze({
      async contract() { return HEALTH_PRESENTATION_CONTRACT; },
    }),
    platformAuthorizationPolicy: authorizationPolicy,
    tenantTargetPolicy,
  });
  const platformDiagnosticOperationsService = createPlatformDiagnosticOperationsService({
    diagnosticReader: persistence.diagnosticRepository,
    ...common,
  });
  const usageAuthority = createPlatformUsageEventSourceAuthority();
  const platformMeteringService = createPlatformMeteringService({
    repository: persistence.meteringRepository,
    usageSource: persistence.usageSource,
    authorizationPolicy,
    tenantTargetPolicy,
    auditService: platformAuditService,
    usageEventSourcePolicy: usageAuthority.policy,
  });
  const platformRuntimeStatusService = createPlatformRuntimeStatusService({
    repository: persistence.runtimeStatusRepository,
    authorizationPolicy,
    tenantTargetPolicy,
    auditService: platformAuditService,
  });
  const platformHealthMonitor = createHealthMonitor({
    readinessChecks: persistence.readinessChecks,
    timeoutMs: config.readinessTimeoutMs,
  });
  const projectionWorker = createPlatformProjectionWorker({
    repository: persistence.projectionRepository,
  });
  const platformProcess = createPlatformProcess({
    config,
    platformAuthService,
    platformAuditService,
    platformDiagnosticOperationsService,
    platformEntitlementOperationsService,
    platformFleetReadinessService,
    platformHealthMonitor,
    platformMeteringService,
    platformMicrosoftFleetHealthService,
    platformRecoveryOperationsService,
    platformRuntimeStatusService,
    platformSessionService: sessionService,
    platformTenantOperationsService,
  });
  return Object.freeze({
    config,
    persistence,
    process: platformProcess,
    usageRecorder: usageAuthority.bindRecorder(platformMeteringService),
    fallback: Object.freeze({
      sessionService,
      breakGlassService: platformBreakGlassService,
      recoveryService: platformRecoveryOperationsService,
    }),
    async start() {
      await projectionWorker.runOnce();
      projectionWorker.start();
      return platformProcess.start();
    },
    async stop() {
      await projectionWorker.stop();
      await platformProcess.stop();
      await persistence.close();
    },
  });
}
