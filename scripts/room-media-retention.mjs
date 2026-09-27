import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { pruneExpiredUnreferencedRoomMedia } from '../src/persistence/postgres/room-media-repository.js';

const MAX_TENANTS = 10_000;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_TENANT = 10;

if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
  throw new Error('ROOM_MEDIA_RETENTION_EXECUTE_REQUIRED');
}
if (!process.env.ROOM_MEDIA_RETENTION_DATABASE_URL) {
  throw new Error('ROOM_MEDIA_RETENTION_DATABASE_REQUIRED');
}
const mode = process.env.NODE_ENV || 'production';
const database = loadDatabaseConfig({
  ...process.env,
  DATABASE_URL: process.env.ROOM_MEDIA_RETENTION_DATABASE_URL,
}, mode);
const pool = createPostgresPool({ mode, ...database });
try {
  if (!await isPostgresSchemaReady(pool)) throw new Error('ROOM_MEDIA_SCHEMA_NOT_READY');
  const asOf = (await pool.query('SELECT clock_timestamp() AS instant')).rows[0].instant;
  const tenants = await pool.query({
    name: 'room-media-retention-tenants',
    text: 'SELECT id FROM tenants ORDER BY id LIMIT $1',
    values: [MAX_TENANTS + 1],
  });
  if (tenants.rows.length > MAX_TENANTS) throw new Error('ROOM_MEDIA_RETENTION_TENANT_LIMIT');
  let deleted = 0;
  let bytes = 0;
  let incomplete = 0;
  for (const { id: tenantId } of tenants.rows) {
    let lastCount = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_TENANT; batch += 1) {
      const result = await pruneExpiredUnreferencedRoomMedia(pool, { tenantId, asOf, limit: BATCH_SIZE });
      deleted += result.deleted;
      bytes += result.bytes;
      lastCount = result.deleted;
      if (result.deleted < BATCH_SIZE) break;
    }
    if (lastCount === BATCH_SIZE) incomplete += 1;
  }
  process.stdout.write(`${JSON.stringify({ status: incomplete ? 'incomplete' : 'completed',
    tenantCount: tenants.rows.length, deleted, bytes, incomplete })}\n`);
  if (incomplete) process.exitCode = 1;
} catch (error) {
  const code = error?.message;
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: [
    'ROOM_MEDIA_SCHEMA_NOT_READY', 'ROOM_MEDIA_RETENTION_TENANT_LIMIT',
  ].includes(code) ? code : 'ROOM_MEDIA_RETENTION_FAILED' })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
