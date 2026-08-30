import { createFinalRoomConfirmationService } from './application/final-room-confirmation-service.js';
import { createBookingChangeService } from './application/booking-change-service.js';
import { createMicrosoft365BookingServiceFactory } from './application/microsoft365-booking-service-factory.js';
import {
  createMicrosoft365CapabilityHealthService,
} from './application/microsoft365-capability-health-service.js';
import { createMicrosoft365ConnectionHealthView } from './application/microsoft365-connection-health-view.js';
import { createMicrosoft365ConnectionService } from './application/microsoft365-connection-service.js';
import {
  createMicrosoft365OnboardingVerificationService,
} from './application/microsoft365-onboarding-verification-service.js';
import { createMicrosoft365RoomDiscoveryService } from './application/microsoft365-room-discovery-service.js';
import { createMicrosoft365RoomMappingService } from './application/microsoft365-room-mapping-service.js';
import { createProductionApplicationService } from './application/production-application-service.js';
import { createRequestService } from './application/request-service.js';
import { createRoomAvailabilityService } from './application/room-availability-service.js';
import { createTenantBookingPolicyService } from './application/tenant-booking-policy-service.js';
import { createTenantCapabilityViewService } from './application/tenant-capability-view-service.js';
import { createTenantCatalogueService } from './application/tenant-catalogue-service.js';
import { createTenantCostAllocationService } from './application/tenant-cost-allocation-service.js';
import { createTenantLocationAdministrationService } from './application/tenant-location-administration-service.js';
import { createCodeShippedManagedBrandPolicy } from './application/managed-brand-preset-policy.js';
import { createTenantOrganizationService } from './application/tenant-organization-service.js';
import { createTenantPresentationService } from './application/tenant-presentation-service.js';
import { createTenantPilotService } from './application/tenant-pilot-service.js';
import { createTenantUserAdministrationService } from './application/tenant-user-administration-service.js';
import { createTenantUserLifecycleService } from './application/tenant-user-lifecycle-service.js';
import { createAuditService } from './audit/audit-service.js';
import { createTenantAuditQueryService } from './audit/tenant-audit-query-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { createEntitlementService } from './entitlements/entitlement-service.js';
import { createEntraAuthService } from './identity/entra-auth-service.js';
import { createJitUserService } from './identity/jit-user-service.js';
import { createPendingProviderIdentityResolver } from './identity/provider-identity-resolver.js';
import { createSessionService } from './identity/session-service.js';
import { createMicrosoft365CalendarProviderFactory } from './integrations/microsoft365-calendar-provider.js';
import { createLogger } from './logger.js';
import { createMetricsRegistry } from './observability/metrics.js';
import { createTenantOnboardingService } from './onboarding/tenant-onboarding-service.js';
import { createPostgresPersistence } from './persistence/postgres/index.js';
import { createHttpServer } from './server.js';

export function createCustomerComposition({
  config,
  persistence = config?.databaseUrl ? createPostgresPersistence(config) : null,
  entraClient = null,
  microsoft365Client = null,
  logger = createLogger(),
  metrics = createMetricsRegistry(),
  httpServerFactory = createHttpServer,
  additionalRouteModules = [],
  routeModulesFactory,
} = {}) {
if (!config) throw new TypeError('CUSTOMER_CONFIG_REQUIRED');
if (typeof httpServerFactory !== 'function') throw new TypeError('CUSTOMER_HTTP_SERVER_FACTORY_REQUIRED');
if (!Array.isArray(additionalRouteModules)) throw new TypeError('CUSTOMER_ROUTE_MODULES_INVALID');
if (routeModulesFactory !== undefined && typeof routeModulesFactory !== 'function') {
  throw new TypeError('CUSTOMER_ROUTE_MODULES_FACTORY_INVALID');
}
const authorizationPolicy = createAuthorizationPolicy();
const auditService = persistence
  ? createAuditService({
    repository: persistence.auditRepository,
    authorizationPolicy,
  })
  : null;
const entitlementService = persistence && auditService
  ? createEntitlementService({
    repository: persistence.entitlementRepository,
    auditService,
  })
  : null;
const capabilityHealthService = persistence
  ? createMicrosoft365CapabilityHealthService({
    repository: persistence.microsoft365CapabilityHealthRepository,
  })
  : null;
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
const microsoft365CalendarProviderFactory = persistence && microsoft365Client
  ? createMicrosoft365CalendarProviderFactory({
    connectionRepository: persistence.microsoft365ConnectionRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    mappingRepository: persistence.microsoft365RoomMappingRepository,
    providerClient: microsoft365Client,
    capabilityHealthService,
    observationRepository: persistence.microsoft365RoomObservationRepository,
  })
  : null;
const microsoft365BookingServiceFactory = persistence
  && auditService
  && entitlementService
  && microsoft365CalendarProviderFactory
  ? createMicrosoft365BookingServiceFactory({
    repository: persistence.bookingReferenceRepository,
    calendarProviderFactory: microsoft365CalendarProviderFactory,
    entitlementService,
    auditService,
    authorizationPolicy,
    metrics,
  })
  : null;
const roomAvailabilityService = persistence
  && entitlementService
  && microsoft365CalendarProviderFactory
  ? createRoomAvailabilityService({
    repository: persistence.bookingReferenceRepository,
    authorizationPolicy,
    entitlementService,
    calendarProviderFactory: microsoft365CalendarProviderFactory,
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
const finalRoomConfirmationService = persistence
  && auditService
  && entitlementService
  && microsoft365CalendarProviderFactory
  ? createFinalRoomConfirmationService({
    repository: persistence.requestRepository,
    authorizationPolicy,
    auditService,
    entitlementService,
    calendarProviderFactory: microsoft365CalendarProviderFactory,
    bookingServiceFactory: microsoft365BookingServiceFactory,
  })
  : null;
const requestService = persistence
  ? createRequestService({
    repository: persistence.requestRepository,
    authorizationPolicy,
    auditService,
    finalRoomConfirmationService,
    bookingServiceFactory: microsoft365BookingServiceFactory,
    metrics,
    maxResponseBytes: config.maxResponseBytes,
    cursorSecret: config.auditHmacSecret,
  })
  : null;
const bookingChangeService = persistence && auditService && microsoft365BookingServiceFactory
  ? createBookingChangeService({
    repository: persistence.bookingChangeRepository,
    requestRepository: persistence.requestRepository,
    authorizationPolicy,
    auditService,
    bookingServiceFactory: microsoft365BookingServiceFactory,
  })
  : null;
const tenantLocationAdministrationService = persistence && auditService
  ? createTenantLocationAdministrationService({
    repository: persistence.tenantLocationRepository,
    bulkTransferRepository: persistence.tenantBulkTransferRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const managedBrandPolicy = createCodeShippedManagedBrandPolicy();
const tenantOrganizationService = persistence && auditService
  ? createTenantOrganizationService({
    repository: persistence.tenantOrganizationRepository,
    authorizationPolicy,
    auditService,
    managedAssetPolicy: managedBrandPolicy,
  })
  : null;
const tenantPresentationService = persistence && auditService
  ? createTenantPresentationService({
    repository: persistence.tenantOrganizationRepository,
    authorizationPolicy,
    auditService,
    managedBrandPolicy,
  })
  : null;
const tenantCatalogueService = persistence && auditService
  ? createTenantCatalogueService({
    repository: persistence.tenantCatalogueRepository,
    bulkTransferRepository: persistence.tenantBulkTransferRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const tenantBookingPolicyService = persistence && auditService
  ? createTenantBookingPolicyService({
    repository: persistence.tenantBookingPolicyRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const tenantCostAllocationService = persistence && auditService
  ? createTenantCostAllocationService({
    repository: persistence.tenantCostAllocationRepository,
    bulkTransferRepository: persistence.tenantBulkTransferRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const productionApplicationService = persistence && auditService
  ? createProductionApplicationService({
    repository: persistence.applicationRepository,
    requestRepository: persistence.requestRepository,
    authorizationPolicy,
    auditService,
    roomAvailabilityService,
    maxResponseBytes: config.maxResponseBytes,
    cursorSecret: config.auditHmacSecret,
  })
  : null;
const tenantUserAdministrationService = persistence && auditService
  ? createTenantUserAdministrationService({
    repository: persistence.tenantUserAdminRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const tenantUserLifecycleService = persistence && auditService
  ? createTenantUserLifecycleService({
    repository: persistence.tenantUserLifecycleRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const tenantAuditQueryService = persistence && auditService
  ? createTenantAuditQueryService({
    queryRepository: persistence.tenantAuditQueryRepository,
    integrityRepository: persistence.auditRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const tenantPilotService = persistence && auditService
  ? createTenantPilotService({
    tenantRepository: persistence.tenantRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    connectionRepository: persistence.microsoft365ConnectionRepository,
    roomMappingRepository: persistence.microsoft365RoomMappingRepository,
    capabilityHealthRepository: persistence.microsoft365CapabilityHealthRepository,
    entitlementRepository: persistence.entitlementRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const microsoft365ConnectionLifecycleService = persistence && auditService && microsoft365Client
  ? createMicrosoft365ConnectionService({
    repository: persistence.microsoft365ConnectionRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    authorizationPolicy,
    auditService,
    providerClient: microsoft365Client,
    consentTtlSeconds: config.microsoft365ConsentTtlSeconds,
  })
  : null;
const microsoft365ConnectionService = microsoft365ConnectionLifecycleService && capabilityHealthService
  ? createMicrosoft365ConnectionHealthView({
    connectionService: microsoft365ConnectionLifecycleService,
    connectionRepository: persistence.microsoft365ConnectionRepository,
    capabilityHealthService,
  })
  : microsoft365ConnectionLifecycleService;
const tenantCapabilityViewService = tenantPilotService && microsoft365ConnectionService
  ? createTenantCapabilityViewService({
    authorizationPolicy,
    auditService,
    readinessService: tenantPilotService,
    microsoft365Service: microsoft365ConnectionService,
  })
  : null;
const microsoft365RoomDiscoveryService = persistence && auditService && microsoft365Client
  ? createMicrosoft365RoomDiscoveryService({
    connectionRepository: persistence.microsoft365ConnectionRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    authorizationPolicy,
    auditService,
    providerClient: microsoft365Client,
    capabilityHealthService,
  })
  : null;
const microsoft365RoomMappingService = persistence && auditService && microsoft365RoomDiscoveryService
  ? createMicrosoft365RoomMappingService({
    mappingRepository: persistence.microsoft365RoomMappingRepository,
    connectionRepository: persistence.microsoft365ConnectionRepository,
    discoveryService: microsoft365RoomDiscoveryService,
    authorizationPolicy,
    auditService,
  })
  : null;
const microsoft365OnboardingVerificationService = microsoft365RoomMappingService
  && microsoft365CalendarProviderFactory
  ? createMicrosoft365OnboardingVerificationService({
    roomMappingService: microsoft365RoomMappingService,
    calendarProviderFactory: microsoft365CalendarProviderFactory,
  })
  : null;
const microsoft365Service = microsoft365ConnectionService
  ? Object.freeze({
    ...microsoft365ConnectionService,
    ...(microsoft365RoomDiscoveryService
      ? { discoverRooms: (args) => microsoft365RoomDiscoveryService.discoverRooms(args) }
      : {}),
    ...(microsoft365RoomMappingService
      ? {
        listRoomMappings: (args) => microsoft365RoomMappingService.listMappings(args),
        importSelectedRooms: (args) => microsoft365RoomMappingService.importSelectedRooms(args),
        synchronizeRoomMappings: (args) => microsoft365RoomMappingService.synchronize(args),
      }
      : {}),
    ...(microsoft365OnboardingVerificationService
      ? { verifyFreeBusy: (args) => microsoft365OnboardingVerificationService.verifyFreeBusy(args) }
      : {}),
    ...(tenantPilotService
      ? { getPilotReadiness: (args) => tenantPilotService.getReadiness(args) }
      : {}),
  })
  : null;
const selectedAdditionalRouteModules = routeModulesFactory
  ? routeModulesFactory({ persistence, sessionService })
  : additionalRouteModules;
if (!Array.isArray(selectedAdditionalRouteModules)) {
  throw new TypeError('CUSTOMER_ROUTE_MODULES_INVALID');
}
const server = httpServerFactory({
  config,
  persistence,
  logger,
  metrics,
  authorizationPolicy,
  auditService,
  sessionService,
  entraAuthService,
  onboardingService,
  requestService,
  bookingChangeService,
  productionApplicationService,
  tenantAuditQueryService,
  tenantBookingPolicyService,
  tenantCapabilityViewService,
  tenantCatalogueService,
  tenantCostAllocationService,
  tenantLocationAdministrationService,
  tenantOrganizationService,
  tenantPresentationService,
  tenantUserAdministrationService,
  tenantUserLifecycleService,
  microsoft365ConnectionService: microsoft365Service,
  additionalRouteModules: selectedAdditionalRouteModules,
  loadTenant: persistence?.loadTenant,
  readinessChecks: persistence?.readinessChecks || [],
});
let started = false;
let closed = false;
return Object.freeze({
  config,
  persistence,
  server,
  sessionService,
  async start() {
    if (closed) throw new TypeError('CUSTOMER_PROCESS_CLOSED');
    if (started) throw new TypeError('CUSTOMER_PROCESS_ALREADY_STARTED');
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
    started = true;
    logger.lifecycle({
      event: 'server_started',
      serviceVersion: config.serviceVersion,
      buildId: config.buildId,
      environment: config.mode,
    });
    return server.address();
  },
  async stop() {
    if (closed) return;
    closed = true;
    if (started) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await persistence?.close?.();
    started = false;
  },
});
}
