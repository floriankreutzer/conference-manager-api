import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { normalizeSiteGuestInformation } from '../src/domain/site-guest-information.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';
import { clearSaas3TestState } from './support/saas3-test-state.js';

const TENANT_ID = '37373737-3737-4373-8373-373737373737';
const ADMIN_ID = '38383838-3838-4383-8383-383838383838';
const SITE_ID = 'guest-migration-site';
const GUEST_INFORMATION = normalizeSiteGuestInformation({
  address: null,
  publicTransport: null,
  arrival: 'Register at the visitor reception.',
  parking: null,
  reception: null,
  building: null,
  visitorNotes: null,
  accessibility: null,
  wifiPolicy: 'not_available',
  wifiNetworkName: null,
  contact: null,
  routeUrl: null,
});

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function deleteHistory(pool) {
  await pool.query('ALTER TABLE tenant_location_revisions DISABLE TRIGGER USER');
  try {
    await pool.query('DELETE FROM tenant_location_revisions WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    await pool.query('ALTER TABLE tenant_location_revisions ENABLE TRIGGER USER');
  }
}

async function clean(pool) {
  await deleteHistory(pool);
  await pool.query('DELETE FROM sites WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function insertHistory(client, revision, guestInformation) {
  return client.query({
    text: `
      INSERT INTO tenant_location_revisions (
        tenant_id, revision, configuration, changed_at, actor_user_id, guest_information
      ) VALUES ($1, $2, '{"sites": [], "rooms": []}'::jsonb, $3, $4, $5::jsonb)
    `,
    values: [TENANT_ID, revision, new Date('2030-09-12T12:00:00.000Z'), ADMIN_ID, guestInformation],
  });
}

async function currentGuest(pool) {
  return (await pool.query(
    'SELECT guest_information FROM sites WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, SITE_ID],
  )).rows[0].guest_information;
}

async function setCurrentGuest(client, value) {
  await client.query(
    'UPDATE sites SET guest_information = $3::jsonb WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, SITE_ID, value === null ? null : JSON.stringify(value)],
  );
}

function rollbackBlocked(error) {
  return error?.code === '55000' && error.message === 'SITE_GUEST_INFORMATION_REQUIRE_REVIEW';
}

async function assertMigrationPreserved(pool) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'guest_information'
      AND table_name IN ('sites', 'tenant_location_revisions')
    ORDER BY table_name
  `);
  assert.deepEqual(result.rows.map((row) => row.table_name), ['sites', 'tenant_location_revisions']);
  const ledger = await pool.query('SELECT name FROM schema_migrations WHERE version = 37');
  assert.deepEqual(ledger.rows, [{ name: 'site_guest_information' }]);
}

async function rollbackGuestInformation(pool) {
  try {
    return await rollbackToVersion(pool, 37);
  } catch (error) {
    await migrateUp(pool);
    throw error;
  }
}

async function waitingAccessExclusiveLock(pool, relation) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query({
      text: `
        SELECT 1 FROM pg_locks
        WHERE relation = $1::regclass AND mode = 'AccessExclusiveLock' AND granted = false
        LIMIT 1
      `,
      values: [relation],
    });
    if (result.rowCount === 1) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function assertConcurrentWritePreventsRollback(pool, relation, write) {
  const writer = await pool.connect();
  let pendingRollback;
  let waited;
  try {
    await writer.query('BEGIN');
    await write(writer);
    pendingRollback = rollbackGuestInformation(pool).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    waited = await waitingAccessExclusiveLock(pool, relation);
    await writer.query('COMMIT');
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  assert.equal(waited, true);
  assert.equal(rollbackBlocked((await pendingRollback).error), true);
  await assertMigrationPreserved(pool);
}

test('Guest Information migration preserves legacy values and blocks destructive or concurrent rollback', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    try {
      await migrateUp(pool);
      await clean(pool);
    } finally {
      await pool.end();
    }
  });

  await migrateUp(pool);
  await clean(pool);
  assert.equal(await rollbackGuestInformation(pool), true);
  await pool.query(
    "INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Guest Migration Tenant', 'active')",
    [TENANT_ID],
  );
  await pool.query(
    "INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, 'Guest Migration Admin')",
    [TENANT_ID, ADMIN_ID],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name, details) VALUES ($1, $2, $3, $4::jsonb)',
    [TENANT_ID, SITE_ID, 'Legacy Guest Site', JSON.stringify({ address: { city: 'Berlin' } })],
  );
  await pool.query({
    text: `
      INSERT INTO tenant_location_revisions (tenant_id, revision, configuration, changed_at, actor_user_id)
      VALUES ($1, 1, '{"sites": [], "rooms": []}'::jsonb, $2, $3)
    `,
    values: [TENANT_ID, new Date('2030-09-12T12:00:00.000Z'), ADMIN_ID],
  });

  await t.test('upgrade adds nullable columns without backfilling Site or historical information', async () => {
    await migrateUp(pool);
    await assertMigrationPreserved(pool);
    assert.equal(await currentGuest(pool), null);
    const legacy = await pool.query(
      'SELECT guest_information FROM tenant_location_revisions WHERE tenant_id = $1 AND revision = 1',
      [TENANT_ID],
    );
    assert.equal(legacy.rows[0].guest_information, null);
    const columns = await pool.query(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'guest_information'
        AND table_name IN ('sites', 'tenant_location_revisions')
    `);
    assert.equal(columns.rows.length, 2);
    for (const column of columns.rows) assert.deepEqual(column, { is_nullable: 'YES', column_default: null });
  });

  await t.test('positive SQL constraints reject arrays, scalars and JSON null in both columns', async () => {
    for (const value of ['[]', '"text"', '42', 'true', 'null']) {
      await assert.rejects(
        pool.query('UPDATE sites SET guest_information = $3::jsonb WHERE tenant_id = $1 AND id = $2',
          [TENANT_ID, SITE_ID, value]),
        (error) => error.code === '23514' && error.constraint === 'sites_guest_information_object',
      );
      await assert.rejects(insertHistory(pool, 2, value),
        (error) => error.code === '23514' && error.constraint === 'tenant_location_revisions_guest_information_object');
    }
    await insertHistory(pool, 2, '{}');
  });

  await t.test('legacy Site detail rewrites preserve information and populated current values block rollback', async () => {
    await setCurrentGuest(pool, GUEST_INFORMATION);
    await pool.query("UPDATE sites SET details = '{}'::jsonb WHERE tenant_id = $1 AND id = $2", [TENANT_ID, SITE_ID]);
    assert.deepEqual(await currentGuest(pool), GUEST_INFORMATION);
    await assert.rejects(rollbackGuestInformation(pool), rollbackBlocked);
    await assertMigrationPreserved(pool);
    await setCurrentGuest(pool, {});
    await assert.rejects(rollbackGuestInformation(pool), rollbackBlocked);
    await setCurrentGuest(pool, null);
  });

  await t.test('unused values and null or empty history maps permit rollback and reapplication', async () => {
    assert.equal(await rollbackGuestInformation(pool), true);
    await assert.rejects(pool.query('SELECT guest_information FROM sites'), (error) => error.code === '42703');
    await assert.rejects(pool.query('SELECT guest_information FROM tenant_location_revisions'),
      (error) => error.code === '42703');
    await migrateUp(pool);
    assert.equal(await currentGuest(pool), null);
  });

  await t.test('immutable historical information prevents rollback after current information is cleared', async () => {
    const historical = { [SITE_ID]: GUEST_INFORMATION };
    await setCurrentGuest(pool, GUEST_INFORMATION);
    await insertHistory(pool, 3, JSON.stringify(historical));
    await setCurrentGuest(pool, null);
    await assert.rejects(rollbackGuestInformation(pool), rollbackBlocked);
    await assertMigrationPreserved(pool);
    await assert.rejects(pool.query(
      'UPDATE tenant_location_revisions SET guest_information = NULL WHERE tenant_id = $1 AND revision = 3',
      [TENANT_ID],
    ), /tenant_location_revisions are immutable/);
    await assert.rejects(pool.query(
      'DELETE FROM tenant_location_revisions WHERE tenant_id = $1 AND revision = 3', [TENANT_ID],
    ), /tenant_location_revisions are immutable/);
    const stored = await pool.query(
      'SELECT guest_information FROM tenant_location_revisions WHERE tenant_id = $1 AND revision = 3', [TENANT_ID],
    );
    assert.deepEqual(stored.rows[0].guest_information, historical);
    await deleteHistory(pool);
  });

  await t.test('rollback locks current and historical writers before deciding whether removal is safe', async () => {
    await assertConcurrentWritePreventsRollback(pool, 'sites', (writer) => setCurrentGuest(writer, GUEST_INFORMATION));
    await setCurrentGuest(pool, null);
    await assertConcurrentWritePreventsRollback(pool, 'tenant_location_revisions',
      (writer) => insertHistory(writer, 4, JSON.stringify({ [SITE_ID]: GUEST_INFORMATION })));
  });
});
