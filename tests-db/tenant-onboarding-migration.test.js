import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = '91919191-9191-4919-8919-919191919191';
const INVITATION_ID = '92929292-9292-4929-8929-929292929292';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('tenant onboarding migration refuses rollback when invitation or binding evidence exists', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  for (let version = 16; version >= 9; version -= 1) {
    assert.equal(await rollbackLatest(pool), true);
  }
  assert.equal(await isPostgresSchemaReady(pool), false);

  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Rollback Guard Tenant', 'pending'],
  );
  await pool.query(
    `INSERT INTO tenant_onboarding_invitations
      (id, tenant_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      INVITATION_ID,
      TENANT_ID,
      '9'.repeat(64),
      '2026-08-24T12:00:00.000Z',
      '2026-08-25T12:00:00.000Z',
    ],
  );

  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');
  const retained = await pool.query(
    'SELECT count(*)::int AS count FROM tenant_onboarding_invitations WHERE id = $1',
    [INVITATION_ID],
  );
  assert.equal(retained.rows[0].count, 1);

  await pool.query('DELETE FROM tenant_onboarding_invitations WHERE id = $1', [INVITATION_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
  assert.equal(await rollbackLatest(pool), true);
  const missing = await pool.query("SELECT to_regclass('public.tenant_identity_bindings') AS table_name");
  assert.equal(missing.rows[0].table_name, null);

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
