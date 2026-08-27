import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';

const TENANT_ID = 'e1111111-1111-4111-8111-111111111111';
const USER_ID = 'e2222222-2222-4222-8222-222222222222';
const RECEIPT_ID = 'e3333333-3333-4333-8333-333333333333';
const CORRELATION_ID = 'e4444444-4444-4444-8444-444444444444';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  if ((await pool.query("SELECT to_regclass('public.tenant_bulk_transfer_receipts') AS relation")).rows[0].relation) {
    await pool.query('DELETE FROM tenant_bulk_transfer_receipts WHERE tenant_id=$1', [TENANT_ID]);
  }
  await pool.query('DELETE FROM users WHERE tenant_id=$1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [TENANT_ID]);
}

test('bulk receipt migration is exact, Tenant-scoped and rollback-protected after use', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  assert.equal(await isPostgresSchemaReady(pool, 28), true);
  await pool.query(
    `INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Bulk Tenant', 'active')`,
    [TENANT_ID],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, 'Bulk Admin')`,
    [TENANT_ID, USER_ID],
  );
  await pool.query({
    text: `INSERT INTO tenant_bulk_transfer_receipts (
      tenant_id, id, actor_user_id, aggregate, document_type, source_revision,
      payload_sha256, status, expires_at, created_at, correlation_id
    ) VALUES ($1, $2, $3, 'locations', 'sites', 1, $4, 'pending', $5, $6, $7)`,
    values: [
      TENANT_ID,
      RECEIPT_ID,
      USER_ID,
      'a'.repeat(64),
      '2026-08-27T12:30:00.000Z',
      '2026-08-27T12:00:00.000Z',
      CORRELATION_ID,
    ],
  });
  await assert.rejects(
    rollbackToVersion(pool, 28),
    (error) => error.code === '55000'
      && error.message.includes('TENANT_BULK_TRANSFER_RECEIPTS_REQUIRE_REVIEW'),
  );
  await pool.query('DELETE FROM tenant_bulk_transfer_receipts WHERE tenant_id=$1', [TENANT_ID]);
  assert.equal(await rollbackToVersion(pool, 28), true);
  assert.equal(await isPostgresSchemaReady(pool, 27), true);
});
