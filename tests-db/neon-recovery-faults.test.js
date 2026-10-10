import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.js';
import { mediaObjectReference, MediaObjectStorageError } from '../src/media/object-storage-contract.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { createPostgresMediaBackfillRepository } from '../src/persistence/postgres/media-backfill-repository.js';
import { readRecoveryAuthoritativeState, verifyFailedRecoveryRollback } from '../scripts/support/neon-recovery-scenarios.mjs';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

const MEDIA_TABLES = Object.freeze({ room: 'tenant_room_media_assets', catalogue: 'demo_catalogue_media_assets' });
const STATE_TABLES = Object.freeze({
  tenant_room_media_assets: 'tenant_id, id', demo_catalogue_media_assets: 'tenant_id, id',
  media_object_inventory: 'object_key', rooms: 'tenant_id, id', sites: 'tenant_id, id', tenants: 'id',
  tenant_location_revisions: 'tenant_id, revision', catering_items: 'tenant_id, id',
  catering_packages: 'tenant_id, id', tenant_catalogue_revisions: 'tenant_id, revision',
});
const FIXTURES = Object.freeze([
  { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
    room: '00000000-0000-4000-8000-00000000a001', historical: '00000000-0000-4000-8000-00000000a002',
    catalogue: '00000000-0000-4000-8000-00000000a003' },
  { tenantId: '55555555-5555-4555-8555-555555555555', userId: '66666666-6666-4666-8666-666666666666',
    room: '00000000-0000-4000-8000-00000000b001', catalogue: '00000000-0000-4000-8000-00000000b003' },
]);

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) throw new Error('RECOVERY_FAULT_TEST_IDENTIFIER_INVALID');
  return `"${value}"`;
}

function fingerprints(rows) {
  return Object.fromEntries(Object.entries(rows).map(([table, values]) => [table,
    createHash('sha256').update(JSON.stringify(values)).digest('hex')]));
}

test('controlled object faults preserve real PostgreSQL custody on one-asset recovery rollback', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const url = new URL(database.databaseUrl);
  // The runner owns this fresh loopback database; this test never contacts a provider.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/conference_manager_test_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('RECOVERY_FAULT_TEST_DATABASE_INVALID');
  }
  const pool = createPostgresPool({ mode: 'test', ...database });
  const roles = Object.fromEntries(['customer', 'platform', 'reset'].map((surface) => [surface,
    `cm_recovery_fault_${surface}_${process.pid}`]));
  const createdRoles = [];
  t.after(async () => {
    try {
      for (const role of createdRoles.reverse()) {
        await pool.query(`DROP OWNED BY ${identifier(role)}`);
        await pool.query(`DROP ROLE ${identifier(role)}`);
      }
    } finally { await pool.end(); }
  });
  await migrateUp(pool);
  for (const role of Object.values(roles)) {
    await pool.query(`CREATE ROLE ${identifier(role)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(role);
  }
  await migrateDemoUp(pool, { roles });

  const objects = new Map();
  const reads = [];
  const records = [];
  const storage = {
    async put(reference, bytes) { objects.set(reference.key, Buffer.from(bytes)); return reference.key; },
    async get(reference) {
      reads.push(reference.key);
      if (!objects.has(reference.key)) throw new MediaObjectStorageError('MEDIA_STORAGE_OBJECT_MISSING');
      return Buffer.from(objects.get(reference.key));
    },
    async remove() { assert.fail('Backfill and rollback must preserve object custody.'); },
  };
  const mediaObjects = createPostgresMediaObjectRepository(pool, { storage, includeDemoCatalogue: true });
  const repository = createPostgresMediaBackfillRepository(pool, { mediaObjects, includeDemoCatalogue: true });

  async function addMedia(fixture, kind, assetId) {
    const bytes = Buffer.from(`controlled sanitized ${kind} fixture bytes for ${fixture.tenantId}/${assetId}`);
    const digest = createHash('sha256').update(bytes).digest();
    const reference = mediaObjectReference({ tenantId: fixture.tenantId, assetId, kind,
      contentType: 'image/webp', byteLength: bytes.length, sha256: digest.toString('hex') });
    await mediaObjects.register(reference);
    await storage.put(reference, bytes);
    if (kind === 'room') {
      await pool.query(`INSERT INTO public.tenant_room_media_assets
        (tenant_id,id,room_id,bytes,byte_length,width,height,content_sha256,created_by_user_id,object_key)
        VALUES ($1,$2,'room',NULL,$3,1,1,$4,$5,$6)`,
      [fixture.tenantId, assetId, bytes.length, digest, fixture.userId, reference.key]);
    } else {
      await pool.query(`INSERT INTO public.demo_catalogue_media_assets
        (tenant_id,id,owner_kind,owner_id,bytes,content_type,byte_length,content_sha256,alt_text,
         created_at,created_by_user_id,object_key)
        VALUES ($1,$2,'catering_item','item',NULL,'image/webp',$3,$4,'Controlled recovery fixture',
         clock_timestamp(),$5,$6)`,
      [fixture.tenantId, assetId, bytes.length, digest, fixture.userId, reference.key]);
    }
    records.push({ reference, bytes });
  }

  // Reverse insertion order so the operator's actual tenant/id ordering selects the fault target.
  for (const fixture of [...FIXTURES].reverse()) {
    const { tenantId, userId } = fixture;
    await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Recovery Tenant','active')", [tenantId]);
    await pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,'Manager')", [tenantId, userId]);
    await pool.query("INSERT INTO sites (tenant_id,id,name) VALUES ($1,'site','Site')", [tenantId]);
    await pool.query(`INSERT INTO rooms (tenant_id,id,site_id,name,capacity,details)
      VALUES ($1,'room','site','Room',10,$2::jsonb)`,
    [tenantId, JSON.stringify({ mediaAssetIds: [fixture.room] })]);
    await pool.query("INSERT INTO catering_items (tenant_id,id,name) VALUES ($1,'item','Item')", [tenantId]);
    await pool.query("INSERT INTO catering_packages (tenant_id,id,name) VALUES ($1,'package','Package')", [tenantId]);
    await pool.query(`INSERT INTO tenant_location_revisions
      (tenant_id,revision,configuration,changed_at,actor_user_id)
      VALUES ($1,1,$2::jsonb,clock_timestamp(),$3)`,
    [tenantId, JSON.stringify({ rooms: [{ id: 'room', mediaAssetIds: [fixture.historical || fixture.room] }] }), userId]);
    await addMedia(fixture, 'catalogue', fixture.catalogue);
    if (fixture.historical) await addMedia(fixture, 'room', fixture.historical);
    await addMedia(fixture, 'room', fixture.room);
  }

  async function readRows() {
    const rows = {};
    for (const [table, order] of Object.entries(STATE_TABLES)) {
      rows[table] = (await pool.query(`SELECT * FROM public.${table} ORDER BY ${order}`)).rows;
    }
    return rows;
  }
  async function authoritativeState() {
    const client = await pool.connect();
    try { return await readRecoveryAuthoritativeState(client); }
    finally { client.release(); }
  }
  async function failedRollback(reference, expectedCode) {
    const client = await pool.connect();
    try {
      return await verifyFailedRecoveryRollback({ client, repository, reference, expectedCode, assertActive() {} });
    } finally { client.release(); }
  }
  const initialRows = await readRows();
  assert.equal(initialRows.tenant_room_media_assets.length, 3);
  assert.equal(initialRows.demo_catalogue_media_assets.length, 2);
  assert.equal(initialRows.media_object_inventory.length, 5);
  assert.equal(initialRows.tenant_location_revisions.length, 2);
  const initialState = await authoritativeState();
  assert.match(initialState.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(initialState.rowCounts,
    Object.fromEntries(Object.entries(initialRows).map(([table, rows]) => [table, rows.length])));

  await t.test('a later fault target is rejected before any provider read or rollback', async () => {
    for (const kind of ['room', 'catalogue']) {
      const later = records.find(({ reference }) => reference.kind === kind && reference.tenantId === FIXTURES[1].tenantId);
      reads.length = 0;
      await assert.rejects(failedRollback(later.reference, 'MEDIA_STORAGE_OBJECT_MISSING'),
        { message: 'NEON_RECOVERY_FIRST_CANDIDATE_INVALID' });
      assert.deepEqual(reads, []);
      assert.deepEqual(await authoritativeState(), initialState);
      assert.deepEqual(await readRows(), initialRows);
    }
  });

  for (const kind of ['room', 'catalogue']) {
    for (const fault of ['missing', 'corrupt']) {
      await t.test(`${kind}: ${fault} first object fails reads and one-asset rollback without database mutation`, async () => {
        const table = MEDIA_TABLES[kind];
        const first = (await pool.query(`SELECT tenant_id,id,object_key FROM public.${table}
          WHERE object_key IS NOT NULL ORDER BY tenant_id,id LIMIT 1`)).rows[0];
        assert.equal(first.tenant_id, FIXTURES[0].tenantId);
        assert.equal(first.id, FIXTURES[0][kind]);
        const target = records.find(({ reference }) => reference.key === first.object_key);
        assert.ok(target);
        const { reference, bytes } = target;
        // Missing must fail even with a retained copy; corrupt also covers object-only revisions.
        await pool.query(`UPDATE public.${table} SET bytes = $3 WHERE tenant_id = $1 AND id = $2`,
          [reference.tenantId, reference.assetId, fault === 'missing' ? bytes : null]);
        const beforeRows = await readRows();
        const beforeFingerprints = fingerprints(beforeRows);
        const beforeState = await authoritativeState();
        const beforeObjects = new Map([...objects].map(([key, value]) => [key, Buffer.from(value)]));
        const code = fault === 'missing' ? 'MEDIA_STORAGE_OBJECT_MISSING' : 'MEDIA_STORAGE_INTEGRITY_FAILED';
        try {
          if (fault === 'missing') objects.delete(reference.key);
          else {
            const corrupted = Buffer.from(bytes);
            corrupted[corrupted.length - 1] ^= 1; // Same length: the digest check must detect it.
            objects.set(reference.key, corrupted);
          }
          reads.length = 0;
          await assert.rejects(mediaObjects.read(reference, reference.key), { code });
          assert.deepEqual(reads, [reference.key]);
          reads.length = 0;
          // Only this first candidate is selected. This does not claim whole-batch atomicity.
          const proof = await failedRollback(reference, code);
          assert.equal(proof.limit, 1);
          assert.equal(proof.code, code);
          assert.equal(proof.authoritativeStateUnchanged, true);
          assert.deepEqual(proof.before, beforeState);
          assert.deepEqual(proof.after, beforeState);
          assert.deepEqual(reads, [reference.key]);
          const afterRows = await readRows();
          assert.deepEqual(afterRows, beforeRows);
          assert.deepEqual(fingerprints(afterRows), beforeFingerprints);
          assert.deepEqual(await authoritativeState(), beforeState);
        } finally { objects.set(reference.key, Buffer.from(bytes)); }

        assert.deepEqual(objects, beforeObjects);
        assert.deepEqual(await mediaObjects.read(reference, reference.key), bytes);
        reads.length = 0;
        const rollback = await repository.runBatch({ phase: 'rollback', kind, limit: 1 });
        assert.deepEqual(rollback, { phase: 'rollback', kind, inspected: 1, changed: 1,
          byteLength: bytes.length, hasMore: true });
        assert.deepEqual(reads, [reference.key]);
        const expectedRows = {};
        for (const [name, rows] of Object.entries(beforeRows)) {
          expectedRows[name] = rows.map((row) => name === table && row.tenant_id === reference.tenantId
            && row.id === reference.assetId ? { ...row, bytes: Buffer.from(bytes), object_key: null } : row);
        }
        assert.deepEqual(await readRows(), expectedRows);
        const rolledBackState = await authoritativeState();
        assert.notEqual(rolledBackState.sha256, beforeState.sha256);
        assert.deepEqual(rolledBackState.rowCounts, beforeState.rowCounts);
        assert.deepEqual(objects, beforeObjects);
        const copied = await repository.runBatch({ phase: 'copy', kind, limit: 1 });
        assert.equal(copied.changed, 1);
        assert.equal(copied.inspected, 1);
        assert.deepEqual(await mediaObjects.read(reference, reference.key), bytes);
        assert.deepEqual(objects, beforeObjects);
      });
    }
  }

  await t.test('the authoritative fingerprint detects same-length database-byte and Room-reference changes', async () => {
    const fixture = FIXTURES[0];
    const beforeRows = await readRows();
    const before = await authoritativeState();
    const row = beforeRows.tenant_room_media_assets.find((asset) => asset.tenant_id === fixture.tenantId && asset.id === fixture.room);
    const damaged = Buffer.from(row.bytes);
    damaged[0] ^= 1;
    try {
      await pool.query('UPDATE public.tenant_room_media_assets SET bytes = $3 WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, fixture.room, damaged]);
      const afterBytes = await authoritativeState();
      assert.notEqual(afterBytes.sha256, before.sha256);
      assert.deepEqual(afterBytes.rowCounts, before.rowCounts);
    } finally {
      await pool.query('UPDATE public.tenant_room_media_assets SET bytes = $3 WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, fixture.room, row.bytes]);
    }
    assert.deepEqual(await authoritativeState(), before);
    const room = beforeRows.rooms.find(({ tenant_id: tenantId }) => tenantId === fixture.tenantId);
    try {
      await pool.query("UPDATE public.rooms SET details = '{\"mediaAssetIds\":[]}'::jsonb WHERE tenant_id = $1 AND id = 'room'",
        [fixture.tenantId]);
      const afterReference = await authoritativeState();
      assert.notEqual(afterReference.sha256, before.sha256);
      assert.deepEqual(afterReference.rowCounts, before.rowCounts);
    } finally {
      await pool.query("UPDATE public.rooms SET details = $2::jsonb WHERE tenant_id = $1 AND id = 'room'",
        [fixture.tenantId, JSON.stringify(room.details)]);
    }
    assert.deepEqual(await authoritativeState(), before);
    assert.deepEqual(await readRows(), beforeRows);
  });
});
