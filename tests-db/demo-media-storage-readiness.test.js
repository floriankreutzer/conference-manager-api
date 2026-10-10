import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadDatabaseConfig } from '../src/config.js';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { assertDemoMediaStorageReady } from '../src/persistence/postgres/demo-media-storage-readiness.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

const TABLES = Object.freeze({ room: 'tenant_room_media_assets', catalogue: 'demo_catalogue_media_assets' });
const FIXTURES = Object.freeze([
  { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
    room: '33333333-3333-4333-8333-333333333333', catalogue: '44444444-4444-4444-8444-444444444444' },
  { tenantId: '55555555-5555-4555-8555-555555555555', userId: '66666666-6666-4666-8666-666666666666',
    room: '77777777-7777-4777-8777-777777777777', catalogue: '88888888-8888-4888-8888-888888888888' },
]);
const bytes = Buffer.from('already sanitized image bytes for the read-only readiness fixture');
const digest = createHash('sha256').update(bytes).digest();

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) throw new Error('MEDIA_READINESS_TEST_IDENTIFIER_INVALID');
  return `"${value}"`;
}

test('storage startup readiness validates real identities and mixed media state without writing', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const url = new URL(database.databaseUrl);
  // Role creation is confined to the isolated loopback DB test runner; never reuse existing resources.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/conference_manager_test_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('MEDIA_READINESS_TEST_DATABASE_INVALID');
  }
  const databaseName = `conference_manager_demo_storage_${process.pid}`;
  const roles = Object.fromEntries(['customer', 'platform', 'reset'].map((surface) => [surface,
    `cm_media_readiness_${surface}_${process.pid}`]));
  const createdRoles = [];
  const admin = createPostgresPool({ mode: 'test', ...database });
  let databaseCreated = false;
  let pool;
  let scoped;
  t.after(async () => {
    try {
      try {
        if (scoped) {
          try { await scoped.query('ROLLBACK'); await scoped.query('RESET ROLE'); }
          finally { scoped.release(); }
        }
      } finally { await pool?.end(); }
    } finally {
      try {
        if (databaseCreated) await admin.query(`DROP DATABASE ${identifier(databaseName)} WITH (FORCE)`);
        for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${identifier(role)}`);
      } finally { await admin.end(); }
    }
  });
  for (const role of Object.values(roles)) {
    await admin.query(`CREATE ROLE ${identifier(role)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE ${identifier(databaseName)}`);
  databaseCreated = true;
  url.pathname = `/${databaseName}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString(), databasePoolMax: 2 });
  await migrateUp(pool);
  await migrateDemoUp(pool, { roles });
  scoped = await pool.connect();
  const reader = { query: (query, values) => scoped.query(query, values) };

  async function check(role, mode, expected = {}) {
    await scoped.query(`SET ROLE ${identifier(role)}`);
    await scoped.query('BEGIN READ ONLY');
    try {
      await assertDemoMediaStorageReady(reader, { mode, expectedDatabaseName: databaseName,
        expectedRole: role, ...expected });
      const transaction = await scoped.query('SHOW transaction_read_only');
      assert.equal(transaction.rows[0].transaction_read_only, 'on');
    } finally {
      await scoped.query('ROLLBACK');
      await scoped.query('RESET ROLE');
    }
  }
  async function snapshot() {
    const room = await pool.query('SELECT * FROM tenant_room_media_assets ORDER BY tenant_id, id');
    const catalogue = await pool.query('SELECT * FROM demo_catalogue_media_assets ORDER BY tenant_id, id');
    const inventory = await pool.query('SELECT * FROM media_object_inventory ORDER BY object_key');
    return { room: room.rows, catalogue: catalogue.rows, inventory: inventory.rows };
  }
  async function expectMode(mode, ready) {
    const before = await snapshot();
    for (const role of [roles.customer, roles.reset]) {
      if (ready) await check(role, mode);
      else await assert.rejects(check(role, mode), { message: 'DEMO_MEDIA_STORAGE_MODE_MISMATCH' });
    }
    assert.deepEqual(await snapshot(), before);
  }
  async function setPointers(kind, external, fixtures = FIXTURES) {
    for (const fixture of fixtures) {
      const reference = mediaObjectReference({ tenantId: fixture.tenantId, assetId: fixture[kind], kind,
        contentType: 'image/webp', byteLength: bytes.length, sha256: digest.toString('hex') });
      await pool.query(`UPDATE ${TABLES[kind]} SET bytes = $1, object_key = $2 WHERE tenant_id = $3 AND id = $4`,
        [bytes, external ? reference.key : null, fixture.tenantId, fixture[kind]]);
    }
  }

  await t.test('an empty migrated media store is consistent in either mode', async () => {
    await expectMode('postgres', true);
    await expectMode('neon', true);
  });
  for (const fixture of FIXTURES) {
    const { tenantId, userId } = fixture;
    await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Readiness Tenant','active')", [tenantId]);
    await pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,'Manager')", [tenantId, userId]);
    await pool.query("INSERT INTO sites (tenant_id,id,name) VALUES ($1,'site','Site')", [tenantId]);
    await pool.query("INSERT INTO rooms (tenant_id,id,site_id,name,capacity) VALUES ($1,'room','site','Room',10)", [tenantId]);
    await pool.query("INSERT INTO catering_items (tenant_id,id,name,price_minor,active) VALUES ($1,'item','Item',100,true)",
      [tenantId]);
    await pool.query(`INSERT INTO tenant_room_media_assets
      (tenant_id,id,room_id,bytes,byte_length,width,height,content_sha256,created_by_user_id)
      VALUES ($1,$2,'room',$3,$4,1,1,$5,$6)`, [tenantId, fixture.room, bytes, bytes.length, digest, userId]);
    await pool.query(`INSERT INTO demo_catalogue_media_assets
      (tenant_id,id,owner_kind,owner_id,bytes,content_type,byte_length,content_sha256,alt_text,created_at,created_by_user_id)
      VALUES ($1,$2,'catering_item','item',$3,'image/webp',$4,$5,'Readiness fixture',clock_timestamp(),$6)`,
    [tenantId, fixture.catalogue, bytes, bytes.length, digest, userId]);
    for (const kind of Object.keys(TABLES)) {
      const reference = mediaObjectReference({ tenantId, assetId: fixture[kind], kind,
        contentType: 'image/webp', byteLength: bytes.length, sha256: digest.toString('hex') });
      await pool.query(`INSERT INTO media_object_inventory
        (object_key,tenant_id,asset_id,kind,content_type,byte_length,content_sha256)
        VALUES ($1,$2,$3,$4,'image/webp',$5,$6)`,
      [reference.key, tenantId, fixture[kind], kind, bytes.length, digest]);
    }
  }

  await t.test('PostgreSQL startup rejects even one external Room or Catalogue pointer in another Tenant', async () => {
    await expectMode('postgres', true);
    await expectMode('neon', false);
    for (const kind of Object.keys(TABLES)) {
      await setPointers(kind, true, [FIXTURES[1]]);
      await expectMode('postgres', false);
      await expectMode('neon', false);
      await setPointers(kind, false, [FIXTURES[1]]);
    }
    await expectMode('postgres', true);
  });

  await t.test('Neon startup requires every Room and Catalogue pointer, with or without retained database bytes', async () => {
    for (const kind of Object.keys(TABLES)) await setPointers(kind, true);
    await expectMode('neon', true);
    await expectMode('postgres', false);
    for (const kind of Object.keys(TABLES)) {
      await setPointers(kind, false, [FIXTURES[1]]);
      await expectMode('neon', false);
      await expectMode('postgres', false);
      await setPointers(kind, true, [FIXTURES[1]]);
    }
    await pool.query('UPDATE tenant_room_media_assets SET bytes = NULL');
    await pool.query('UPDATE demo_catalogue_media_assets SET bytes = NULL');
    await expectMode('neon', true);
    await expectMode('postgres', false);
  });

  await t.test('wrong live principal or database fails safely and ordinary Platform gains no media authority', async () => {
    const before = await snapshot();
    await assert.rejects(check(roles.customer, 'neon', { expectedRole: roles.reset }),
      { message: 'DEMO_MEDIA_STORAGE_IDENTITY_INVALID' });
    await assert.rejects(check(roles.customer, 'neon', { expectedDatabaseName: `${databaseName}_other` }),
      { message: 'DEMO_MEDIA_STORAGE_IDENTITY_INVALID' });
    // Platform cannot read media: its wrong identity must be rejected before those denied queries.
    await assert.rejects(check(roles.platform, 'neon', { expectedRole: roles.customer }),
      { message: 'DEMO_MEDIA_STORAGE_IDENTITY_INVALID' });
    await assert.rejects(check(roles.platform, 'neon'), { message: 'DEMO_MEDIA_STORAGE_READINESS_FAILED' });
    const privileges = await pool.query(`SELECT
      has_table_privilege($1::name, 'public.tenant_room_media_assets', 'SELECT') AS room,
      has_table_privilege($1::name, 'public.demo_catalogue_media_assets', 'SELECT') AS catalogue,
      has_table_privilege($1::name, 'public.media_object_inventory', 'SELECT') AS inventory`, [roles.platform]);
    assert.deepEqual(privileges.rows, [{ room: false, catalogue: false, inventory: false }]);
    assert.deepEqual(await snapshot(), before);
  });
});
