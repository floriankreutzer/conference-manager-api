import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from './support/db-migrations.js';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_ID = '96969696-9696-4696-8696-969696969696';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('calendar write entitlement migration is fail-closed and reversible without write grants', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await removeSaas2TenantAdministrationFixtures(pool, [TENANT_ID]);
    await pool.query('DELETE FROM tenant_entitlements WHERE tenant_id = $1', [TENANT_ID]);
    await clearSaas3TestState(pool);
    await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Calendar Write Migration Tenant', 'active'],
  );
  await pool.query(
    'INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled) VALUES ($1, $2, true)',
    [TENANT_ID, 'microsoft.calendar.write'],
  );

  await assert.rejects(
    rollbackToVersion(pool, 13),
    (error) => error.code === '55000'
      && error.message.includes('MICROSOFT_CALENDAR_WRITE_ENTITLEMENT_ROWS_REQUIRE_REVIEW'),
  );
  assert.equal(await isPostgresSchemaReady(pool), false);

  await pool.query(
    'DELETE FROM tenant_entitlements WHERE tenant_id = $1 AND capability_id = $2',
    [TENANT_ID, 'microsoft.calendar.write'],
  );
  assert.equal(await rollbackToVersion(pool, 13), true);

  await assert.rejects(
    pool.query(
      'INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled) VALUES ($1, $2, true)',
      [TENANT_ID, 'microsoft.calendar.write'],
    ),
    (error) => error.code === '23514',
  );
  await pool.query(
    'INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled) VALUES ($1, $2, true)',
    [TENANT_ID, 'microsoft.calendar'],
  );

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
