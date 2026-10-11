import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { loadDatabaseConfig } from '../src/config.js';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';
import {
  readLiveMediaInventory, assertNoOtherDatabaseSessions, assertOperatorIdentity,
} from '../scripts/support/live-media-operator-db.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const CURRENT_ASSET = '33333333-3333-4333-8333-333333333333';
const HISTORICAL_ASSET = '44444444-4444-4444-8444-444444444abc';
const CATALOGUE_ASSET = '55555555-5555-4555-8555-555555555555';
const ORPHAN_ASSET = '66666666-6666-4666-8666-666666666666';
const IMAGE = Buffer.from('synthetic sanitized operator integration image');
const DIGEST = createHash('sha256').update(IMAGE).digest('hex');

function reference(assetId, kind = 'room') {
  return mediaObjectReference({ tenantId: TENANT, assetId, kind,
    contentType: 'image/webp', byteLength: IMAGE.length, sha256: DIGEST });
}

function historicalRoom(overrides = {}) {
  return { id: 'room-inactive', floorplanAssetId: HISTORICAL_ASSET, mediaAssetIds: [], ...overrides };
}

async function insertCustody(client, input) {
  await client.query(`INSERT INTO media_object_inventory
    (object_key,tenant_id,asset_id,kind,content_type,byte_length,content_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.key, input.tenantId, input.assetId, input.kind,
    input.contentType, input.byteLength, Buffer.from(input.sha256, 'hex')]);
}

async function setHistory(client, configuration) {
  await client.query('UPDATE tenant_location_revisions SET configuration=$1::jsonb', [JSON.stringify(configuration)]);
}

async function resetFixture(client) {
  await client.query(`TRUNCATE rooms, tenant_location_revisions,
    tenant_room_media_assets, demo_catalogue_media_assets, media_object_inventory`);
  await client.query(`INSERT INTO rooms (tenant_id,id,active,details) VALUES
    ($1,'room-active',true,$2::jsonb),($1,'room-inactive',false,'{}'::jsonb)`,
  [TENANT, JSON.stringify({ floorplanAssetId: CURRENT_ASSET, mediaAssetIds: [] })]);
  await client.query(`INSERT INTO tenant_location_revisions (tenant_id,revision,configuration)
    VALUES ($1,1,$2::jsonb)`, [TENANT, JSON.stringify({ rooms: [historicalRoom()] })]);
  for (const [assetId, roomId] of [[CURRENT_ASSET, 'room-active'], [HISTORICAL_ASSET, 'room-inactive']]) {
    await client.query(`INSERT INTO tenant_room_media_assets
      (tenant_id,id,room_id,bytes,content_type,byte_length,content_sha256,object_key)
      VALUES ($1,$2,$3,$4,'image/webp',$5,$6,NULL)`,
    [TENANT, assetId, roomId, IMAGE, IMAGE.length, Buffer.from(DIGEST, 'hex')]);
  }
  const catalogue = reference(CATALOGUE_ASSET, 'catalogue');
  await client.query(`INSERT INTO demo_catalogue_media_assets
    (tenant_id,id,bytes,content_type,byte_length,content_sha256,object_key)
    VALUES ($1,$2,$3,'image/webp',$4,$5,$6)`,
  [TENANT, CATALOGUE_ASSET, IMAGE, IMAGE.length, Buffer.from(DIGEST, 'hex'), catalogue.key]);
  await insertCustody(client, catalogue);
}

function safeOperatorFailure(error) {
  assert.match(error.message, /^LIVE_[A-Z_]+$/);
  for (const value of [TENANT, FOREIGN, CURRENT_ASSET, HISTORICAL_ASSET, CATALOGUE_ASSET, DIGEST]) {
    assert.equal(error.message.includes(value), false);
  }
  return true;
}

test('Live operator inventory verifies real PostgreSQL current and historical custody without provider I/O', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const options = { connectionString: database.databaseUrl,
    ssl: database.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000, statement_timeout: 5000 };
  const client = new Client(options);
  await client.connect();
  t.after(() => client.end());

  // These isolated tables reproduce the relevant production column types, not
  // migration constraints or application authorization. Omitting those constraints
  // deliberately permits corrupt states so the actual operator SQL must reject them.
  await client.query(`
    CREATE TABLE rooms (tenant_id uuid NOT NULL,id varchar(128) NOT NULL,
      active boolean NOT NULL,details jsonb NOT NULL);
    CREATE TABLE tenant_location_revisions (tenant_id uuid NOT NULL,revision bigint NOT NULL,
      configuration jsonb NOT NULL);
    CREATE TABLE tenant_room_media_assets (tenant_id uuid NOT NULL,id uuid NOT NULL,
      room_id varchar(128) NOT NULL,bytes bytea,content_type varchar(16) NOT NULL,
      byte_length integer NOT NULL,content_sha256 bytea NOT NULL,object_key varchar(192));
    CREATE TABLE demo_catalogue_media_assets (tenant_id uuid NOT NULL,id uuid NOT NULL,
      bytes bytea,content_type varchar(16) NOT NULL,byte_length integer NOT NULL,
      content_sha256 bytea NOT NULL,object_key varchar(192));
    CREATE TABLE media_object_inventory (object_key varchar(192) PRIMARY KEY,tenant_id uuid NOT NULL,
      asset_id uuid NOT NULL,kind varchar(16) NOT NULL,content_type varchar(16) NOT NULL,
      byte_length integer NOT NULL,content_sha256 bytea NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT clock_timestamp());
  `);

  await t.test('executes the exact identity and privilege SQL but rejects this isolated test database', async () => {
    const identity = (await client.query('SELECT current_database() AS database')).rows[0];
    assert.notEqual(identity.database, 'conference_manager_demo_shared');
    await client.query(`
      CREATE TABLE schema_migrations (version integer NOT NULL);
      CREATE TABLE demo_schema_migrations (version integer NOT NULL);
      CREATE TABLE demo_database_sentinel (singleton boolean NOT NULL,sentinel_key text NOT NULL,
        runtime_schema_version integer NOT NULL,database_name text NOT NULL,
        customer_role text NOT NULL,platform_role text NOT NULL,reset_role text NOT NULL);
      INSERT INTO schema_migrations VALUES (44);
      INSERT INTO demo_schema_migrations VALUES (9);
      INSERT INTO demo_database_sentinel VALUES (true,'conference-manager-shared-demo-v1',1,current_database(),
        'cm_demo_customer','cm_demo_platform','cm_demo_reset');
    `);
    // A SQL syntax/privilege-function failure must not masquerade as this expected
    // fixed rejection. We never create a Live-named database or grant a Live role.
    await assert.rejects(assertOperatorIdentity(client, 'cm_demo_migration'), {
      message: 'LIVE_MEDIA_IDENTITY_INVALID', code: 'LIVE_MEDIA_IDENTITY_INVALID',
    });
  });

  await t.test('includes inactive historical-only Room bytes and all Catalogue metadata', async () => {
    await resetFixture(client);
    const result = await readLiveMediaInventory(client);
    assert.equal(result.room, 2);
    assert.equal(result.catalogue, 1);
    assert.equal(result.bytes, IMAGE.length * 3);
    assert.equal(result.postgresOnly, 2);
    assert.equal(result.external, 1);
    assert.equal(result.invalidPostgresBytes, 0);
    assert.equal(result.otherCustody, 0);
    assert.equal(result.references.length, 3);
    assert.deepEqual(new Set(result.references.map(({ reference: item }) => item.assetId)),
      new Set([CURRENT_ASSET, HISTORICAL_ASSET, CATALOGUE_ASSET]));
    assert.ok(result.references.every(({ hasBytes, bytesValid }) => hasBytes === true && bytesValid === true));
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal((await readLiveMediaInventory(client)).manifestSha256, result.manifestSha256);
  });

  await t.test('retains unreferenced upload custody without assuming its provider object exists', async () => {
    await resetFixture(client);
    await insertCustody(client, reference(ORPHAN_ASSET));
    const result = await readLiveMediaInventory(client);
    assert.equal(result.references.length, 3);
    assert.equal(result.otherCustody, 1);
    assert.equal((await client.query('SELECT count(*)::integer AS count FROM media_object_inventory')).rows[0].count, 2);
  });

  await t.test('current empty details is valid and historical-only bytes still remain required', async () => {
    await resetFixture(client);
    await client.query("UPDATE rooms SET details='{}'::jsonb");
    assert.equal((await readLiveMediaInventory(client)).room, 2);
    await client.query('DELETE FROM tenant_room_media_assets WHERE id=$1', [HISTORICAL_ASSET]);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('checks an old historical reference even when the latest revision no longer names it', async () => {
    await resetFixture(client);
    await client.query(`INSERT INTO tenant_location_revisions (tenant_id,revision,configuration)
      VALUES ($1,2,$2::jsonb)`, [TENANT, JSON.stringify({ rooms: [historicalRoom({ floorplanAssetId: null })] })]);
    await client.query('DELETE FROM tenant_room_media_assets WHERE id=$1', [HISTORICAL_ASSET]);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('joins a valid uppercase historical UUID to its canonical PostgreSQL identity', async () => {
    await resetFixture(client);
    await setHistory(client, { rooms: [historicalRoom({ floorplanAssetId: HISTORICAL_ASSET.toUpperCase() })] });
    assert.equal((await readLiveMediaInventory(client)).room, 2);
  });

  for (const [name, update, values] of [
    ['missing current image', 'DELETE FROM tenant_room_media_assets WHERE id=$1', [CURRENT_ASSET]],
    ['same-tenant wrong historical Room owner', 'UPDATE tenant_room_media_assets SET room_id=$1 WHERE id=$2',
      ['room-active', HISTORICAL_ASSET]],
    ['foreign-tenant historical image', 'UPDATE tenant_room_media_assets SET tenant_id=$1 WHERE id=$2',
      [FOREIGN, HISTORICAL_ASSET]],
  ]) {
    await t.test(`rejects ${name}`, async () => {
      await resetFixture(client);
      await client.query(update, values);
      await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
      // A rejected snapshot must roll back; the connection remains usable.
      assert.equal((await client.query('SELECT 1 AS ready')).rows[0].ready, 1);
    });
  }

  for (const [name, configuration] of [
    ['non-object history', []], ['missing history rooms', {}], ['null history rooms', { rooms: null }],
    ['object instead of history rooms array', { rooms: {} }],
    ['scalar historical room', { rooms: [17] }],
    ['historical room without asset fields', { rooms: [{ id: 'room-inactive' }] }],
    ['scalar media list', { rooms: [historicalRoom({ mediaAssetIds: HISTORICAL_ASSET })] }],
    ['scalar media member', { rooms: [historicalRoom({ mediaAssetIds: [17] })] }],
    ['malformed image identifier', { rooms: [historicalRoom({ floorplanAssetId: 'unsafe-fixture-value' })] }],
    ['duplicate media member', { rooms: [historicalRoom({ mediaAssetIds: [HISTORICAL_ASSET, HISTORICAL_ASSET] })] }],
    ['excessive media list', { rooms: [historicalRoom({ mediaAssetIds: Array(21).fill(HISTORICAL_ASSET) })] }],
  ]) {
    await t.test(`rejects ${name}`, async () => {
      await resetFixture(client);
      await setHistory(client, configuration);
      await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
    });
  }

  await t.test('rejects malformed current details instead of treating them as empty history', async () => {
    await resetFixture(client);
    await client.query("UPDATE rooms SET details='[]'::jsonb WHERE id='room-active'");
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
    await resetFixture(client);
    await client.query('UPDATE rooms SET details=$1::jsonb WHERE id=$2',
      [JSON.stringify({ mediaAssetIds: CURRENT_ASSET }), 'room-active']);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('flags corrupt retained PostgreSQL bytes without confusing matching length with integrity', async () => {
    await resetFixture(client);
    await client.query('UPDATE tenant_room_media_assets SET bytes=$1 WHERE id=$2',
      [Buffer.alloc(IMAGE.length, 120), HISTORICAL_ASSET]);
    const result = await readLiveMediaInventory(client);
    assert.equal(result.invalidPostgresBytes, 1);
    assert.equal(result.references.find(({ reference: item }) => item.assetId === HISTORICAL_ASSET).bytesValid, false);
  });

  await t.test('permits object-only current revisions but still requires matching durable custody', async () => {
    await resetFixture(client);
    await client.query('UPDATE demo_catalogue_media_assets SET bytes=NULL');
    const result = await readLiveMediaInventory(client);
    const current = result.references.find(({ reference: item }) => item.assetId === CATALOGUE_ASSET);
    assert.equal(current.hasBytes, false);
    assert.equal(result.invalidPostgresBytes, 0);
    await client.query('DELETE FROM media_object_inventory');
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('rejects foreign custody and metadata mismatch for a published object pointer', async () => {
    await resetFixture(client);
    await client.query('UPDATE media_object_inventory SET tenant_id=$1', [FOREIGN]);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
    await resetFixture(client);
    await client.query('UPDATE media_object_inventory SET byte_length=byte_length+1');
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('rejects a published pointer that does not match its own content-addressed revision', async () => {
    await resetFixture(client);
    await client.query('UPDATE demo_catalogue_media_assets SET object_key=$1',
      [reference(ORPHAN_ASSET, 'catalogue').key]);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('rejects excess asset inventory instead of accepting its first bounded page', async () => {
    await resetFixture(client);
    await client.query(`INSERT INTO tenant_room_media_assets
      (tenant_id,id,room_id,bytes,content_type,byte_length,content_sha256,object_key)
      SELECT $1,('77777777-7777-4777-8777-' || lpad(sequence::text,12,'0'))::uuid,
        'room-inactive',$2,'image/webp',$3,$4,NULL FROM generate_series(1,1001) AS entries(sequence)`,
    [TENANT, IMAGE, IMAGE.length, Buffer.from(DIGEST, 'hex')]);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('rejects excess current Room documents instead of accepting truncated reference evidence', async () => {
    await resetFixture(client);
    await client.query(`INSERT INTO rooms (tenant_id,id,active,details)
      SELECT $1,'bounded-room-' || sequence::text,false,'{}'::jsonb
      FROM generate_series(1,20001) AS entries(sequence)`, [TENANT]);
    await assert.rejects(readLiveMediaInventory(client), safeOperatorFailure);
  });

  await t.test('rejects an idle second database session and one idle inside a transaction', async () => {
    await resetFixture(client);
    await assertNoOtherDatabaseSessions(client);
    const other = new Client(options);
    await other.connect();
    try {
      await assert.rejects(assertNoOtherDatabaseSessions(client), safeOperatorFailure);
      await other.query('BEGIN');
      await assert.rejects(assertNoOtherDatabaseSessions(client), safeOperatorFailure);
      await other.query('ROLLBACK');
    } finally { await other.end(); }
    await assertNoOtherDatabaseSessions(client);
  });
});
