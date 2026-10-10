import { Client } from 'pg';
import { writeFile } from 'node:fs/promises';
import { loadDemoConfig, loadDemoCustomerConfig, loadDemoPlatformConfig } from '../src/demo/config.js';
import { createDemoCustomerComposition } from '../src/demo/customer-composition.js';
import { createDemoPlatformComposition } from '../src/demo/platform-composition.js';
import { createNeonObjectStorage } from '../src/media/neon-object-storage.js';
import { readRestoredMediaReferences, verifyRestoredProviderBytes, verifyRestoredSemanticState } from './support/neon-recovery-media.mjs';
import { runRecoveryFaultScenarios, verifyRecoveryBaseline } from './support/neon-recovery-scenarios.mjs';
import { closeNeonRecoveryResources } from './support/neon-recovery-cleanup.mjs';
import { createNeonRecoveryPreflightDiagnostics } from './support/neon-recovery-diagnostics.mjs';
import { readDemoSemanticState } from '../src/persistence/postgres/demo-fixture-state.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresMediaBackfillRepository } from '../src/persistence/postgres/media-backfill-repository.js';
import { loadNeonRecoveryConfig, assertNeonRecoveryIdentity, RECOVERY_ROOT,
  RECOVERY_SNAPSHOT } from './support/neon-recovery-config.mjs';

const mode = process.argv[2];
const diagnostics = mode === 'preflight'
  ? createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef: process.env.GITHUB_SHA }) : null;
let storage;
let composition;
let expiryTimer;
let stopping = false;
let maintenancePool;
const clients = [];
try {
  if (process.argv.length !== 3 || !['preflight', 'faults', 'inventory', 'rollback', 'customer', 'platform'].includes(mode)) {
    throw new Error('NEON_RECOVERY_MODE_INVALID');
  }
  const settings = loadNeonRecoveryConfig(process.env);
  const config = mode === 'customer' ? loadDemoCustomerConfig(process.env)
    : mode === 'platform' ? loadDemoPlatformConfig(process.env) : loadDemoConfig(process.env);
  const expectedKeys = mode === 'customer' ? ['DEMO_CUSTOMER_DATABASE_URL']
    : mode === 'platform' ? ['DEMO_PLATFORM_DATABASE_URL', 'DEMO_RESET_DATABASE_URL']
      : ['DEMO_CUSTOMER_DATABASE_URL', 'DEMO_PLATFORM_DATABASE_URL', 'DEMO_RESET_DATABASE_URL', 'DEMO_MIGRATION_DATABASE_URL'];
  if (settings.databases.length !== expectedKeys.length
    || expectedKeys.some((key) => !settings.databases.some((database) => database.key === key))) {
    throw new Error('NEON_RECOVERY_IDENTITY_INVALID');
  }
  diagnostics?.advance('identities');
  let expires = Infinity;
  for (const database of settings.databases) {
    const client = new Client({ connectionString: database.url, ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000 });
    clients.push(client);
    await client.connect();
    await client.query('BEGIN READ ONLY');
    expires = Math.min(expires, await assertNeonRecoveryIdentity(client, database.role, settings.branch));
    await client.query('COMMIT');
  }
  const operator = clients.at(-1);
  if (mode === 'preflight') {
    diagnostics.advance('schema');
    const versions = await operator.query(`SELECT (SELECT max(version) FROM schema_migrations) AS runtime,
      (SELECT max(version) FROM demo_schema_migrations) AS overlay`);
    if (versions.rows[0]?.runtime !== 44 || versions.rows[0]?.overlay !== 9) {
      throw new Error('NEON_RECOVERY_SCHEMA_INVALID');
    }
    diagnostics.advance('database-media');
    await operator.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { references, manifest, digest } = await readRestoredMediaReferences(operator);
    diagnostics.advance('provider-bytes');
    storage = createNeonObjectStorage(settings.storage);
    await verifyRestoredProviderBytes(storage, references);
    diagnostics.advance('semantic-state');
    const mediaObjects = createPostgresMediaObjectRepository(operator, { storage, includeDemoCatalogue: true });
    const semanticChecksum = verifyRestoredSemanticState(await readDemoSemanticState({ client: operator, mediaObjects }));
    diagnostics.advance('commit');
    await operator.query('COMMIT');
    diagnostics.advance('report');
    await writeFile('neon-recovery-preflight.json', `${JSON.stringify({ schemaVersion: 1,
      scope: 'restored-pair-byte-preflight-not-full-recovery', sourceRuntimeRef: process.env.GITHUB_SHA,
      branch: settings.branch, sourceBranch: RECOVERY_ROOT, snapshot: RECOVERY_SNAPSHOT,
      objects: manifest, manifestSha256: digest, semanticChecksum,
      databaseBlobsVerified: true, providerBytesVerified: true, businessStateVerified: true })}\n`,
    { mode: 0o600, flag: 'wx' });
  } else if (mode === 'faults') {
    const evidence = { schemaVersion: 1, scope: 'restored-pair-http-fault-history-not-full-recovery',
      sourceRuntimeRef: process.env.GITHUB_SHA, branch: settings.branch,
      sourceBranch: RECOVERY_ROOT, snapshot: RECOVERY_SNAPSHOT, outcome: 'started', cases: [] };
    try {
      const authority = await operator.query(`SELECT has_table_privilege(current_user,
        'public.media_object_inventory', 'DELETE') AS maintenance`);
      if (authority.rows[0]?.maintenance !== true) throw new Error('NEON_RECOVERY_MAINTENANCE_INVALID');
      storage = createNeonObjectStorage(settings.storage);
      const before = await verifyRecoveryBaseline({ client: operator, storage });
      evidence.before = { manifestSha256: before.digest, objects: before.references.length,
        semanticChecksum: before.semanticChecksum, retainedDatabaseBlobsVerified: true, providerBytesVerified: true };
      maintenancePool = createPostgresPool({ mode: 'test', databaseUrl: config.databases.migration.url,
        databaseSsl: 'verify-full', databasePoolMax: 2, databaseConnectionTimeoutMs: 5000,
        databaseStatementTimeoutMs: 10000, databaseIdleTimeoutMs: 1000 });
      const mediaObjects = createPostgresMediaObjectRepository(maintenancePool, { storage, includeDemoCatalogue: true });
      const repository = createPostgresMediaBackfillRepository(maintenancePool, { mediaObjects, includeDemoCatalogue: true });
      const assertAuthority = async () => {
        try {
          await operator.query('BEGIN READ ONLY');
          const currentExpiry = await assertNeonRecoveryIdentity(operator, config.databases.migration.role, settings.branch);
          await operator.query('COMMIT');
          return currentExpiry;
        } catch {
          await operator.query('ROLLBACK').catch(() => {});
          throw new Error('NEON_RECOVERY_MUTATION_AUTHORITY_INVALID');
        }
      };
      await runRecoveryFaultScenarios({ client: operator, repository, storage, settings,
        references: before.references, expiresAt: expires, assertAuthority, evidence });
      evidence.outcome = 'passed';
    } catch (error) {
      evidence.outcome = 'failed';
      evidence.restorationFailed = error?.message === 'NEON_RECOVERY_RESTORATION_FAILED';
      throw error;
    } finally {
      await writeFile('neon-recovery-faults.json', `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: 'wx' });
    }
  } else if (mode === 'inventory') {
    await operator.query('BEGIN READ ONLY');
    const result = await operator.query(`SELECT object_key, content_type, byte_length,
      encode(content_sha256, 'hex') AS sha256, registered_at FROM media_object_inventory ORDER BY object_key LIMIT 10001`);
    if (result.rows.length > 10000) throw new Error('NEON_RECOVERY_INVENTORY_INVALID');
    await operator.query('COMMIT');
    await writeFile('neon-recovery-inventory.json', `${JSON.stringify({ schemaVersion: 1,
      scope: 'restored-pair-custody-not-full-recovery', sourceRuntimeRef: process.env.GITHUB_SHA,
      branch: settings.branch, objects: result.rows })}\n`, { mode: 0o600, flag: 'wx' });
  } else if (mode === 'rollback') {
    const authority = await operator.query(`SELECT has_table_privilege(current_user,
      'public.media_object_inventory', 'DELETE') AS maintenance`);
    if (authority.rows[0]?.maintenance !== true) throw new Error('NEON_RECOVERY_MAINTENANCE_INVALID');
    storage = createNeonObjectStorage(settings.storage);
    maintenancePool = createPostgresPool({ mode: 'test', databaseUrl: config.databases.migration.url,
      databaseSsl: 'verify-full', databasePoolMax: 2, databaseConnectionTimeoutMs: 5000,
      databaseStatementTimeoutMs: 10000, databaseIdleTimeoutMs: 1000 });
    const mediaObjects = createPostgresMediaObjectRepository(maintenancePool, { storage, includeDemoCatalogue: true });
    const repository = createPostgresMediaBackfillRepository(maintenancePool, { mediaObjects, includeDemoCatalogue: true });
    const batches = [];
    for (const kind of ['room', 'catalogue']) {
      let completed = false;
      for (let batch = 0; batch < 6; batch += 1) {
        if (Date.now() >= expires) throw new Error('NEON_RECOVERY_EXPIRED');
        const result = await repository.runBatch({ phase: 'rollback', kind });
        batches.push({ kind, ...result });
        if (!result.hasMore) { completed = true; break; }
      }
      if (!completed) throw new Error('NEON_RECOVERY_ROLLBACK_INCOMPLETE');
    }
    const verified = await operator.query(`SELECT count(*)::integer AS assets,
      bool_and(bytes IS NOT NULL AND octet_length(bytes) = byte_length AND sha256(bytes) = content_sha256
        AND object_key IS NULL) AS valid FROM (
        SELECT bytes, byte_length, content_sha256, object_key FROM tenant_room_media_assets
        UNION ALL SELECT bytes, byte_length, content_sha256, object_key FROM demo_catalogue_media_assets) a`);
    if (verified.rows[0]?.assets !== 34 || verified.rows[0]?.valid !== true) {
      throw new Error('NEON_RECOVERY_ROLLBACK_INVALID');
    }
    await writeFile('neon-recovery-rollback.json', `${JSON.stringify({ schemaVersion: 1,
      scope: 'bounded-operator-rollback-not-full-recovery', sourceRuntimeRef: process.env.GITHUB_SHA,
      branch: settings.branch, batches, databaseBlobsVerified: true, pointersCleared: true })}\n`, { mode: 0o600, flag: 'wx' });
  } else {
    storage = createNeonObjectStorage(settings.storage);
    composition = mode === 'customer'
      ? createDemoCustomerComposition({ config, mediaObjectStorage: storage })
      : createDemoPlatformComposition({ config, resetMediaObjectStorage: storage });
    await composition.start();
    expiryTimer = setTimeout(() => stop(1), Math.max(0, expires - Date.now()));
    process.once('SIGTERM', () => stop(0));
    process.once('SIGINT', () => stop(0));
  }
} catch (error) {
  process.stderr.write('NEON_RECOVERY_ACCEPTANCE_FAILED\n');
  process.exitCode = 1;
  if (diagnostics) await diagnostics.retainFailure(error);
  if (composition) await closeNeonRecoveryResources([() => composition.stop()]);
  composition = null;
} finally {
  await closeNeonRecoveryResources([
    ...clients.map((client) => () => client.end()),
    () => maintenancePool?.end(),
    () => { if (!composition) return storage?.close(); },
  ]);
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(expiryTimer);
  process.exitCode ||= code;
  await closeNeonRecoveryResources([() => composition.stop(), () => storage.close()]);
}
