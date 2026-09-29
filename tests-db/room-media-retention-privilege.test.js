import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { pruneExpiredUnreferencedRoomMedia } from '../src/persistence/postgres/room-media-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CURRENT = '00000000-0000-4000-8000-00000000a001';
const HISTORIC = '00000000-0000-4000-8000-00000000a002';
const ORPHAN = '00000000-0000-4000-8000-00000000a003';
const YOUNG = '00000000-0000-4000-8000-00000000a004';

test('maintenance role can prune only aged unreferenced bytes through bounded procedure', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  const role = `cm_media_retention_${process.pid}`;
  t.after(async () => {
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
    await pool.end();
  });
  await migrateUp(pool);
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT SELECT (id) ON tenants TO ${role}`);
  await pool.query(`GRANT SELECT (version) ON schema_migrations TO ${role}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION public.prune_expired_unreferenced_room_media(UUID, TIMESTAMPTZ, INTEGER) TO ${role}`);
  await pool.query("INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Tenant', 'active')", [TENANT]);
  await pool.query('INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)', [TENANT, USER, 'Manager']);
  await pool.query("INSERT INTO sites (tenant_id, id, name, time_zone) VALUES ($1, 'site', 'Site', 'Europe/Berlin')", [TENANT]);
  await pool.query("INSERT INTO rooms (tenant_id, id, site_id, name, capacity, details) VALUES ($1, 'room', 'site', 'Room', 10, $2::jsonb)",
    [TENANT, JSON.stringify({ mediaAssetIds: [CURRENT] })]);
  await pool.query(`INSERT INTO tenant_location_revisions
    (tenant_id, revision, configuration, changed_at, actor_user_id)
    VALUES ($1, 1, $2::jsonb, clock_timestamp(), $3)`,
  [TENANT, JSON.stringify({ rooms: [{ id: 'room', mediaAssetIds: [HISTORIC] }] }), USER]);
  for (const [id, age] of [[CURRENT, 31], [HISTORIC, 31], [ORPHAN, 31], [YOUNG, 29]]) {
    await pool.query(`INSERT INTO tenant_room_media_assets
      (tenant_id, id, room_id, bytes, byte_length, width, height, content_sha256,
       created_at, created_by_user_id)
      VALUES ($1, $2, 'room', decode('52494646', 'hex'), 4, 1, 1,
       decode(repeat('ab', 32), 'hex'), clock_timestamp() - $3::integer * INTERVAL '1 day', $4)`,
    [TENANT, id, age, USER]);
  }

  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    const privileges = await client.query(`SELECT
      has_table_privilege(current_user, 'tenant_room_media_assets', 'DELETE') AS can_delete,
      has_table_privilege(current_user, 'tenants', 'UPDATE') AS can_update_tenant,
      has_function_privilege(current_user,
        'public.prune_expired_unreferenced_room_media(uuid,timestamptz,integer)', 'EXECUTE') AS can_execute`);
    assert.deepEqual(privileges.rows[0],
      { can_delete: false, can_update_tenant: false, can_execute: true });
    await assert.rejects(client.query('DELETE FROM tenant_room_media_assets WHERE tenant_id = $1', [TENANT]),
      (error) => error.code === '42501');
    const limitedPool = { query: client.query.bind(client) };
    assert.deepEqual(await pruneExpiredUnreferencedRoomMedia(limitedPool,
      { tenantId: TENANT, asOf: new Date(), limit: 100 }), { deleted: 1, bytes: 4 });
    assert.deepEqual(await pruneExpiredUnreferencedRoomMedia(limitedPool,
      { tenantId: TENANT, asOf: new Date('2099-01-01T00:00:00Z'), limit: 100 }),
    { deleted: 0, bytes: 0 });
  } finally {
    client.release(true);
  }
  const remaining = await pool.query(
    'SELECT id FROM tenant_room_media_assets WHERE tenant_id = $1 ORDER BY id', [TENANT]);
  assert.deepEqual(remaining.rows.map((row) => row.id), [CURRENT, HISTORIC, YOUNG]);
});
