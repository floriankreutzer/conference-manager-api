import { createCustomerComposition } from '../customer-composition.js';
import { createLogger } from '../logger.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { createPostgresPersistence } from '../persistence/postgres/index.js';
import { createPostgresDemoPersonaRepository } from '../persistence/postgres/demo-persona-repository.js';
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
    tenant.providerSimulation.scenario,
  ])));
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
  logger = createLogger(),
  metrics = createMetricsRegistry(),
} = {}) {
  if (!config) throw new TypeError('DEMO_CONFIG_REQUIRED');
  const runtimeConfig = createDemoCustomerRuntimeConfig(config);
  const selectedPersistence = persistence || createPostgresPersistence(runtimeConfig);
  const selectedGatePool = gatePool || createPostgresPool(gateConfig(runtimeConfig));
  if (selectedGatePool === selectedPersistence.pool) {
    throw new TypeError('DEMO_CUSTOMER_GATE_POOL_MUST_BE_DISTINCT');
  }
  const personaRepository = createPostgresDemoPersonaRepository({ pool: selectedPersistence.pool });
  const microsoft365Client = createDemoMicrosoft365Client({
    publicOrigin: runtimeConfig.publicOrigin,
    scenarioByTenantReference: providerScenarios(),
  });
  const composition = createCustomerComposition({
    config: runtimeConfig,
    persistence: selectedPersistence,
    microsoft365Client,
    logger,
    metrics,
    httpServerFactory: (options) => createDemoCustomerHttpServer({
      ...options,
      demoRuntimeGatePool: selectedGatePool,
    }),
    routeModulesFactory({ sessionService }) {
      const personaService = createDemoCustomerPersonaService({
        sessionService,
        personaRepository,
      });
      return [createDemoCustomerControlRoutes({ personaService })];
    },
  });
  let stopped = false;
  return Object.freeze({
    config,
    runtimeConfig,
    process: composition,
    async start() {
      if (stopped) throw new TypeError('DEMO_CUSTOMER_PROCESS_STOPPED');
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
