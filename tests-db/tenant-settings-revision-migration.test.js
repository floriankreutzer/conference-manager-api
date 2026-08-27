import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = '90909090-9090-4090-8090-909090909090';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

test('Tenant settings revisions migrate without rewriting data and rollback fails closed after use', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Revision Tenant', 'active'],
  );

  const initial = await pool.query({
    text: `
      SELECT organization_revision, locations_revision, catalog_revision,
             booking_policies_revision, cost_allocation_revision
      FROM tenants
      WHERE id = $1
    `,
    values: [TENANT_ID],
  });
  assert.deepEqual(
    Object.values(initial.rows[0]).map(Number),
    [1, 1, 1, 1, 1],
  );

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await pool.query(
    'UPDATE tenants SET locations_revision = locations_revision + 1 WHERE id = $1',
    [TENANT_ID],
  );
  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000' && error.message.includes('TENANT_SETTINGS_REVISIONS_REQUIRE_REVIEW'),
  );

  await pool.query('UPDATE tenants SET locations_revision = 1 WHERE id = $1', [TENANT_ID]);
  assert.equal(await rollbackLatest(pool), true);
  const columns = await pool.query({
    text: `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tenants'
        AND column_name LIKE '%_revision'
    `,
  });
  assert.equal(columns.rowCount, 0);

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const restored = await pool.query(
    'SELECT locations_revision FROM tenants WHERE id = $1',
    [TENANT_ID],
  );
  assert.equal(Number(restored.rows[0].locations_revision), 1);
});
