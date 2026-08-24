import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresAuditRepository } from './audit-repository.js';
import { createPostgresBookingReferenceRepository } from './booking-reference-repository.js';
import { createPostgresEntitlementRepository } from './entitlement-repository.js';
import { createPostgresJitUserRepository } from './jit-user-repository.js';
import { createPostgresOidcTransactionRepository } from './oidc-transaction-repository.js';
import { createPostgresRequestRepository } from './request-repository.js';
import { createPostgresSessionRepository } from './session-repository.js';
import { createPostgresTenantOnboardingRepository } from './tenant-onboarding-repository.js';
import { createPostgresTenantRepository } from './tenant-repository.js';
import { createPostgresTenantUserAdminRepository } from './tenant-user-admin-repository.js';

export function createPostgresPersistence(config) {
  const pool = createPostgresPool(config);
  const auditRepository = createPostgresAuditRepository(pool, {
    hmacSecret: config.auditHmacSecret,
  });
  const tenantRepository = createPostgresTenantRepository(pool);
  const bookingReferenceRepository = createPostgresBookingReferenceRepository(pool, { auditRepository });
  const entitlementRepository = createPostgresEntitlementRepository(pool, { auditRepository });
  const jitUserRepository = createPostgresJitUserRepository(pool, { auditRepository });
  const oidcTransactionRepository = createPostgresOidcTransactionRepository(pool);
  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  const requestRepository = createPostgresRequestRepository(pool, { auditRepository });
  const tenantOnboardingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  const tenantUserAdminRepository = createPostgresTenantUserAdminRepository(pool, { auditRepository });

  return Object.freeze({
    pool,
    auditRepository,
    bookingReferenceRepository,
    entitlementRepository,
    jitUserRepository,
    oidcTransactionRepository,
    sessionRepository,
    requestRepository,
    tenantOnboardingRepository,
    tenantUserAdminRepository,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresReady(pool),
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
