import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = '63636363-6363-4636-8636-636363636363';
const USER_ID = '73737373-7373-4737-8737-737373737373';
const INTEGRATION_ID = '83838383-8383-4838-8838-838383838383';
const CORRELATION_ID = '93939393-9393-4939-8939-939393939393';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('booking reference migration rollback fails closed when provider links exist', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);

  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Migration Tenant', 'active'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [TENANT_ID, USER_ID, 'Migration User'],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [TENANT_ID, 'site-1', 'Migration Site'],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
    [TENANT_ID, 'room-1', 'site-1', 'Migration Room', 10],
  );
  await pool.query(
    `INSERT INTO integrations (tenant_id, id, provider, provider_reference, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [TENANT_ID, INTEGRATION_ID, 'calendar_test', 'migration-connection', 'connected'],
  );
  await pool.query(
    `INSERT INTO requests (
      tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at, internal_participants
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      TENANT_ID,
      'request-1',
      USER_ID,
      'room-1',
      'Submitted',
      '2026-09-03T10:00:00.000Z',
      '2026-09-03T11:00:00.000Z',
      1,
    ],
  );
  await pool.query(
    `INSERT INTO booking_provider_references (
      tenant_id,
      request_id,
      integration_id,
      provider_reference,
      idempotency_key,
      state,
      created_correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [TENANT_ID, 'request-1', INTEGRATION_ID, 'migration-event', 'e'.repeat(64), 'active', CORRELATION_ID],
  );

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');

  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = $1', [TENANT_ID]);
  assert.equal(await rollbackLatest(pool), true);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);

  await pool.query('DELETE FROM requests WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM integrations WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM sites WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
});
