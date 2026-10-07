import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { readDemoSemanticState } from '../src/persistence/postgres/demo-fixture-state.js';
import { createPostgresRoomMediaRepository } from '../src/persistence/postgres/room-media-repository.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM, semanticChecksum } from '../src/demo/fixture.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

test('two external-object reset cycles preserve all three canonical customers, checksums and durable orphan custody', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const databaseName = `conference_manager_demo_objects_${process.pid}`;
  const roles = Object.fromEntries(['customer', 'platform', 'reset'].map((surface) => [surface,
    `cm_object_seed_${surface}_${process.pid}`]));
  let pool;
  let scoped;
  t.after(async () => {
    try {
      if (scoped) { await scoped.query('RESET ROLE'); scoped.release(); }
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
  const url = new URL(database.databaseUrl);
  url.pathname = `/${databaseName}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString() });
  await migrateUp(pool);
  await migrateDemoUp(pool, { roles });
  scoped = await pool.connect();
  await scoped.query(`SET ROLE "${roles.reset}"`);
  const client = { query: (query) => scoped.query(query), release() {} };
  const resetPool = { query: client.query, async connect() { return client; } };
  const objects = new Map();
  const calls = [];
  let corrupt = false;
  const storage = {
    async put(ref, bytes) { calls.push(['put', ref.key]); objects.set(ref.key, Buffer.from(bytes)); return ref.key; },
    async get(ref) { calls.push(['get', ref.key]); return corrupt ? Buffer.from('corrupt') : objects.get(ref.key); },
    async remove(ref) { calls.push(['remove', ref.key]); objects.delete(ref.key); },
  };
  const mediaObjects = createPostgresMediaObjectRepository(resetPool, { storage, includeDemoCatalogue: true });
  const repository = createPostgresDemoResetRepository({ pool: resetPool, mediaObjects,
    expectedDatabaseName: databaseName, expectedResetRole: roles.reset });
  const input = { fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM };
  for (let cycle = 0; cycle < 2; cycle += 1) {
    assert.deepEqual(await repository.reset(input), { seedVersion: DEMO_FIXTURE.seedVersion, checksum: DEMO_FIXTURE_CHECKSUM });
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tenants')).rows[0].count, 3);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM rooms')).rows[0].count, 12);
    const roomBlobs = await pool.query('SELECT count(*)::integer AS count FROM tenant_room_media_assets WHERE bytes IS NULL');
    assert.equal(roomBlobs.rows[0].count, 11);
    const catalogueBlobs = await pool.query('SELECT count(*)::integer AS count FROM demo_catalogue_media_assets WHERE bytes IS NULL');
    assert.equal(catalogueBlobs.rows[0].count, 23);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 34);
    assert.equal(objects.size, 34);
  }
  const stateBefore = await readDemoSemanticState({ client, mediaObjects });
  assert.deepEqual(stateBefore.tenants.map(({ displayName }) => displayName).sort(),
    DEMO_FIXTURE.tenants.map(({ displayName }) => displayName).sort());
  const orphanBytes = Buffer.from('verified orphan from a failed publication');
  await mediaObjects.register({ tenantId: DEMO_FIXTURE.tenants[0].id,
    assetId: '99999999-9999-4999-8999-999999999999', kind: 'room', contentType: 'image/webp',
    byteLength: orphanBytes.length, sha256: createHash('sha256').update(orphanBytes).digest('hex') });
  corrupt = true;
  await assert.rejects(repository.reset(input), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  corrupt = false;
  assert.equal(semanticChecksum(await readDemoSemanticState({ client, mediaObjects })), semanticChecksum(stateBefore));
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 35);
  const northwind = DEMO_FIXTURE.tenants[0];
  const media = northwind.roomMedia[0];
  const beforeForeign = calls.length;
  const roomRepository = createPostgresRoomMediaRepository(resetPool, { mediaObjects,
    auditRepository: { async appendWithClient() {} } });
  assert.equal(await roomRepository.findAttached({ tenantId: DEMO_FIXTURE.tenants[1].id,
    roomId: media.roomId, assetId: media.id, includeInactive: true }), null);
  assert.equal(calls.length, beforeForeign);
  assert.equal(calls.some(([action]) => action === 'remove'), false);
  objects.delete(`v1/${northwind.id}/room/${media.id}/${media.sha256}`);
  await assert.rejects(readDemoSemanticState({ client, mediaObjects }), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
});
