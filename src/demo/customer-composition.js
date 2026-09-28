import { createCustomerComposition } from '../customer-composition.js';
import { createLogger } from '../logger.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { createPostgresPersistence } from '../persistence/postgres/index.js';
import { createPostgresDemoPersonaRepository } from '../persistence/postgres/demo-persona-repository.js';
import { createPostgresDemoRuntimeReadiness } from '../persistence/postgres/demo-runtime-readiness.js';
import { createPostgresPool } from '../persistence/postgres/pool.js';
import { DEMO_FIXTURE } from './fixture.js';
import { createDemoCustomerControlRoutes } from './http/customer-control-routes.js';
import { createDemoCustomerPersonaService } from './identity/customer-persona-service.js';
import { createDemoMicrosoft365Client } from './provider/microsoft365-client.js';
import { createDemoCustomerRuntimeConfig } from './runtime-config.js';
import { createDemoCustomerHttpServer } from './customer-server.js';

function providerScenarios() {
  return Object.freeze(Object.fromEntries(DEMO_FIXTURE.tenants.map((tenant) => [
    tenant.id,
    tenant.providerSimulation.scenario === 'onboarding' ? 'booking_success' : tenant.providerSimulation.scenario,
  ])));
}

export function demoProviderRooms() {
  return Object.freeze(Object.fromEntries(DEMO_FIXTURE.tenants.map((tenant) => {
    const rooms = tenant.providerSimulation.roomMappings.map((mapping) => {
      const location = tenant.settings.locations.find(({ rooms: siteRooms }) => (
        siteRooms.some(({ id }) => id === mapping.roomId)
      ));
      const room = location?.rooms.find(({ id }) => id === mapping.roomId);
      if (!location || !room) throw new TypeError('DEMO_PROVIDER_ROOM_FIXTURE_INVALID');
      return Object.freeze({
        id: mapping.externalRoomId,
        displayName: room.name,
        resourceAddress: mapping.resourceAddress,
        capacity: room.capacity,
        building: location.name,
      });
    });
    return [tenant.providerSimulation.providerTenantReference, Object.freeze(rooms)];
  })));
}

function gateConfig(runtimeConfig) {
  return Object.freeze({
    ...runtimeConfig,
    applicationName: 'conference-manager-demo-customer-gate',
    databasePoolMax: runtimeConfig.databasePoolMax,
  });
}

export function createDemoCustomerComposition({
  config,
  persistence,
  gatePool,
  readiness,
  staticFileAdapter = null,
  logger = createLogger(),
  metrics = createMetricsRegistry(),
} = {}) {
  if (!config) throw new TypeError('DEMO_CONFIG_REQUIRED');
  if (config.staticRoot && !staticFileAdapter) {
    throw new TypeError('DEMO_STATIC_FILE_ADAPTER_REQUIRED');
  }
  const runtimeConfig = createDemoCustomerRuntimeConfig(config);
  const selectedPersistence = persistence || createPostgresPersistence(runtimeConfig);
  const selectedReadiness = readiness || createPostgresDemoRuntimeReadiness({
    pool: selectedPersistence.pool,
    surface: 'customer',
    expectedDatabaseName: config.databaseTarget.database,
    expectedRole: config.databases.customer.role,
    expectedSentinelKey: config.databaseSentinelKey,
  });
  const runtimePersistence = Object.freeze({
    ...selectedPersistence,
    readinessChecks: Object.freeze([
      ...(selectedPersistence.readinessChecks || []),
      () => selectedReadiness.isReady(),
    ]),
  });
  const selectedGatePool = gatePool || createPostgresPool(gateConfig(runtimeConfig));
  if (selectedGatePool === selectedPersistence.pool) {
    throw new TypeError('DEMO_CUSTOMER_GATE_POOL_MUST_BE_DISTINCT');
  }
  const personaRepository = createPostgresDemoPersonaRepository({ pool: selectedPersistence.pool });
  const microsoft365Client = createDemoMicrosoft365Client({
    publicOrigin: runtimeConfig.publicOrigin,
    roomsByTenantReference: demoProviderRooms(),
    scenarioByTenantReference: providerScenarios(),
  });
  const composition = createCustomerComposition({
    config: runtimeConfig,
    persistence: runtimePersistence,
    microsoft365Client,
    logger,
    metrics,
    httpServerFactory: (options) => createDemoCustomerHttpServer({
      ...options,
      demoRuntimeGatePool: selectedGatePool,
      staticFileAdapter,
    }),
    routeModulesFactory({ sessionService }) {
      const personaService = createDemoCustomerPersonaService({
        sessionService,
        personaRepository,
      });
      return [createDemoCustomerControlRoutes({ personaService, mediaPool: selectedPersistence.pool })];
    },
  });
  let stopped = false;
  return Object.freeze({
    config,
    runtimeConfig,
    process: composition,
    async start() {
      if (stopped) throw new TypeError('DEMO_CUSTOMER_PROCESS_STOPPED');
      await selectedReadiness.assertReady();
      return composition.start();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await composition.stop();
      } finally {
        await selectedGatePool.end();
      }
    },
  });
}
