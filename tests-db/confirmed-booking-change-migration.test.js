import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from './support/db-migrations.js';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_ID = '12121212-1212-4121-8121-121212121212';
const USER_ID = '23232323-2323-4232-8232-232323232323';
const MIGRATION_VERSION = 19;

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, [TENANT_ID]);
  await pool.query('DELETE FROM booking_change_requests WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM requests WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM sites WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

test('confirmed booking change migration enforces one open proposal and fail-closed rollback', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await pool.query('INSERT INTO tenants (id,display_name,status) VALUES ($1,$2,$3)',
    [TENANT_ID, 'Change Tenant', 'active']);
  await pool.query('INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,$3)',
    [TENANT_ID, USER_ID, 'Requester']);
  await pool.query('INSERT INTO sites (tenant_id,id,name,time_zone) VALUES ($1,$2,$3,$4)',
    [TENANT_ID, 'site-1', 'Site', 'Europe/Berlin']);
  await pool.query('INSERT INTO rooms (tenant_id,id,site_id,name,capacity) VALUES ($1,$2,$3,$4,$5)',
    [TENANT_ID, 'room-1', 'site-1', 'Room', 10]);
  await pool.query(`INSERT INTO requests (
      tenant_id,id,requester_user_id,room_id,status,starts_at,ends_at,
      internal_participants,external_participants,status_changed_at,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,'Confirmed',$5,$6,2,0,$7,$7,$7)`, [
    TENANT_ID, 'CR-68', USER_ID, 'room-1',
    '2026-09-01T08:00:00.000Z', '2026-09-01T09:00:00.000Z', '2026-08-26T10:00:00.000Z',
  ]);
  const insert = `INSERT INTO booking_change_requests (
      tenant_id,id,request_id,initiator_user_id,status,room_id,starts_at,ends_at,
      internal_participants,external_participants,base_request_updated_at,created_at,updated_at,
      initiator_role_at_action
    ) VALUES ($1,$2,'CR-68',$3,'pending','room-1',$4,$5,3,0,$6,$6,$6,'employee')`;
  await pool.query(insert, [TENANT_ID, '34343434-3434-4343-8343-343434343434', USER_ID,
    '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', '2026-08-26T10:00:00.000Z']);
  await assert.rejects(
    pool.query(insert, [TENANT_ID, '45454545-4545-4454-8454-454545454545', USER_ID,
      '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', '2026-08-26T10:00:00.000Z']),
    (error) => error.code === '23505',
  );
  await assert.rejects(
    rollbackToVersion(pool, MIGRATION_VERSION),
    (error) => error.code === '55000' && error.message.includes('BOOKING_CHANGE_ROWS_REQUIRE_REVIEW'),
  );
  await pool.query('DELETE FROM booking_change_requests WHERE tenant_id = $1', [TENANT_ID]);
  assert.equal(await rollbackToVersion(pool, MIGRATION_VERSION), true);
  const missing = await pool.query("SELECT to_regclass('public.booking_change_requests') AS relation");
  assert.equal(missing.rows[0].relation, null);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
