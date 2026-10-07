import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('known sanitized media payload');
const digest = createHash('sha256').update(bytes).digest('hex');
const reference = (assetId) => mediaObjectReference({ tenantId: TENANT, assetId,
  kind: 'room', contentType: 'image/webp', byteLength: bytes.length, sha256: digest });

test('private media metadata preserves rollback, immutable intents, orphan recovery and live references', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  await migrateUp(pool);
  await pool.query("INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Tenant', 'active')", [TENANT]);
  await pool.query("INSERT INTO users (tenant_id, id, display_name) VALUES ($1,$2,'Manager')", [TENANT, USER]);
  await pool.query("INSERT INTO sites (tenant_id,id,name) VALUES ($1,'site','Site')", [TENANT]);
  await pool.query("INSERT INTO rooms (tenant_id,id,site_id,name,capacity) VALUES ($1,'room','site','Room',10)", [TENANT]);
  const objects = new Map();
  const calls = [];
  const storage = {
    async put(ref, value) { calls.push(['put', ref.key]); objects.set(ref.key, Buffer.from(value)); return ref.key; },
    async get(ref) { calls.push(['get', ref.key]); return objects.get(ref.key); },
    async remove(ref) { calls.push(['remove', ref.key]); objects.delete(ref.key); },
  };
  const repository = createPostgresMediaObjectRepository(pool, { storage });
  const durable = reference('44444444-4444-4444-8444-444444444444');
  await repository.register(durable);
  await repository.register(durable);
  await assert.rejects(repository.putWithClient(pool, durable, bytes), /UPLOAD_TRANSACTION_REQUIRED/);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 1);
  await assert.rejects(withPostgresTransaction(pool, () => repository.register(durable)), /INDEPENDENT_COMMIT/);
  await assert.rejects(pool.query('UPDATE media_object_inventory SET registered_at = clock_timestamp()'), /INVENTORY_IMMUTABLE/);
  await assert.rejects(withPostgresTransaction(pool, async (client) => {
    await repository.putWithClient(client, durable, bytes);
    throw new Error('AUDIT_FAILED');
  }), /AUDIT_FAILED/);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 1);
  assert.deepEqual(objects.get(durable.key), bytes);
  await assert.rejects(repository.read(durable, `v1/${FOREIGN}/room/${durable.assetId}/${digest}`), /INTEGRITY_FAILED/);
  assert.deepEqual(await repository.read(durable, durable.key), bytes);
  await assert.rejects(rollbackLatest(pool), /PRIVATE_MEDIA_OBJECTS_REQUIRE_VERIFIED_ROLLBACK/);
  await assert.rejects(pool.query(`INSERT INTO tenant_room_media_assets
    (tenant_id,id,room_id,bytes,byte_length,width,height,content_sha256,created_by_user_id)
    VALUES ($1,$2,'room',NULL,$3,1,1,$4,$5)`,
  [TENANT, durable.assetId, bytes.length, Buffer.from(digest, 'hex'), USER]), (error) => error.code === '23514');
  await pool.query(`INSERT INTO tenant_room_media_assets
    (tenant_id,id,room_id,bytes,object_key,byte_length,width,height,content_sha256,created_by_user_id)
    VALUES ($1,$2,'room',NULL,$3,$4,1,1,$5,$6)`,
  [TENANT, durable.assetId, durable.key, bytes.length, Buffer.from(digest, 'hex'), USER]);
  await assert.rejects(pool.query('UPDATE tenant_room_media_assets SET object_key = $1 WHERE id = $2',
    [`v1/${FOREIGN}/room/${durable.assetId}/${digest}`, durable.assetId]), (error) => error.code === '23514');

  const oldLive = reference('55555555-5555-4555-8555-555555555555');
  const oldOrphan = reference('66666666-6666-4666-8666-666666666666');
  const oldLocked = reference('77777777-7777-4777-8777-777777777777');
  for (const ref of [oldLive, oldOrphan, oldLocked]) {
    await pool.query(`INSERT INTO media_object_inventory
      (object_key,tenant_id,asset_id,kind,content_type,byte_length,content_sha256,registered_at)
      VALUES ($1,$2,$3,'room','image/webp',$4,$5,clock_timestamp() - INTERVAL '31 days')`,
    [ref.key, TENANT, ref.assetId, bytes.length, Buffer.from(digest, 'hex')]);
    objects.set(ref.key, bytes);
  }
  await pool.query(`INSERT INTO tenant_room_media_assets
    (tenant_id,id,room_id,bytes,object_key,byte_length,width,height,content_sha256,created_by_user_id)
    VALUES ($1,$2,'room',NULL,$3,$4,1,1,$5,$6)`,
  [TENANT, oldLive.assetId, oldLive.key, bytes.length, Buffer.from(digest, 'hex'), USER]);
  await pool.query(`INSERT INTO tenant_location_revisions
    (tenant_id,revision,configuration,changed_at,actor_user_id)
    VALUES ($1,1,$2::jsonb,clock_timestamp(),$3)`,
  [TENANT, JSON.stringify({ rooms: [{ id: 'room', mediaAssetIds: [oldLive.assetId] }] }), USER]);
  // A writer has the inventory lock before publishing the metadata; cleanup skips it.
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT object_key FROM media_object_inventory WHERE object_key = $1 FOR UPDATE', [oldLocked.key]);
    assert.deepEqual(await repository.pruneOrphans(), { inspected: 1, deleted: 1, bytes: bytes.length, hasMore: false });
    assert.equal(objects.has(oldOrphan.key), false);
    assert.equal(objects.has(oldLocked.key), true);
    assert.equal(objects.has(oldLive.key), true);
    assert.equal(objects.has(durable.key), true);
    await writer.query('ROLLBACK');
  } finally { writer.release(); }
  assert.deepEqual(await repository.pruneOrphans(), { inspected: 1, deleted: 1, bytes: bytes.length, hasMore: false });
  assert.equal(objects.has(oldLive.key), true);
  await assert.rejects(repository.pruneOrphans({ limit: 101 }), /LIMIT_INVALID/);
  assert.equal(calls.filter(([action]) => action === 'remove').length, 2);
  // Restore bytes and clear pointers before rollback; inventory custody still blocks it.
  await pool.query('UPDATE tenant_room_media_assets SET bytes = $1, object_key = NULL', [bytes]);
  await assert.rejects(rollbackLatest(pool), /PRIVATE_MEDIA_OBJECTS_REQUIRE_VERIFIED_ROLLBACK/);
  await pool.query('DELETE FROM media_object_inventory');
  assert.equal(await rollbackLatest(pool), true);
  await migrateUp(pool);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tenant_room_media_assets')).rows[0].count, 2);
});
