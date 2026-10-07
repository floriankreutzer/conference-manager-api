import { createPostgresPlatformAuditRepository } from './platform-audit-repository.js';
import { createPostgresPlatformBreakGlassRepository } from './platform-break-glass-repository.js';
import { createPostgresPlatformOperatorRepository } from './platform-operator-repository.js';
import { createPostgresPlatformOidcTransactionRepository } from './platform-oidc-transaction-repository.js';
import { createPostgresPlatformSessionRepository } from './platform-session-repository.js';
import { createPostgresAuditRepository } from './audit-repository.js';
import { createPostgresEntitlementRepository } from './entitlement-repository.js';
import { createPostgresTenantOnboardingRepository } from './tenant-onboarding-repository.js';
import { createPostgresTenantRepository } from './tenant-repository.js';
import {
  createPostgresPlatformEntitlementOperationsRepository,
  createPostgresPlatformOperationReceiptRepository,
  createPostgresPlatformTenantOperationsRepository,
} from './platform-operations-repository.js';
import {
  createPostgresPlatformDiagnosticRepository,
  createPostgresPlatformMicrosoftHealthSnapshotRepository,
  createPostgresPlatformReadinessSnapshotRepository,
} from './platform-operations-read-model-repository.js';
import { createPostgresPlatformRecoveryRepository } from './platform-operations-recovery-repository.js';
import {
  createPostgresPlatformMeteringRepository,
  createPostgresPlatformUsageSource,
} from './platform-metering-repository.js';
import { createPostgresPlatformRuntimeStatusRepository } from './platform-runtime-status-repository.js';
import { createPostgresPlatformProjectionRepository } from './platform-projection-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from './pool.js';

export function createPostgresPlatformPersistence(config) {
  const pool = createPostgresPool({
    ...config,
    applicationName: config.applicationName,
  });
  const auditRepository = createPostgresPlatformAuditRepository(pool, {
    hmacSecret: config.auditHmacSecret,
  });
  const operatorRepository = createPostgresPlatformOperatorRepository(pool, { auditRepository });
  const oidcTransactionRepository = createPostgresPlatformOidcTransactionRepository(pool);
  const sessionRepository = createPostgresPlatformSessionRepository(pool, { auditRepository });
  const breakGlassRepository = createPostgresPlatformBreakGlassRepository(pool, { auditRepository });
  const tenantAuditRepository = createPostgresAuditRepository(pool, {
    hmacSecret: config.tenantAuditHmacSecret,
  });
  const tenantRepository = createPostgresTenantRepository(pool, { auditRepository: tenantAuditRepository });
  const tenantOnboardingRepository = createPostgresTenantOnboardingRepository(pool, {
    auditRepository: tenantAuditRepository,
  });
  const entitlementRepository = createPostgresEntitlementRepository(pool, {
    auditRepository: tenantAuditRepository,
  });
  const operationReceiptRepository = createPostgresPlatformOperationReceiptRepository(pool);
  const tenantOperationsRepository = createPostgresPlatformTenantOperationsRepository(pool, {
    tenantAuditRepository,
    platformAuditRepository: auditRepository,
    onboardingRepository: tenantOnboardingRepository,
    tenantLifecycleRepository: tenantRepository,
    cursorSecret: config.cursorSecret,
  });
  const entitlementOperationsRepository = createPostgresPlatformEntitlementOperationsRepository(pool, {
    tenantAuditRepository,
    platformAuditRepository: auditRepository,
    entitlementRepository,
    cursorSecret: config.cursorSecret,
  });
  const recoveryRepository = createPostgresPlatformRecoveryRepository(pool, {
    tenantAuditRepository,
    platformAuditRepository: auditRepository,
    onboardingRepository: tenantOnboardingRepository,
    tenantLifecycleRepository: tenantRepository,
    cursorSecret: config.cursorSecret,
  });
  const readinessSnapshotRepository = createPostgresPlatformReadinessSnapshotRepository(pool, {
    cursorSecret: config.cursorSecret,
  });
  const microsoftHealthSnapshotRepository = createPostgresPlatformMicrosoftHealthSnapshotRepository(pool, {
    cursorSecret: config.cursorSecret,
  });
  const diagnosticRepository = createPostgresPlatformDiagnosticRepository(pool, {
    platformAuditRepository: auditRepository,
  });
  const meteringRepository = createPostgresPlatformMeteringRepository(pool, {
    auditRepository,
  });
  const usageSource = createPostgresPlatformUsageSource(pool, {
    counterProducersReady: false,
  });
  const runtimeStatusRepository = createPostgresPlatformRuntimeStatusRepository(pool, {
    auditRepository,
  });
  const projectionRepository = createPostgresPlatformProjectionRepository(pool);

  return Object.freeze({
    pool,
    auditRepository,
    operatorRepository,
    oidcTransactionRepository,
    sessionRepository,
    breakGlassRepository,
    tenantAuditRepository,
    tenantRepository,
    tenantOnboardingRepository,
    entitlementRepository,
    operationReceiptRepository,
    tenantOperationsRepository,
    entitlementOperationsRepository,
    recoveryRepository,
    readinessSnapshotRepository,
    microsoftHealthSnapshotRepository,
    diagnosticRepository,
    meteringRepository,
    usageSource,
    runtimeStatusRepository,
    projectionRepository,
    readinessChecks: [
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
