import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createNeonObjectStorage } from '../src/media/neon-object-storage.js';
import { createLogger } from '../src/logger.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { migrateUp } from './db-migrations.mjs';
import { assertLoadDatabase, loadTargetScope } from './support/target-load-guard.mjs';
import { createTargetLoadCalendar } from './support/target-load-calendar.mjs';
import { seedBookingLoadFixtures } from './support/target-load-fixtures.mjs';
import { prepareBookingLoadMedia } from './support/target-load-media-fixtures.mjs';
import { grantTargetLoadRoles } from './support/target-load-role-grants.mjs';
import { loadTargetSetupConfig } from './support/target-load-setup-config.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_SETUP_FAILED'); }

export async function prepareTargetLoadSetup({ env = process.env, clock = Date.now, exit = code => process.exit(code),
  persistenceFactory = createPostgresPersistence, storageFactory = createNeonObjectStorage,
  verifyDatabase = assertLoadDatabase, grantRoles = grantTargetLoadRoles } = {}) {
  let persistence; let storage; let runtime; let timer;
  try {
    const settings = loadTargetSetupConfig(env, clock()); const { scope, values, config } = settings;
    function active() {
      loadTargetScope(values, clock()); valid(clock() < scope.expiresMs - 60_000);
    }
    timer = setTimeout(() => exit(1), Math.max(0, scope.expiresMs - clock())); timer.unref();
    active(); storage = storageFactory(settings.storageConfig);
    persistence = persistenceFactory(config, { mediaObjectStorage: storage });
    await verifyDatabase(persistence.pool, scope, { allowEmpty: true, clock }); active();
    const marker = await persistence.pool.query("SELECT pg_catalog.to_regclass('public.saas38_load_scope') AS marker");
    active(); valid(marker.rows[0]?.marker === null);
    await withPostgresTransaction(persistence.pool, async client => {
      active();
      await client.query(`CREATE TABLE public.saas38_load_scope (
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
        run_id text NOT NULL UNIQUE CHECK(run_id ~ '^[a-f0-9]{16}$'),
        release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
        created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
        CHECK(expires_at>created_at AND expires_at-created_at<=interval '2 hours'))`);
      active();
      await client.query(`INSERT INTO public.saas38_load_scope(run_id,release_sha,created_at,expires_at)
        VALUES($1,$2,$3,$4)`, [scope.runId, scope.releaseSha, scope.createdAt, scope.expiresAt]); active();
    });
    await migrateUp(persistence.pool); active();
    const tenants = Array.from({ length: 10 }, () => randomUUID());
    const sessionTtlSeconds = Math.floor((scope.expiresMs - clock() - 60_000) / 1000);
    valid(sessionTtlSeconds >= 300 && sessionTtlSeconds <= 7200);
    const data = await withPostgresTransaction(persistence.pool, client => seedBookingLoadFixtures(client, tenants,
      { population: settings.population, publicOrigin: settings.origins.customer, sessionTtlSeconds }));
    active();
    const calendar = createTargetLoadCalendar(data.bindings);
    runtime = createCustomerComposition({ config, persistence: { ...persistence, close: async () => {} },
      microsoft365Client: calendar.client, logger: createLogger({ write() {} }), shutdownTimeoutMs: 5000 });
    const address = await runtime.start(); active(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
    const media = await prepareBookingLoadMedia({ runtime, config, persistence, tenants,
      managers: data.managers, expectedRooms: data.expectedRooms, assertActive: active });
    await runtime.stop(); runtime = null; active();
    await grantRoles(persistence.pool, values, { clock }); active();
    await verifyDatabase(persistence.pool, scope, { clock }); active();
    const empty = await persistence.pool.query(`SELECT (SELECT count(*)::int FROM public.requests) AS requests,
      (SELECT count(*)::int FROM public.booking_provider_references) AS references`);
    active(); valid(empty.rows[0]?.requests === 0 && empty.rows[0]?.references === 0);
    // Private intermediate: contains raw synthetic session cookies. Never print,
    // upload as a CI artifact, commit, or copy it into public operational evidence.
    return { schemaVersion: 1, runId: scope.runId, releaseSha: scope.releaseSha,
      createdAt: scope.createdAt, expiresAt: scope.expiresAt, origins: settings.origins, tenants,
      managers: data.managers, employees: data.employees, expectedRooms: data.expectedRooms,
      images: media.images, configurations: media.configurations,
      storageProbe: { tenantId: tenants[0], ...media.images[0] } };
  } catch { throw new Error('LOAD_TARGET_SETUP_FAILED'); }
  finally {
    let cleanupFailed = false;
    try { await runtime?.stop(); } catch { cleanupFailed = true; }
    try { await persistence?.close(); } catch { cleanupFailed = true; }
    try { storage?.close(); } catch { cleanupFailed = true; }
    clearTimeout(timer);
    if (cleanupFailed) throw new Error('LOAD_TARGET_SETUP_FAILED');
  }

}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let file; let path;
  try {
    const { scope } = loadTargetSetupConfig(process.env);
    path = `/tmp/cm-saas38-load-${scope.runId}.json`;
    file = await open(path, 'wx', 0o600);
    const manifest = await prepareTargetLoadSetup();
    await file.writeFile(JSON.stringify(manifest)); await file.sync(); await file.close(); file = null;
    process.stdout.write('LOAD_TARGET_SETUP_READY\n');
  } catch {
    await file?.close().catch(() => {});
    if (file && path) await unlink(path).catch(() => {});
    process.stderr.write('LOAD_TARGET_SETUP_FAILED\n'); process.exit(1);
  }
}
