import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresRoomMediaRepository } from '../src/persistence/postgres/room-media-repository.js';
import { createPostgresTenantLocationRepository } from '../src/persistence/postgres/tenant-location-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_ID = '81818181-8181-4818-8818-818181818181';
const USER_ID = '82828282-8282-4828-8828-828282828282';

function config() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('a runtime role without media UPDATE can attach uploaded bytes through Locations', async (t) => {
  const pool = createPostgresPool(config());
  const role = `cm_media_attach_${process.pid}`;
  t.after(async () => {
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
    await pool.end();
  });
  await migrateUp(pool);
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await pool.query(`REVOKE UPDATE, DELETE ON tenant_room_media_assets FROM ${role}`);
  const privileges = await pool.query(`SELECT
    has_table_privilege($1, 'tenant_room_media_assets', 'SELECT') AS can_read,
    has_table_privilege($1, 'tenant_room_media_assets', 'UPDATE') AS can_update`, [role]);
  assert.deepEqual(privileges.rows[0], { can_read: true, can_update: false });

  await pool.query("INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Media Tenant', 'active')", [TENANT_ID]);
  await pool.query('INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [TENANT_ID, USER_ID, 'Manager']);
  await pool.query("INSERT INTO sites (tenant_id, id, name, time_zone) VALUES ($1, 'site', 'Site', 'Europe/Berlin')",
    [TENANT_ID]);
  await pool.query("INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, 'room', 'site', 'Room', 10)",
    [TENANT_ID]);

  const auditRepository = { async appendWithClient() { return true; } };
  const media = createPostgresRoomMediaRepository(pool, { auditRepository });
  const image = await sharp({ create: {
    width: 32, height: 32, channels: 3, background: '#456789',
  } }).webp().toBuffer();
  const uploaded = await media.create({
    tenantId: TENANT_ID, roomId: 'room', actorUserId: USER_ID,
    image: { bytes: image, width: 32, height: 32, contentType: 'image/webp' },
    auditEvent: () => ({}),
  });
  const asset = { tenantId: TENANT_ID, roomId: 'room', assetId: uploaded.assetId, includeInactive: false };
  assert.equal(await media.findAttached(asset), null);

  const limitedPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
      } catch (error) {
        client.release(true);
        throw error;
      }
      return {
        query: client.query.bind(client),
        release() { client.release(true); }, // Never return a changed session role to the pool.
      };
    },
  };
  const locations = createPostgresTenantLocationRepository(limitedPool, { auditRepository });
  const before = await locations.current(TENANT_ID);
  assert.equal(before.revision, 1);
  const proposed = {
    ...before.configuration,
    rooms: before.configuration.rooms.map((room) => ({
      ...room, mediaAssetIds: [uploaded.assetId],
    })),
  };
  const result = await locations.update({
    tenantId: TENANT_ID, expectedRevision: 1, nextRevision: 2,
    configuration: proposed, changedAt: new Date('2030-01-01T00:00:00.000Z'),
    actorUserId: USER_ID, auditEvent: {}, assertAuthorizedTransition: () => true,
  });
  assert.equal(result.revision, 2);
  assert.deepEqual(result.configuration.rooms[0].mediaAssetIds, [uploaded.assetId]);
  assert.deepEqual((await media.findAttached(asset)).bytes, image);
});
