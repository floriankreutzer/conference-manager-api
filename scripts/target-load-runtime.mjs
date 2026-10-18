import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createPlatformComposition } from '../src/platform-composition.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { mediaObjectReference, MediaObjectStorageError } from '../src/media/object-storage-contract.js';
import { createNeonObjectStorage } from '../src/media/neon-object-storage.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer } from '../src/server.js';
import { assertPlatformRouteKey } from '../src/platform/http/observability.js';
import { createLoadPlatformAuthentication } from './support/target-load-identity.mjs';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { assertLoadDatabase, loadTargetScope } from './support/target-load-guard.mjs';
import { createTargetLoadCalendar } from './support/target-load-calendar.mjs';
import { createLoadRuntimeBoundary } from './support/target-load-boundary.mjs';
import { loadTargetRuntimeConfig } from './support/target-load-runtime-config.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_RUNTIME_FAILED'); }

async function fixtureBindings(pool) {
  const references = await pool.query('SELECT EXISTS(SELECT 1 FROM public.booking_provider_references) AS present');
  // An in-process external calendar cannot recover its events after a process
  // restart. Reject any prior booking state instead of falsely simulating it.
  valid(references.rows[0]?.present === false);
  const result = await pool.query(`SELECT tenant.id AS tenant_id,binding.provider_tenant_reference AS reference,
    mapping.resource_address AS address FROM public.tenants tenant
    JOIN public.tenant_identity_bindings binding ON binding.tenant_id=tenant.id
      AND binding.provider='microsoft_entra' AND binding.status='active'
    JOIN public.integrations integration ON integration.tenant_id=tenant.id
      AND integration.provider='microsoft365' AND integration.status='connected'
      AND integration.provider_reference=binding.provider_tenant_reference
    JOIN public.microsoft365_room_mappings mapping ON mapping.tenant_id=tenant.id
      AND mapping.integration_id=integration.id AND mapping.room_id='room'
    WHERE tenant.status='active' LIMIT 11`);
  valid(result.rowCount === 10 && new Set(result.rows.map(row => row.tenant_id)).size === 10);
  return result.rows;
}

function boundedStorage(storage, counts) {
  async function operation(name, input, bytes) {
    const reference = mediaObjectReference(input);
    if (counts.storageReads + counts.storageWrites + counts.storageDeletes >= 10_000) throw new MediaObjectStorageError();
    if (name === 'get') {
      if (counts.storageReadBytes + reference.byteLength > 2_000_000_000) throw new MediaObjectStorageError();
      counts.storageReads += 1; counts.storageReadBytes += reference.byteLength;
    } else if (name === 'put') {
      if (counts.storageWriteBytes + reference.byteLength > 20_000_000) throw new MediaObjectStorageError();
      counts.storageWrites += 1; counts.storageWriteBytes += reference.byteLength;
    } else counts.storageDeletes += 1;
    try { return await storage[name](reference, bytes); }
    catch (error) { counts.storageFailures += 1; throw error; }
  }
  return Object.freeze({ get: input => operation('get', input), put: (input, bytes) => operation('put', input, bytes),
    remove: input => operation('remove', input), close: () => storage.close() });
}

// Dependency seams permit isolated native tests. The CLI uses only the canonical
// implementations below; normal Customer/Platform/Demo entrypoints never import this file.
export async function startTargetLoadRuntime({ env = process.env, clock = Date.now, exit = code => process.exit(code),
  customerPersistence = createPostgresPersistence, platformPersistence = createPostgresPlatformPersistence,
  storageFactory = createNeonObjectStorage, customerComposition = createCustomerComposition,
  platformComposition = createPlatformComposition, verifyDatabase = assertLoadDatabase } = {}) {
  let settings; let boundary; let persistence; let storage; let composition; let hardExit;
  let startPromise = Promise.resolve(); let stopPromise; let stopping = false; let phase = 'configuration';
  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true; boundary?.close();
    stopPromise = (async () => {
      try {
        await startPromise.catch(() => {});
        if (composition) await composition.stop();
        else await persistence?.close();
      } finally { storage?.close(); clearTimeout(hardExit); }
    })();
    return stopPromise;
  }
  function active() {
    valid(!stopping); loadTargetScope(settings.values, clock());
    valid(clock() < settings.scope.expiresMs - 10_000);
  }
  try {
    settings = loadTargetRuntimeConfig(env, clock());
    const metrics = createMetricsRegistry(settings.scope.surface === 'platform'
      ? { assertRouteKey: assertPlatformRouteKey } : {}); let calendar;
    const counts = { workerFailures: 0, storageReads: 0, storageReadBytes: 0, storageWrites: 0,
      storageWriteBytes: 0, storageDeletes: 0, storageFailures: 0 };
    const simulated = { snapshot: () => calendar?.snapshot()
      ?? { availability: 0, create: 0, update: 0, cancel: 0, uniqueEvents: 0 } };
    boundary = createLoadRuntimeBoundary({ values: settings.values, metrics, clock, bootId: randomUUID(),
      limits: { rateLimitMax: settings.config.rateLimitMax, rateLimitWindowMs: settings.config.rateLimitWindowMs,
        databasePoolMax: settings.config.databasePoolMax },
      activity: () => counts, calendar: settings.scope.surface === 'customer' ? simulated : null });
    // Both timers are rooted in first resource creation, including async setup.
    // Shutdown starts ten seconds early; a wedged shutdown cannot renew lifetime.
    hardExit = setTimeout(() => exit(1), Math.max(0, settings.scope.expiresMs - clock()));
    hardExit.unref();
    boundary.arm(() => { stop().then(() => exit(0), () => exit(1)); });
    active();
    if (settings.scope.surface === 'customer') {
      storage = boundedStorage(storageFactory(settings.storageConfig), counts);
      persistence = customerPersistence(settings.config, { mediaObjectStorage: storage });
    } else {
      persistence = platformPersistence(settings.config);
      const projection = persistence.projectionRepository;
      if (typeof projection?.subscribe === 'function') persistence = { ...persistence, projectionRepository: {
        ...projection, async subscribe(wake, unavailable) {
          try { return await projection.subscribe(wake, (...args) => { counts.workerFailures += 1; unavailable(...args); }); }
          catch (error) { counts.workerFailures += 1; throw error; }
        },
      } };
    }
    phase = 'database';
    await verifyDatabase(persistence.pool, settings.scope, { clock }); active();
    if (settings.scope.surface === 'customer') {
      phase = 'fixture';
      const rows = await fixtureBindings(persistence.pool); active();
      valid(rows.some(row => row.tenant_id === settings.storageProbe.tenantId));
      calendar = createTargetLoadCalendar(new Map(rows.map(row => [row.reference, { address: row.address }])));
      phase = 'storage';
      await storage.get(settings.storageProbe); active();
      phase = 'composition';
      composition = customerComposition({ config: settings.config, persistence, microsoft365Client: calendar.client,
        entraClient: null, metrics, logger: createLogger({ write() {} }), shutdownTimeoutMs: 5000,
        httpServerFactory: options => { const server = createHttpServer(options); boundary.install(server); return server; } });
    } else {
      phase = 'composition';
      composition = platformComposition({ config: settings.config, persistence, metrics, shutdownTimeoutMs: 5000,
        authenticationFactory: createLoadPlatformAuthentication,
        projectionRunGate: async work => {
          active();
          try { const result = await work(); active(); return result; }
          catch (error) { counts.workerFailures += 1; throw error; }
        },
        httpServerFactory: options => { const server = createPlatformHttpServer(options); boundary.install(server); return server; } });
    }
    active(); phase = 'start'; startPromise = composition.start(); await startPromise; active();
    return Object.freeze({ stop });
  } catch {
    try { await stop(); } catch { /* Only the fixed runtime failure crosses the entrypoint. */ }
    const error = new Error('LOAD_TARGET_RUNTIME_FAILED');
    error.phase = phase;
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startTargetLoadRuntime().then(runtime => {
    process.stdout.write('LOAD_TARGET_READY\n');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      runtime.stop().then(() => process.exit(0), () => process.exit(1));
    });
  }).catch(() => { process.stderr.write('LOAD_TARGET_RUNTIME_FAILED\n'); process.exit(1); });
}
