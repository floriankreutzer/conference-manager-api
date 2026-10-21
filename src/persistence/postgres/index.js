import { cateringConfigurationEnabled } from '../../feature-flags.js';
import {
  createPostgresPool,
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
import {
  createPostgresMicrosoft365RoomObservationRepository,
} from './microsoft365-room-observation-repository.js';
import { createPostgresOidcTransactionRepository } from './oidc-transaction-repository.js';
import { createPostgresRequestRepository } from './request-repository.js';
import { createPostgresRequestDraftWorkflowRepository } from './request-draft-workflow-repository.js';
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
import { createPostgresTenantBulkTransferRepository } from './tenant-bulk-transfer-repository.js';
import { createPostgresRoomMediaRepository } from './room-media-repository.js';
import { createPostgresMediaObjectRepository } from './media-object-repository.js';

export function createPostgresPersistence(config, { mediaObjectStorage = null, includeDemoCatalogue = false,
  cateringRegistry = null,calendarAuthorityGuardFactory=null } = {}) {
  if (calendarAuthorityGuardFactory!==null && typeof calendarAuthorityGuardFactory!=='function') {
    throw new TypeError('CALENDAR_AUTHORITY_FACTORY_INVALID');
  }
  const requirePublishedCatering=cateringConfigurationEnabled(config.featureFlags);
  if (requirePublishedCatering && typeof cateringRegistry?.get !== 'function') throw new TypeError('CATERING_REGISTRY_REQUIRED');
  const pool = createPostgresPool(config);
  const mediaObjectRepository = mediaObjectStorage
    ? createPostgresMediaObjectRepository(pool, { storage: mediaObjectStorage, includeDemoCatalogue })
    : null;
  const auditRepository = createPostgresAuditRepository(pool, {
    hmacSecret: config.auditHmacSecret,
  });
  const calendarAuthorityGuard = calendarAuthorityGuardFactory===null ? createPostgresMicrosoft365CalendarAuthorityGuard()
    : calendarAuthorityGuardFactory(pool);
  const applicationRepository = createPostgresApplicationRepository(pool, { auditRepository,requirePublishedCatering,cateringRegistry });
  const requestWorkflowRepository = createPostgresRequestDraftWorkflowRepository(pool, { auditRepository });
  const tenantRepository = createPostgresTenantRepository(pool, { auditRepository });
  const bookingReferenceRepository = createPostgresBookingReferenceRepository(pool, { auditRepository,
    calendarAuthorityGuard: typeof calendarAuthorityGuard?.lockBookingIntegration==='function' ? calendarAuthorityGuard : null });
  const bookingChangeRepository = createPostgresBookingChangeRepository(pool, {
    auditRepository,requirePublishedCatering,cateringRegistry,
    calendarAuthorityGuard: typeof calendarAuthorityGuard?.lockCustomerMutation==='function' ? calendarAuthorityGuard : null,
  });
  const entitlementRepository = createPostgresEntitlementRepository(pool, { auditRepository });
  const jitUserRepository = createPostgresJitUserRepository(pool, { auditRepository });
  const microsoft365CapabilityHealthRepository = createPostgresMicrosoft365CapabilityHealthRepository(pool);
  const microsoft365ConnectionRepository = createPostgresMicrosoft365ConnectionRepository(pool, { auditRepository });
  const microsoft365RoomMappingRepository = createPostgresMicrosoft365RoomMappingRepository(pool, { auditRepository });
  const microsoft365RoomObservationRepository = createPostgresMicrosoft365RoomObservationRepository(pool);
  const oidcTransactionRepository = createPostgresOidcTransactionRepository(pool);
  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  const requestRepository = createPostgresRequestRepository(pool, {
    auditRepository,
    calendarAuthorityGuard,
    requirePublishedCatering,cateringRegistry,
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
  const roomMediaRepository = createPostgresRoomMediaRepository(pool, { auditRepository, mediaObjects: mediaObjectRepository });
  const tenantOrganizationRepository = createPostgresTenantOrganizationRepository(pool, {
    auditRepository,
  });
  const tenantOnboardingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  const tenantUserAdminRepository = createPostgresTenantUserAdminRepository(pool, { auditRepository });
  const tenantUserLifecycleRepository = createPostgresTenantUserLifecycleRepository(pool, {
    auditRepository,
  });
  const tenantBulkTransferRepository = createPostgresTenantBulkTransferRepository(pool);

  return Object.freeze({
    pool,
    applicationRepository,
    requestWorkflowRepository,
    auditRepository,
    bookingReferenceRepository,
    bookingChangeRepository,
    entitlementRepository,
    jitUserRepository,
    microsoft365CapabilityHealthRepository,
    microsoft365ConnectionRepository,
    microsoft365RoomMappingRepository,
    microsoft365RoomObservationRepository,
    oidcTransactionRepository,
    sessionRepository,
    requestRepository,
    tenantAuditQueryRepository,
    tenantBookingPolicyRepository,
    tenantCatalogueRepository,
    tenantCostAllocationRepository,
    tenantLocationRepository,
    roomMediaRepository,
    mediaObjectRepository,
    tenantOrganizationRepository,
    tenantOnboardingRepository,
    tenantRepository,
    tenantUserAdminRepository,
    tenantUserLifecycleRepository,
    tenantBulkTransferRepository,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresSchemaReady(pool),
      ...(typeof calendarAuthorityGuard?.isReady==='function' ? [calendarAuthorityGuard.isReady] : []),
    ],
    close: () => pool.end(),
  });
}
