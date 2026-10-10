import { createPostgresDemoPersonaRepository } from '../persistence/postgres/demo-persona-repository.js';
import { createPostgresDemoResetRepository } from '../persistence/postgres/demo-reset-repository.js';
import { createPostgresDemoRuntimeReadiness } from '../persistence/postgres/demo-runtime-readiness.js';
import { withDemoRuntimeSharedGate } from '../persistence/postgres/demo-runtime-gate.js';
import { createPostgresPlatformPersistence } from '../persistence/postgres/platform-index.js';
import { createPostgresPool } from '../persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../persistence/postgres/media-object-repository.js';
import { createPlatformComposition } from '../platform-composition.js';
import { PLATFORM_OPERATIONAL_ROUTE_MODULES } from '../platform/app.js';
import { createDemoPlatformControlRoutes } from './http/platform-control-routes.js';
import { createDemoPlatformPersonaService } from './identity/platform-persona-service.js';
import { createDemoResetService } from './reset-service.js';
import { createDemoPlatformRuntimeConfig } from './runtime-config.js';
import { createDemoPlatformHttpServer } from './platform-server.js';

function auxiliaryConfig(
  runtimeConfig,
  databaseUrl,
  applicationName,
  databasePoolMax,
  databaseStatementTimeoutMs = runtimeConfig.databaseStatementTimeoutMs,
) {
  return Object.freeze({
    ...runtimeConfig,
    databaseUrl,
    applicationName,
    databasePoolMax,
    databaseStatementTimeoutMs,
  });
}

export function createDemoPlatformComposition({
  config,
  persistence,
  gatePool,
  resetPool,
  readiness,
  resetMediaObjectStorage = null,
  staticFileAdapter = null,
  trafficGate = null,
  metrics,
} = {}) {
  if (!config) throw new TypeError('DEMO_CONFIG_REQUIRED');
  if (config.staticRoot && !staticFileAdapter) {
    throw new TypeError('DEMO_STATIC_FILE_ADAPTER_REQUIRED');
  }
  const runtimeConfig = createDemoPlatformRuntimeConfig(config);
  const selectedPersistence = persistence || createPostgresPlatformPersistence(runtimeConfig);
  const selectedReadiness = readiness || createPostgresDemoRuntimeReadiness({
    pool: selectedPersistence.pool,
    surface: 'platform',
    expectedDatabaseName: config.databaseTarget.database,
    expectedRole: config.databases.platform.role,
    expectedSentinelKey: config.databaseSentinelKey,
  });
  const runtimePersistence = Object.freeze({
    ...selectedPersistence,
    readinessChecks: Object.freeze([
      ...(selectedPersistence.readinessChecks || []),
      () => selectedReadiness.isReady(),
    ]),
  });
  const selectedGatePool = gatePool || createPostgresPool(auxiliaryConfig(
    runtimeConfig,
    runtimeConfig.databaseUrl,
    'conference-manager-demo-platform-gate',
    runtimeConfig.databasePoolMax,
  ));
  const selectedResetPool = resetPool || createPostgresPool(auxiliaryConfig(
    runtimeConfig,
    config.databases.reset.url,
    'conference-manager-demo-reset',
    1,
    runtimeConfig.resetDatabaseStatementTimeoutMs,
  ));
  if (
    selectedGatePool === selectedPersistence.pool
    || selectedResetPool === selectedPersistence.pool
    || selectedResetPool === selectedGatePool
  ) throw new TypeError('DEMO_PLATFORM_POOLS_MUST_BE_DISTINCT');

  const personaRepository = createPostgresDemoPersonaRepository({ pool: selectedPersistence.pool });
  const resetRepository = createPostgresDemoResetRepository({
    pool: selectedResetPool,
    expectedDatabaseName: config.databaseTarget.database,
    expectedResetRole: config.databases.reset.role,
    auditRepository: selectedPersistence.auditRepository,
    mediaObjects: resetMediaObjectStorage ? createPostgresMediaObjectRepository(selectedResetPool, {
      storage: resetMediaObjectStorage, includeDemoCatalogue: true,
    }) : null,
  });
  const resetService = createDemoResetService({ repository: resetRepository });
  const composition = createPlatformComposition({
    config: runtimeConfig,
    persistence: runtimePersistence,
    ...(metrics ? { metrics } : {}),
    httpServerFactory: (options) => createDemoPlatformHttpServer({
      ...options,
      demoRuntimeGatePool: selectedGatePool,
      staticFileAdapter,
      trafficGate,
    }),
    projectionRunGate: (work) => withDemoRuntimeSharedGate(selectedGatePool, work),
    routeModulesFactory({ platformSessionService }) {
      const personaService = createDemoPlatformPersonaService({
        sessionService: platformSessionService,
        personaRepository,
      });
      return [
        ...PLATFORM_OPERATIONAL_ROUTE_MODULES,
        createDemoPlatformControlRoutes({
          personaService,
          resetService,
        }),
      ];
    },
  });
  let stopped = false;
  return Object.freeze({
    config,
    runtimeConfig,
    process: composition,
    resetDescriptor: resetService.descriptor,
    async start() {
      if (stopped) throw new TypeError('DEMO_PLATFORM_PROCESS_STOPPED');
      await selectedReadiness.assertReady();
      return composition.start();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await composition.stop();
      } finally {
        const results = await Promise.allSettled([selectedGatePool.end(), selectedResetPool.end()]);
        if (results.some(({ status }) => status === 'rejected')) {
          throw new Error('DEMO_PLATFORM_POOL_SHUTDOWN_FAILED');
        }
      }
    },
  });
}
