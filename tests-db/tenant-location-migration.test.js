import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import {
  CURRENT_SCHEMA_VERSION,
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest, rollbackToVersion } from './support/db-migrations.js';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_ID = '70707070-7070-4070-8070-707070707070';
const ADMIN_ID = '71717171-7171-4171-8171-717171717171';

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
  await removeSaas2TenantAdministrationFixtures(pool, [TENANT_ID]);
  await deleteHistory(pool);
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function waitingAccessExclusiveLock(pool, relation) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query({
      text: `
        SELECT 1
        FROM pg_locks
        WHERE relation = $1::regclass
          AND mode = 'AccessExclusiveLock'
          AND granted = false
        LIMIT 1
      `,
      values: [relation],
    });
    if (result.rowCount === 1) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('migration 021 follows the runner contract, locks rollback and fails closed after use', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await clean(pool);
  assert.equal(await rollbackToVersion(pool, 22), true);
  assert.equal(CURRENT_SCHEMA_VERSION, 41);
  assert.equal(await isPostgresSchemaReady(pool, 21), true);
  const applied = await pool.query(
    'SELECT version, name, char_length(checksum)::int AS checksum_length FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  assert.deepEqual(applied.rows[0], {
    version: 21,
    name: 'tenant_location_self_service',
    checksum_length: 64,
  });

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 21), false);
  const removed = await pool.query({
    text: `
      SELECT
        to_regclass('public.tenant_location_revisions') AS history_table,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sites' AND column_name = 'details'
        ) AS site_details,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'details'
        ) AS room_details
    `,
  });
  assert.deepEqual(removed.rows[0], {
    history_table: null,
    site_details: false,
    room_details: false,
  });
  await migrateUp(pool);
  assert.equal(await rollbackToVersion(pool, 22), true);
  assert.equal(await isPostgresSchemaReady(pool, 21), true);

  await pool.query(
    "INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Migration Lock Tenant', 'active')",
    [TENANT_ID],
  );
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [TENANT_ID]);
  const rollback = rollbackLatest(pool);
  let rollbackWaitedForLock;
  try {
    rollbackWaitedForLock = await waitingAccessExclusiveLock(pool, 'tenants');
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  assert.equal(rollbackWaitedForLock, true);
  assert.equal(await rollback, true);
  assert.equal(await isPostgresSchemaReady(pool, 21), false);

  await migrateUp(pool);
  assert.equal(await rollbackToVersion(pool, 22), true);
  await pool.query({
    text: `
      INSERT INTO sites (tenant_id, id, name, details)
      VALUES ($1, 'rollback-detail', 'Rollback Detail', '{"address":{"city":"Berlin"}}'::jsonb)
    `,
    values: [TENANT_ID],
  });
  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000' && error.message.includes('TENANT_LOCATION_HISTORY_REQUIRE_REVIEW'),
  );
  await pool.query("DELETE FROM sites WHERE tenant_id = $1 AND id = 'rollback-detail'", [TENANT_ID]);
  await pool.query(
    "INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, 'Migration Admin')",
    [TENANT_ID, ADMIN_ID],
  );
  await pool.query(
    'UPDATE tenants SET locations_revision = 2 WHERE id = $1',
    [TENANT_ID],
  );
  await pool.query({
    text: `
      INSERT INTO tenant_location_revisions (
        tenant_id, revision, configuration, changed_at, actor_user_id
      )
      VALUES ($1, 1, '{"sites": [], "rooms": []}'::jsonb, $2, $3)
    `,
    values: [TENANT_ID, new Date('2030-08-27T12:00:00.000Z'), ADMIN_ID],
  });
  await assert.rejects(
    pool.query(
      "UPDATE tenant_location_revisions SET configuration = '{\"sites\": [], \"rooms\": []}'::jsonb WHERE tenant_id = $1",
      [TENANT_ID],
    ),
    /tenant_location_revisions are immutable/,
  );
  await assert.rejects(
    pool.query('DELETE FROM tenant_location_revisions WHERE tenant_id = $1', [TENANT_ID]),
    /tenant_location_revisions are immutable/,
  );
  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000' && error.message.includes('TENANT_LOCATION_HISTORY_REQUIRE_REVIEW'),
  );
  assert.equal(await isPostgresSchemaReady(pool, 21), true);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM schema_migrations WHERE version = 21',
  )).rows[0].count, 1);

  await deleteHistory(pool);
  await pool.query('UPDATE tenants SET locations_revision = 1 WHERE id = $1', [TENANT_ID]);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 21), false);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
