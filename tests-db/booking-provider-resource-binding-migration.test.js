import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = '64646464-6464-4646-8646-646464646464';
const USER_ID = '74747474-7474-4747-8747-747474747474';
const INTEGRATION_ID = '84848484-8484-4848-8848-848484848484';
const CORRELATION_ID = '94949494-9494-4949-8949-949494949494';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seed(pool) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Resource Binding Tenant', 'active'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [TENANT_ID, USER_ID, 'Resource Binding User'],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [TENANT_ID, 'site-1', 'Resource Binding Site'],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
    [TENANT_ID, 'room-1', 'site-1', 'Resource Binding Room', 10],
  );
  await pool.query(
    `INSERT INTO integrations (tenant_id, id, provider, provider_reference, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [TENANT_ID, INTEGRATION_ID, 'calendar_test', 'resource-binding-connection', 'connected'],
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
}

async function cleanup(pool) {
  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM requests WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM integrations WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM sites WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

test('provider-resource binding migration fails closed for unresolved rows and populated rollback', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  assert.equal(await rollbackLatest(pool), true);
  await seed(pool);
  await pool.query(
    `INSERT INTO booking_provider_references (
      tenant_id, request_id, integration_id, provider_reference, idempotency_key,
      state, created_correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [TENANT_ID, 'request-1', INTEGRATION_ID, 'event-1', 'f'.repeat(64), 'active', CORRELATION_ID],
  );

  await assert.rejects(migrateUp(pool), (error) => error.code === '55000');
  assert.equal(await isPostgresSchemaReady(pool), false);
  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = $1', [TENANT_ID]);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const attemptDefault = await pool.query(
    `SELECT column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'booking_provider_references'
       AND column_name = 'attempt_number'`,
  );
  assert.equal(attemptDefault.rows[0]?.column_default, null);

  await pool.query(
    `INSERT INTO booking_provider_references (
      tenant_id, request_id, integration_id, attempt_number, provider_reference, provider_connection_reference,
      provider_resource_reference, idempotency_key, state, created_correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      TENANT_ID,
      'request-1',
      INTEGRATION_ID,
      1,
      null,
      'resource-binding-connection',
      'room-1@example.invalid',
      'f'.repeat(64),
      'pending',
      CORRELATION_ID,
    ],
  );
  const pending = await pool.query(
    `SELECT attempt_number, provider_reference, provider_connection_reference, provider_resource_reference, state
     FROM booking_provider_references
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_ID, 'request-1', INTEGRATION_ID],
  );
  assert.deepEqual(pending.rows[0], {
    attempt_number: 1,
    provider_reference: null,
    provider_connection_reference: 'resource-binding-connection',
    provider_resource_reference: 'room-1@example.invalid',
    state: 'pending',
  });
  await assert.rejects(
    pool.query(
      `UPDATE booking_provider_references
       SET provider_reference = 'placeholder'
       WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
      [TENANT_ID, 'request-1', INTEGRATION_ID],
    ),
    (error) => error.code === '23514',
  );
  assert.equal(await rollbackLatest(pool), true);
  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');
  assert.equal(await isPostgresSchemaReady(pool), false);

  await cleanup(pool);
});
