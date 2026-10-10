import { createNeonObjectStorage } from '../media/neon-object-storage.js';
import { createPostgresPool } from '../persistence/postgres/pool.js';
import { assertDemoMediaStorageReady,
  DemoMediaStorageReadinessError } from '../persistence/postgres/demo-media-storage-readiness.js';
import { loadDemoMediaStorageConfig } from './media-storage-config.js';

async function assertStartupState(config, surface, mode, poolFactory) {
  const database = config.databases[surface === 'customer' ? 'customer' : 'reset'];
  let pool;
  let failure;
  try {
    pool = poolFactory({ mode: config.environment, demoRuntime: true,
      applicationName: surface === 'customer' ? 'conference-manager-demo-customer-gate' : 'conference-manager-demo-reset',
      databaseUrl: database.url, databaseSsl: config.databaseSsl, databasePoolMax: 1,
      databaseConnectionTimeoutMs: 5000, databaseIdleTimeoutMs: 5000, databaseStatementTimeoutMs: 5000 });
    await assertDemoMediaStorageReady(pool, { mode,
      expectedDatabaseName: config.databaseTarget.database, expectedRole: database.role });
  } catch (error) {
    failure = error instanceof DemoMediaStorageReadinessError
      ? error : new Error('DEMO_MEDIA_STORAGE_READINESS_FAILED');
  } finally {
    try { await pool?.end(); }
    catch { failure = new Error('DEMO_MEDIA_STORAGE_READINESS_FAILED'); }
  }
  if (failure) throw failure;
}

// Only normal Demo entrypoints own this factory. The caller injects the port into
// Customer media or the separate reset repository, never Platform persistence.
export async function startDemoMediaStorageRuntime({ env, config, surface, createComposition } = {}, {
  poolFactory = createPostgresPool,
  storageFactory = createNeonObjectStorage,
} = {}) {
  if (typeof createComposition !== 'function' || typeof poolFactory !== 'function'
    || typeof storageFactory !== 'function') throw new TypeError('DEMO_MEDIA_STORAGE_RUNTIME_CONFIG_INVALID');
  const settings = loadDemoMediaStorageConfig(env, { config, surface });
  await assertStartupState(config, surface, settings.mode, poolFactory);
  let storage;
  let composition;
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    let failed = false;
    try { await composition?.stop(); }
    catch { failed = true; }
    finally {
      try { await storage?.close(); }
      catch { failed = true; }
    }
    if (failed) throw new Error('DEMO_MEDIA_STORAGE_STOP_FAILED');
  }
  try {
    storage = settings.mode === 'neon' ? storageFactory(settings.storage) : null;
    composition = createComposition(storage);
    await composition.start();
  } catch {
    try { await stop(); } catch { /* Startup remains failed; no raw dependency errors escape. */ }
    throw new Error('DEMO_MEDIA_STORAGE_START_FAILED');
  }
  return Object.freeze({ stop });
}
