import { loadDatabaseConfig } from '../src/config.js';
import { createNeonObjectStorage, validateNeonStorageConfig } from '../src/media/neon-object-storage.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresMediaBackfillRepository } from '../src/persistence/postgres/media-backfill-repository.js';

const [execute, phase, kind, evidenceArgument, ...extra] = process.argv.slice(2);
const evidencePattern = /^--restore-evidence-sha256=([a-f0-9]{64})$/;
if (execute !== '--execute' || !['copy', 'rollback', 'purge'].includes(phase)
  || !['room', 'catalogue'].includes(kind) || extra.length
  || (phase === 'purge' ? !evidencePattern.test(evidenceArgument || '') : evidenceArgument !== undefined)) {
  throw new Error('MEDIA_MIGRATION_EXECUTE_CONTRACT_REQUIRED');
}
if (!process.env.MEDIA_MIGRATION_DATABASE_URL || !process.env.MEDIA_MIGRATION_DATABASE_ROLE
  || !/^[a-z][a-z0-9_]{2,62}$/.test(process.env.MEDIA_MIGRATION_DATABASE_ROLE)
  || process.env.MEDIA_MIGRATION_DATABASE_URL === process.env.DATABASE_URL
  || process.env.MEDIA_MIGRATION_DATABASE_ROLE === process.env.DEMO_CUSTOMER_DATABASE_ROLE
  || process.env.MEDIA_MIGRATION_DATABASE_ROLE === process.env.DEMO_PLATFORM_DATABASE_ROLE) {
  throw new Error('MEDIA_MIGRATION_SEPARATE_OPERATOR_IDENTITY_REQUIRED');
}
const mode = process.env.NODE_ENV || 'production';
const database = loadDatabaseConfig({ ...process.env, DATABASE_URL: process.env.MEDIA_MIGRATION_DATABASE_URL }, mode);
const settings = validateNeonStorageConfig({ endpoint: process.env.MEDIA_OPERATOR_ENDPOINT,
  region: process.env.MEDIA_OPERATOR_REGION, bucket: process.env.MEDIA_OPERATOR_BUCKET,
  accessKeyId: process.env.MEDIA_OPERATOR_ACCESS_KEY_ID, secretAccessKey: process.env.MEDIA_OPERATOR_SECRET_ACCESS_KEY });
const restoreEvidenceSha256 = evidenceArgument?.match(evidencePattern)?.[1] || null;
const pool = createPostgresPool({ mode, ...database, databasePoolMax: 2 });
let storage;
try {
  // Validate the database authority before allocating a provider client or touching objects.
  const identity = await pool.query(`SELECT current_user AS role,
    has_table_privilege(current_user, 'public.media_object_inventory', 'DELETE') AS maintenance_authority`);
  if (identity.rows[0]?.role !== process.env.MEDIA_MIGRATION_DATABASE_ROLE) throw new Error('MEDIA_MIGRATION_ROLE_MISMATCH');
  if (identity.rows[0]?.maintenance_authority !== true) throw new Error('MEDIA_MIGRATION_OPERATOR_PRIVILEGES_REQUIRED');
  if (!await isPostgresSchemaReady(pool)) throw new Error('MEDIA_MIGRATION_SCHEMA_NOT_READY');
  if (kind === 'catalogue') {
    const overlay = await pool.query('SELECT max(version)::integer AS version FROM demo_schema_migrations');
    if (overlay.rows[0]?.version !== 8) throw new Error('MEDIA_MIGRATION_DEMO_SCHEMA_NOT_READY');
  }
  storage = createNeonObjectStorage(settings);
  const mediaObjects = createPostgresMediaObjectRepository(pool, { storage, includeDemoCatalogue: kind === 'catalogue' });
  const repository = createPostgresMediaBackfillRepository(pool, { mediaObjects, includeDemoCatalogue: kind === 'catalogue' });
  // Exactly one bounded batch per invocation. Repeated commands are idempotent and operator-driven;
  // there is no unbounded drain loop, deployment hook or automatically scheduled migration.
  const result = await repository.runBatch({ phase, kind, restoreEvidenceSha256 });
  process.stdout.write(`${JSON.stringify({ status: result.hasMore ? 'incomplete' : 'completed',
    ...result, restoreEvidenceSha256 })}\n`);
} catch (error) {
  const code = ['MEDIA_MIGRATION_ROLE_MISMATCH', 'MEDIA_MIGRATION_OPERATOR_PRIVILEGES_REQUIRED', 'MEDIA_MIGRATION_SCHEMA_NOT_READY',
    'MEDIA_MIGRATION_DEMO_SCHEMA_NOT_READY'].includes(error?.message) ? error.message : 'MEDIA_MIGRATION_FAILED';
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
  process.exitCode = 1;
} finally {
  storage?.close();
  await pool.end();
}
