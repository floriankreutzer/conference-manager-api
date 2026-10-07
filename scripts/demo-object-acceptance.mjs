import { loadDemoConfig, loadDemoCustomerConfig, loadDemoPlatformConfig } from '../src/demo/config.js';
import { createDemoCustomerComposition } from '../src/demo/customer-composition.js';
import { createDemoPlatformComposition } from '../src/demo/platform-composition.js';
import { createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { loadDemoStaticFileAdapter } from '../src/demo/static-file-loader.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { assertPlatformRouteKey } from '../src/platform/http/observability.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createDemoResetService } from '../src/demo/reset-service.js';
import { createCiMediaStorageServer, createCiMediaObjectStorage } from './support/ci-media-storage.mjs';

const mode = process.argv[2];
if (process.env.NODE_ENV !== 'test' || process.argv.length !== 3
  || !['storage', 'seed', 'customer', 'platform'].includes(mode)) throw new Error('CI_OBJECT_ACCEPTANCE_TEST_MODE_REQUIRED');
const token = process.env.CI_MEDIA_STORAGE_TOKEN;
let composition;
let pool;
let storage;
if (mode === 'storage') {
  composition = createCiMediaStorageServer({ token });
  await composition.start();
} else {
  storage = createCiMediaObjectStorage({ token });
  if (mode === 'seed') {
    const config = loadDemoConfig(process.env);
    const runtime = createDemoPlatformRuntimeConfig(config);
    pool = createPostgresPool({ ...runtime, mode: 'test', databaseUrl: config.databases.reset.url,
      applicationName: 'conference-manager-demo-reset', databasePoolMax: 1,
      databaseStatementTimeoutMs: runtime.resetDatabaseStatementTimeoutMs });
    try {
      const mediaObjects = createPostgresMediaObjectRepository(pool, { storage, includeDemoCatalogue: true });
      const repository = createPostgresDemoResetRepository({ pool, mediaObjects,
        expectedDatabaseName: config.databaseTarget.database, expectedResetRole: config.databases.reset.role });
      const result = await createDemoResetService({ repository }).reset();
      process.stdout.write(`${JSON.stringify({ status: 'completed', result })}\n`);
    } finally { storage.close(); await pool.end(); }
  } else {
    const customer = mode === 'customer';
    const config = customer ? loadDemoCustomerConfig(process.env) : loadDemoPlatformConfig(process.env);
    const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
    const metrics = createMetricsRegistry({ ...(customer ? {} : { assertRouteKey: assertPlatformRouteKey }),
      write: (line) => process.stdout.write(line) });
    composition = customer
      ? createDemoCustomerComposition({ config, staticFileAdapter, metrics, mediaObjectStorage: storage })
      : createDemoPlatformComposition({ config, staticFileAdapter, metrics, resetMediaObjectStorage: storage });
    await composition.start();
  }
}
if (composition) {
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try { await (mode === 'storage' ? composition.close() : composition.stop()); }
    catch { process.exitCode = 1; }
    finally { storage?.close(); }
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
