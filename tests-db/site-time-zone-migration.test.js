import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = '69696969-6969-4696-8696-696969696969';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM sites WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

test('Site time-zone migration preserves unknown legacy values and protects rollback', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);

  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Site Time Zone Tenant', 'active'],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [TENANT_ID, 'site-1', 'Legacy Site'],
  );

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const legacy = await pool.query(
    'SELECT time_zone FROM sites WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, 'site-1'],
  );
  assert.equal(legacy.rows[0].time_zone, null);

  await assert.rejects(
    pool.query(
      'UPDATE sites SET time_zone = $3 WHERE tenant_id = $1 AND id = $2',
      [TENANT_ID, 'site-1', ' UTC'],
    ),
    (error) => error.code === '23514',
  );
  await pool.query(
    'UPDATE sites SET time_zone = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, 'site-1', 'Europe/Berlin'],
  );
  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000' && error.message.includes('SITE_TIME_ZONE_ROWS_REQUIRE_REVIEW'),
  );

  await pool.query(
    'UPDATE sites SET time_zone = NULL WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, 'site-1'],
  );
  assert.equal(await rollbackLatest(pool), true);
  await assert.rejects(
    pool.query('SELECT time_zone FROM sites WHERE tenant_id = $1', [TENANT_ID]),
    (error) => error.code === '42703',
  );

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
