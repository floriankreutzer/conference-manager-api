import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresApplicationRepository } from './application-repository.js';
import { createPostgresAuditRepository } from './audit-repository.js';
import { createPostgresBookingReferenceRepository } from './booking-reference-repository.js';
import { createPostgresBookingChangeRepository } from './booking-change-repository.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard } from './calendar-authority-guard.js';
import { createPostgresEntitlementRepository } from './entitlement-repository.js';
import { createPostgresJitUserRepository } from './jit-user-repository.js';
import {
  createPostgresMicrosoft365CapabilityHealthRepository,
} from './microsoft365-capability-health-repository.js';
import { createPostgresMicrosoft365ConnectionRepository } from './microsoft365-connection-repository.js';
import { createPostgresMicrosoft365RoomMappingRepository } from './microsoft365-room-mapping-repository.js';
import { createPostgresOidcTransactionRepository } from './oidc-transaction-repository.js';
import { createPostgresRequestRepository } from './request-repository.js';
import { createPostgresSessionRepository } from './session-repository.js';
import { createPostgresTenantLocationRepository } from './tenant-location-repository.js';
import { createPostgresTenantOrganizationRepository } from './tenant-organization-repository.js';
import { createPostgresTenantCatalogueRepository } from './tenant-catalogue-repository.js';
import { createPostgresTenantBookingPolicyRepository } from './tenant-booking-policy-repository.js';
import { createPostgresTenantCostAllocationRepository } from './tenant-cost-allocation-repository.js';
import { createPostgresTenantAuditQueryRepository } from './tenant-audit-query-repository.js';
import { createPostgresTenantOnboardingRepository } from './tenant-onboarding-repository.js';
import { createPostgresTenantRepository } from './tenant-repository.js';
import { createPostgresTenantUserAdminRepository } from './tenant-user-admin-repository.js';
import { createPostgresTenantUserLifecycleRepository } from './tenant-user-lifecycle-repository.js';

export function createPostgresPersistence(config) {
  const pool = createPostgresPool(config);
  const auditRepository = createPostgresAuditRepository(pool, {
    hmacSecret: config.auditHmacSecret,
  });
  const calendarAuthorityGuard = createPostgresMicrosoft365CalendarAuthorityGuard();
  const applicationRepository = createPostgresApplicationRepository(pool, { auditRepository });
  const tenantRepository = createPostgresTenantRepository(pool, { auditRepository });
  const bookingReferenceRepository = createPostgresBookingReferenceRepository(pool, { auditRepository });
  const bookingChangeRepository = createPostgresBookingChangeRepository(pool, { auditRepository });
  const entitlementRepository = createPostgresEntitlementRepository(pool, { auditRepository });
  const jitUserRepository = createPostgresJitUserRepository(pool, { auditRepository });
  const microsoft365CapabilityHealthRepository = createPostgresMicrosoft365CapabilityHealthRepository(pool);
  const microsoft365ConnectionRepository = createPostgresMicrosoft365ConnectionRepository(pool, { auditRepository });
  const microsoft365RoomMappingRepository = createPostgresMicrosoft365RoomMappingRepository(pool, { auditRepository });
  const oidcTransactionRepository = createPostgresOidcTransactionRepository(pool);
  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  const requestRepository = createPostgresRequestRepository(pool, {
    auditRepository,
    calendarAuthorityGuard,
  });
  const tenantAuditQueryRepository = createPostgresTenantAuditQueryRepository(pool);
  const tenantBookingPolicyRepository = createPostgresTenantBookingPolicyRepository(pool, {
    auditRepository,
  });
  const tenantCatalogueRepository = createPostgresTenantCatalogueRepository(pool, { auditRepository });
  const tenantCostAllocationRepository = createPostgresTenantCostAllocationRepository(pool, {
    auditRepository,
  });
  const tenantLocationRepository = createPostgresTenantLocationRepository(pool, { auditRepository });
  const tenantOrganizationRepository = createPostgresTenantOrganizationRepository(pool, {
    auditRepository,
  });
  const tenantOnboardingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  const tenantUserAdminRepository = createPostgresTenantUserAdminRepository(pool, { auditRepository });
  const tenantUserLifecycleRepository = createPostgresTenantUserLifecycleRepository(pool, {
    auditRepository,
  });

  return Object.freeze({
    pool,
    applicationRepository,
    auditRepository,
    bookingReferenceRepository,
    bookingChangeRepository,
    entitlementRepository,
    jitUserRepository,
    microsoft365CapabilityHealthRepository,
    microsoft365ConnectionRepository,
    microsoft365RoomMappingRepository,
    oidcTransactionRepository,
    sessionRepository,
    requestRepository,
    tenantAuditQueryRepository,
    tenantBookingPolicyRepository,
    tenantCatalogueRepository,
    tenantCostAllocationRepository,
    tenantLocationRepository,
    tenantOrganizationRepository,
    tenantOnboardingRepository,
    tenantRepository,
    tenantUserAdminRepository,
    tenantUserLifecycleRepository,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresReady(pool),
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
