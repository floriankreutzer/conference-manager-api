import { createMicrosoft365ConnectionService } from './application/microsoft365-connection-service.js';
import { createMicrosoft365RoomDiscoveryService } from './application/microsoft365-room-discovery-service.js';
import { createMicrosoft365RoomMappingService } from './application/microsoft365-room-mapping-service.js';
import { createRequestService } from './application/request-service.js';
import { createTenantUserAdministrationService } from './application/tenant-user-administration-service.js';
import { createAuditService } from './audit/audit-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { loadConfig } from './config.js';
import { createEntraAuthService } from './identity/entra-auth-service.js';
import { createEntraClient } from './identity/entra-client.js';
import { createJitUserService } from './identity/jit-user-service.js';
import { createPendingProviderIdentityResolver } from './identity/provider-identity-resolver.js';
import { createSessionService } from './identity/session-service.js';
import { createMicrosoft365Client } from './integrations/microsoft365-client.js';
import { createLogger } from './logger.js';
import { createMetricsRegistry } from './observability/metrics.js';
import { createTenantOnboardingService } from './onboarding/tenant-onboarding-service.js';
import { createPostgresPersistence } from './persistence/postgres/index.js';
import { createHttpServer } from './server.js';

const config = loadConfig();
const logger = createLogger();
const metrics = createMetricsRegistry({ write: (line) => process.stdout.write(line) });
const persistence = config.databaseUrl ? createPostgresPersistence(config) : null;
const authorizationPolicy = createAuthorizationPolicy();
const auditService = persistence
  ? createAuditService({
    repository: persistence.auditRepository,
    authorizationPolicy,
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
const entraClient = config.entraClientId
  ? createEntraClient({
    clientId: config.entraClientId,
    clientSecret: config.entraClientSecret,
    authority: config.entraAuthority,
    redirectUri: config.entraRedirectUri,
  })
  : null;
const microsoft365Client = config.entraClientId
  ? createMicrosoft365Client({
    clientId: config.entraClientId,
    clientSecret: config.entraClientSecret,
    publicOrigin: config.publicOrigin,
    timeoutMs: config.microsoft365GraphTimeoutMs,
    allowInsecureLocalhost: config.mode === 'development' || config.mode === 'test',
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
const requestService = persistence
  ? createRequestService({
    repository: persistence.requestRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const tenantUserAdministrationService = persistence && auditService
  ? createTenantUserAdministrationService({
    repository: persistence.tenantUserAdminRepository,
    authorizationPolicy,
    auditService,
  })
  : null;
const microsoft365ConnectionService = persistence && auditService && microsoft365Client
  ? createMicrosoft365ConnectionService({
    repository: persistence.microsoft365ConnectionRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    authorizationPolicy,
    auditService,
    providerClient: microsoft365Client,
    consentTtlSeconds: config.microsoft365ConsentTtlSeconds,
  })
  : null;
const microsoft365RoomDiscoveryService = persistence && auditService && microsoft365Client
  ? createMicrosoft365RoomDiscoveryService({
    connectionRepository: persistence.microsoft365ConnectionRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    authorizationPolicy,
    auditService,
    providerClient: microsoft365Client,
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
  })
  : null;
const server = createHttpServer({
  config,
  logger,
  metrics,
  authorizationPolicy,
  auditService,
  sessionService,
  entraAuthService,
  onboardingService,
  requestService,
  tenantUserAdministrationService,
  microsoft365ConnectionService: microsoft365Service,
  loadTenant: persistence?.loadTenant,
  readinessChecks: persistence?.readinessChecks || [],
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.lifecycle({ event: `shutdown_${signal.toLowerCase()}` });

  const forceTimer = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  forceTimer.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await persistence?.close();
    clearTimeout(forceTimer);
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

server.listen(config.port, config.host, () => {
  logger.lifecycle({
    event: 'server_started',
    serviceVersion: config.serviceVersion,
    buildId: config.buildId,
    environment: config.mode,
  });
});
