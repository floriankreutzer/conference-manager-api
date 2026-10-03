import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresRoomMediaRepository } from '../src/persistence/postgres/room-media-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

function databaseConfig() {
  const config = loadDatabaseConfig(process.env, 'test');
  if (!config.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...config };
}

test('Room bytes are Tenant-owned, attachment-bound, active-scoped and rollback guarded', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  for (const [tenantId, userId, siteId] of [
    [TENANT_A, USER_A, 'site-a'], [TENANT_B, USER_B, 'site-b'],
  ]) {
    await pool.query("INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Tenant', 'active')", [tenantId]);
    await pool.query('INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
      [tenantId, userId, 'Manager']);
    await pool.query("INSERT INTO sites (tenant_id, id, name, time_zone) VALUES ($1, $2, 'Site', 'Europe/Berlin')",
      [tenantId, siteId]);
    await pool.query("INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, 'room', $2, 'Room', 10)",
      [tenantId, siteId]);
  }
  const bytes = await sharp({ create: {
    width: 2, height: 3, channels: 3, background: '#ed4141',
  } }).webp().toBuffer();
  const repository = createPostgresRoomMediaRepository(pool, {
    auditRepository: { async appendWithClient() { return true; } },
  });
  const upload = {
    tenantId: TENANT_A, roomId: 'room', actorUserId: USER_A,
    image: { bytes, width: 2, height: 3, contentType: 'image/webp' },
    auditEvent: () => ({}),
  };
  const rejecting = createPostgresRoomMediaRepository(pool, {
    auditRepository: { async appendWithClient() { throw new Error('AUDIT_FAILED'); } },
  });
  await assert.rejects(rejecting.create(upload), /AUDIT_FAILED/);
  assert.equal(await repository.create({ ...upload, roomId: 'unknown' }), null);
  await assert.rejects(repository.create({ ...upload, tenantId: TENANT_B }),
    (error) => error.code === '23503');
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tenant_room_media_assets')).rows[0].count, 0);
  const created = await repository.create(upload);
  assert.equal(created.status, 'created');
  const ref = { tenantId: TENANT_A, roomId: 'room', assetId: created.assetId };
  assert.equal(await repository.findAttached({ ...ref, includeInactive: false }), null);
  await pool.query(`UPDATE rooms SET details = jsonb_set(details, '{mediaAssetIds}', $3::jsonb)
    WHERE tenant_id = $1 AND id = $2`, [TENANT_A, 'room', JSON.stringify([created.assetId])]);
  assert.deepEqual((await repository.findAttached({ ...ref, includeInactive: false })).bytes, bytes);
  assert.equal(await repository.findAttached({ ...ref, tenantId: TENANT_B, includeInactive: true }), null);
  await pool.query("UPDATE rooms SET active = false WHERE tenant_id = $1 AND id = 'room'", [TENANT_A]);
  assert.equal(await repository.findAttached({ ...ref, includeInactive: false }), null);
  assert.ok(await repository.findAttached({ ...ref, includeInactive: true }));
  const orphan = await repository.create(upload);
  await pool.query(`UPDATE tenant_room_media_assets SET created_at = clock_timestamp() - INTERVAL '31 days'
    WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
  [TENANT_A, [created.assetId, orphan.assetId]]);
  await pool.query(`INSERT INTO tenant_location_revisions (
    tenant_id, revision, configuration, changed_at, actor_user_id
  ) VALUES ($1, 1, $2::jsonb, clock_timestamp(), $3)`, [TENANT_A,
    JSON.stringify({ rooms: [{ id: 'room', mediaAssetIds: [created.assetId] }] }), USER_A]);
  await pool.query(`UPDATE rooms SET details = '{}'::jsonb WHERE tenant_id = $1 AND id = 'room'`, [TENANT_A]);
  assert.deepEqual(await repository.pruneExpiredUnreferenced({ tenantId: TENANT_A, asOf: new Date() }),
    { deleted: 1, bytes: bytes.length });
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM tenant_room_media_assets
    WHERE tenant_id = $1`, [TENANT_A])).rows[0].count, 1);
  assert.equal(await rollbackLatest(pool), true); // schema 042 has no Equipment receipts here
  assert.equal(await rollbackLatest(pool), true); // schema 041 drops only the maintenance procedure
  assert.equal(await rollbackLatest(pool), true); // schema 040 has no configured Guest values here
  await assert.rejects(rollbackLatest(pool), /TENANT_ROOM_MEDIA_REQUIRE_REVIEW/);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tenant_room_media_assets')).rows[0].count, 1);
});
