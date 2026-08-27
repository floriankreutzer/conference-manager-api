import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('bulk receipt migration is exact, Tenant-scoped and carries a fail-closed rollback guard', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(() => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool, 28), true);
  const columns = await pool.query({
    text: `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenant_bulk_transfer_receipts'
      ORDER BY ordinal_position`,
  });
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    'tenant_id', 'id', 'actor_user_id', 'aggregate', 'document_type', 'source_revision',
    'payload_sha256', 'status', 'expires_at', 'created_at', 'correlation_id',
    'applied_at', 'applied_response',
  ]);
  const down = await readFile(new URL('../migrations/028_tenant_bulk_transfer_receipts.down.sql', import.meta.url), 'utf8');
  assert.match(down, /LOCK TABLE tenant_bulk_transfer_receipts IN ACCESS EXCLUSIVE MODE/);
  assert.match(down, /TENANT_BULK_TRANSFER_RECEIPTS_REQUIRE_REVIEW/);
  assert.match(down, /IF EXISTS \(SELECT 1 FROM tenant_bulk_transfer_receipts LIMIT 1\)/);
});
