import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresApplicationRepository } from './application-repository.js';
import { createPostgresAuditRepository } from './audit-repository.js';
import { createPostgresBookingReferenceRepository } from './booking-reference-repository.js';
import { createPostgresBookingChangeRepository } from './booking-change-repository.js';
import { createPostgresBookingPolicyRepository } from './booking-policy-repository.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard } from './calendar-authority-guard.js';
import { createPostgresCatalogConfigurationRepository } from './catalog-configuration-repository.js';
import { createPostgresConfigurationRevisionStore } from './configuration-revision-store.js';
import { createPostgresCostAllocationRepository } from './cost-allocation-repository.js';
import { createPostgresEntitlementRepository } from './entitlement-repository.js';
import { createPostgresJitUserRepository } from './jit-user-repository.js';
import { createPostgresLocationConfigurationRepository } from './location-configuration-repository.js';
import {
  createPostgresMicrosoft365CapabilityHealthRepository,
} from './microsoft365-capability-health-repository.js';
import { createPostgresMicrosoft365ConnectionRepository } from './microsoft365-connection-repository.js';
import { createPostgresMicrosoft365RoomMappingRepository } from './microsoft365-room-mapping-repository.js';
import { createPostgresOidcTransactionRepository } from './oidc-transaction-repository.js';
import { createPostgresOrganizationConfigurationRepository } from './organization-configuration-repository.js';
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
  const tenantOnboardingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  const tenantUserAdminRepository = createPostgresTenantUserAdminRepository(pool, { auditRepository });
  const configurationRevisionStore = createPostgresConfigurationRevisionStore(pool, { auditRepository });
  const tenantConfigurationRepositories = Object.freeze({
    organization: createPostgresOrganizationConfigurationRepository(configurationRevisionStore),
    locations: createPostgresLocationConfigurationRepository(configurationRevisionStore),
    catalog: createPostgresCatalogConfigurationRepository(configurationRevisionStore),
    bookingPolicies: createPostgresBookingPolicyRepository(configurationRevisionStore),
    costAllocation: createPostgresCostAllocationRepository(configurationRevisionStore),
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
    tenantConfigurationRepositories,
    tenantOnboardingRepository,
    tenantRepository,
    tenantUserAdminRepository,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresReady(pool),
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
