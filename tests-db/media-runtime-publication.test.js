import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresRoomMediaRepository } from '../src/persistence/postgres/room-media-repository.js';
import { createPostgresDemoCatalogueMediaRepository } from '../src/persistence/postgres/demo-catalogue-media-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const bytes = Buffer.from('already sanitized WebP bytes for a valid fixture');

test('private media publishes verified objects audit-atomically under the real Customer role', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  const roles = Object.fromEntries(['customer', 'platform', 'reset'].map((surface) => [surface,
    `cm_object_${surface}_${process.pid}`]));
  let scopedClient;
  t.after(async () => {
    try {
      if (scopedClient) { await scopedClient.query('RESET ROLE'); scopedClient.release(); }
      for (const role of Object.values(roles)) {
        await pool.query(`DROP OWNED BY "${role}"`);
        await pool.query(`DROP ROLE "${role}"`);
      }
    } finally { await pool.end(); }
  });
  await migrateUp(pool);
  for (const role of Object.values(roles)) await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await migrateDemoUp(pool, { roles });
  for (const [tenantId, userId] of [[TENANT, USER], [FOREIGN, OTHER_USER]]) {
    await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Tenant','active')", [tenantId]);
    await pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,'Manager')", [tenantId, userId]);
    await pool.query("INSERT INTO sites (tenant_id,id,name) VALUES ($1,'site','Site')", [tenantId]);
    await pool.query("INSERT INTO rooms (tenant_id,id,site_id,name,capacity) VALUES ($1,'room','site','Room',10)", [tenantId]);
    await pool.query(`INSERT INTO catering_items
      (tenant_id,id,name,price_minor,active) VALUES ($1,'item','Item',100,true)`, [tenantId]);
  }
  const objects = new Map();
  const calls = [];
  let corruptRead = false;
  const storage = {
    async put(ref, value) { calls.push(['put', ref.key]); objects.set(ref.key, Buffer.from(value)); return ref.key; },
    async get(ref) { calls.push(['get', ref.key]); return corruptRead ? Buffer.from('corrupt') : objects.get(ref.key); },
    async remove(ref) { calls.push(['remove', ref.key]); objects.delete(ref.key); },
  };
  scopedClient = await pool.connect();
  await scopedClient.query(`SET ROLE "${roles.customer}"`);
  const client = { query: (query) => scopedClient.query(query), release() {} };
  const runtimePool = { query: client.query, async connect() { return client; } };
  const mediaObjects = createPostgresMediaObjectRepository(runtimePool, { storage, includeDemoCatalogue: true });
  let failAudit = false;
  const auditRepository = { async appendWithClient() { if (failAudit) throw new Error('AUDIT_FAILED'); } };
  const room = createPostgresRoomMediaRepository(runtimePool, { mediaObjects, auditRepository });
  const catalogue = createPostgresDemoCatalogueMediaRepository(runtimePool, { mediaObjects, auditRepository });
  const upload = { tenantId: TENANT, roomId: 'room', actorUserId: USER,
    image: { bytes, contentType: 'image/webp', width: 1, height: 1 }, auditEvent: () => ({}) };

  assert.equal(await room.create({ ...upload, tenantId: FOREIGN }), null);
  assert.equal(await room.create({ ...upload, roomId: 'missing' }), null);
  assert.equal(calls.length, 0);
  failAudit = true;
  await assert.rejects(room.create(upload), /AUDIT_FAILED/);
  failAudit = false;
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tenant_room_media_assets')).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 1);
  assert.equal(objects.size, 1);
  corruptRead = true;
  await assert.rejects(room.create(upload), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  corruptRead = false;
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tenant_room_media_assets')).rows[0].count, 0);

  const created = await room.create(upload);
  const persisted = (await pool.query('SELECT bytes,object_key FROM tenant_room_media_assets WHERE id = $1', [created.assetId])).rows[0];
  assert.equal(persisted.bytes, null);
  assert.deepEqual(objects.get(persisted.object_key), bytes);
  const read = { tenantId: TENANT, roomId: 'room', assetId: created.assetId, includeInactive: false };
  const beforeHidden = calls.length;
  assert.equal(await room.findAttached(read), null);
  assert.equal(await room.findAttached({ ...read, tenantId: FOREIGN }), null);
  assert.equal(calls.length, beforeHidden);
  await pool.query(`UPDATE rooms SET details = jsonb_build_object('mediaAssetIds',jsonb_build_array($2::text))
    WHERE tenant_id = $1`, [TENANT, created.assetId]);
  assert.deepEqual((await room.findAttached(read)).bytes, bytes);
  corruptRead = true;
  await assert.rejects(room.findAttached(read), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  corruptRead = false;
  await pool.query('UPDATE rooms SET active = false WHERE tenant_id = $1', [TENANT]);
  const beforeInactive = calls.length;
  assert.equal(await room.findAttached(read), null);
  assert.equal(calls.length, beforeInactive);
  assert.deepEqual((await room.findAttached({ ...read, includeInactive: true })).bytes, bytes);

  const catalogueUpload = { tenantId: TENANT, ownerKind: 'catering_item', ownerId: 'item',
    actorUserId: USER, contentType: 'image/webp', bytes, altText: 'Image', auditEvent: () => ({}) };
  const beforeForeign = calls.length;
  assert.equal(await catalogue.create({ ...catalogueUpload, tenantId: FOREIGN }), null);
  assert.equal(calls.length, beforeForeign);
  const item = await catalogue.create(catalogueUpload);
  assert.deepEqual((await catalogue.find({ tenantId: TENANT, assetId: item.assetId })).bytes, bytes);
  const beforeConflict = calls.length;
  assert.deepEqual(await catalogue.create(catalogueUpload), { conflict: true });
  assert.equal(calls.length, beforeConflict);
  const itemBefore = (await pool.query('SELECT bytes,object_key FROM demo_catalogue_media_assets WHERE id = $1', [item.assetId])).rows[0];
  assert.equal(itemBefore.bytes, null);
  const replacement = Buffer.from('different sanitized WebP revision');
  failAudit = true;
  await assert.rejects(catalogue.replace({ ...catalogueUpload, assetId: item.assetId, bytes: replacement }), /AUDIT_FAILED/);
  failAudit = false;
  const afterFailure = await pool.query('SELECT object_key FROM demo_catalogue_media_assets WHERE id = $1', [item.assetId]);
  assert.equal(afterFailure.rows[0].object_key, itemBefore.object_key);
  await catalogue.replace({ ...catalogueUpload, assetId: item.assetId, bytes: replacement });
  const itemAfter = (await pool.query('SELECT object_key,bytes FROM demo_catalogue_media_assets WHERE id = $1', [item.assetId])).rows[0];
  assert.notEqual(itemAfter.object_key, itemBefore.object_key);
  assert.equal(itemAfter.bytes, null);
  assert.ok(objects.has(itemBefore.object_key));
  assert.deepEqual((await catalogue.find({ tenantId: TENANT, assetId: item.assetId })).bytes, replacement);
  const beforeForeignRead = calls.length;
  assert.equal(await catalogue.find({ tenantId: FOREIGN, assetId: item.assetId }), null);
  assert.equal(calls.length, beforeForeignRead);
  assert.equal(await catalogue.remove({ tenantId: TENANT, assetId: item.assetId, actorUserId: USER, auditEvent: () => ({}) }), true);
  assert.equal(await catalogue.find({ tenantId: TENANT, assetId: item.assetId }), null);
  assert.ok(objects.has(itemAfter.object_key));
  assert.equal(calls.some(([action]) => action === 'remove'), false);
});
