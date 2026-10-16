import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createNeonObjectStorage, validateNeonStorageConfig } from '../src/media/neon-object-storage.js';
import { assertOperatorIdentity, readLiveMediaInventory } from './support/live-media-operator-db.mjs';
import { LIVE_MEDIA_TARGET } from './support/live-media-operator-config.mjs';
import { loadDemoCopyDiscardContext } from './support/demo-copy-discard-context.mjs';
import { runDemoCopyDiscard, DemoCopyDiscardFailure } from './support/demo-copy-discard-run.mjs';

const output = '/tmp/demo-copy-discard-result.json';
let pool;
let storage;
let context;
try {
  context = loadDemoCopyDiscardContext(process.env);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim() !== context.sourceSha) {
    throw new Error('DEMO_COPY_SOURCE_INVALID');
  }
  const url = new URL(process.env.CM_NEON_LIVE_OPERATOR_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== LIVE_MEDIA_TARGET.databaseHost
    || url.pathname !== '/' + LIVE_MEDIA_TARGET.databaseName || url.username !== LIVE_MEDIA_TARGET.operatorRole
    || (url.port && url.port !== '5432') || url.search || url.hash) throw new Error('DEMO_COPY_DATABASE_INVALID');
  const databaseUrl = process.env.CM_NEON_LIVE_OPERATOR_DATABASE_URL;
  const config = loadDatabaseConfig({ DATABASE_URL: databaseUrl, DATABASE_SSL: 'verify-full' }, 'production');
  pool = createPostgresPool({ mode: 'production', ...config, databasePoolMax: 1 });
  await assertOperatorIdentity(pool, LIVE_MEDIA_TARGET.operatorRole);
  const settings = validateNeonStorageConfig({
    endpoint: `https://${LIVE_MEDIA_TARGET.branchId}.storage.c-5.eu-central-1.aws.neon.tech`,
    region: LIVE_MEDIA_TARGET.region, bucket: LIVE_MEDIA_TARGET.bucket,
    accessKeyId: process.env.CM_NEON_LIVE_OPERATOR_ACCESS_KEY_ID,
    secretAccessKey: process.env.CM_NEON_LIVE_OPERATOR_SECRET_ACCESS_KEY,
  });
  storage = createNeonObjectStorage(settings);
  const childEnv = { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_SSL: 'verify-full',
    MEDIA_MIGRATION_DATABASE_URL: databaseUrl, MEDIA_MIGRATION_DATABASE_ROLE: LIVE_MEDIA_TARGET.operatorRole,
    MEDIA_OPERATOR_ENDPOINT: settings.endpoint, MEDIA_OPERATOR_REGION: settings.region,
    MEDIA_OPERATOR_BUCKET: settings.bucket, MEDIA_OPERATOR_ACCESS_KEY_ID: settings.accessKeyId,
    MEDIA_OPERATOR_SECRET_ACCESS_KEY: settings.secretAccessKey };
  const result = await runDemoCopyDiscard(context, {
    readInventory: () => readLiveMediaInventory(pool), readObject: (reference) => storage.get(reference),
    discardBatch: async (kind) => {
      const raw = execFileSync(process.execPath,
        [fileURLToPath(new URL('./private-media-migration.mjs', import.meta.url)),
          '--execute', 'discard-demo-copy', kind, '--demo-data-discard=saas38-pre-pilot-demo-only'],
        { env: childEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(raw);
    },
  });
  await writeFile(output, JSON.stringify(result) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const result = { status: 'failed', code: 'DEMO_COPY_DISCARD_EXECUTION_FAILED', sourceSha: context?.sourceSha || null,
    before: error instanceof DemoCopyDiscardFailure ? error.before : null,
    receipt: error instanceof DemoCopyDiscardFailure ? error.receipt : null };
  await writeFile(output, JSON.stringify(result) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = 1;
} finally {
  storage?.close();
  await pool?.end();
}
