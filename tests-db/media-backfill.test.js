import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresMediaBackfillRepository } from '../src/persistence/postgres/media-backfill-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('retained sanitized image bytes');

test('bounded backfill, idempotent copy, guarded purge and verified rollback preserve real PostgreSQL media', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Tenant','active')", [TENANT]);
  await pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,'Manager')", [TENANT, USER]);
  await pool.query("INSERT INTO sites (tenant_id,id,name) VALUES ($1,'site','Site')", [TENANT]);
  await pool.query("INSERT INTO rooms (tenant_id,id,site_id,name,capacity) VALUES ($1,'room','site','Room',10)", [TENANT]);
  await pool.query(`INSERT INTO tenant_room_media_assets
    (tenant_id,id,room_id,bytes,byte_length,width,height,content_sha256,created_by_user_id)
    VALUES ($1,$2,'room',$3,$4,1,1,$5,$6)`,
  [TENANT, ASSET, bytes, bytes.length, createHash('sha256').update(bytes).digest(), USER]);
  const objects = new Map();
  let corrupt = false;
  const storage = {
    async put(ref, value) { objects.set(ref.key, Buffer.from(value)); return ref.key; },
    async get(ref) { return corrupt ? Buffer.from('corrupt') : objects.get(ref.key); },
    async remove(ref) { objects.delete(ref.key); },
  };
  const mediaObjects = createPostgresMediaObjectRepository(pool, { storage });
  const repository = createPostgresMediaBackfillRepository(pool, { mediaObjects });
  const read = async () => (await pool.query('SELECT bytes,object_key FROM tenant_room_media_assets WHERE id = $1', [ASSET])).rows[0];
  corrupt = true;
  await assert.rejects(repository.runBatch({ phase: 'copy', kind: 'room' }), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal((await read()).object_key, null);
  assert.deepEqual((await read()).bytes, bytes);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 1);
  corrupt = false;
  assert.equal((await repository.runBatch({ phase: 'copy', kind: 'room' })).changed, 1);
  const copied = await read();
  assert.deepEqual(copied.bytes, bytes);
  assert.deepEqual(objects.get(copied.object_key), bytes);
  assert.equal((await repository.runBatch({ phase: 'copy', kind: 'room' })).changed, 0);
  await assert.rejects(rollbackLatest(pool), /PRIVATE_MEDIA_OBJECTS_REQUIRE_VERIFIED_ROLLBACK/);
  await assert.rejects(repository.runBatch({ phase: 'purge', kind: 'room' }), /RESTORE_EVIDENCE_REQUIRED/);
  corrupt = true;
  const restoreEvidenceSha256 = 'a'.repeat(64); // Test-only acceptance binding; no hosted acceptance claim.
  await assert.rejects(repository.runBatch({ phase: 'purge', kind: 'room', restoreEvidenceSha256 }),
    { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.deepEqual((await read()).bytes, bytes);
  corrupt = false;
  assert.equal((await repository.runBatch({ phase: 'purge', kind: 'room', restoreEvidenceSha256 })).changed, 1);
  assert.equal((await read()).bytes, null);
  corrupt = true;
  await assert.rejects(repository.runBatch({ phase: 'rollback', kind: 'room' }), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal((await read()).bytes, null);
  assert.equal((await read()).object_key, copied.object_key);
  corrupt = false;
  assert.equal((await repository.runBatch({ phase: 'rollback', kind: 'room' })).changed, 1);
  assert.deepEqual(await read(), { bytes, object_key: null });
  assert.equal((await repository.runBatch({ phase: 'rollback', kind: 'room' })).changed, 0);
  assert.ok(objects.has(copied.object_key));
  await assert.rejects(rollbackLatest(pool), /PRIVATE_MEDIA_OBJECTS_REQUIRE_VERIFIED_ROLLBACK/);
});
