import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = '56565656-5656-4656-8656-565656565656';
const CORRELATION_ID = '57575757-5757-4757-8757-575757575757';
const EVENT_HASH = 'a'.repeat(64);

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function removeAuditRow(pool) {
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
}

test('request-created audit migration allows evidence and rolls back fail-closed', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await removeAuditRow(pool);
    await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Request Audit Migration Tenant', 'active'],
  );
  await pool.query({
    text: `
      INSERT INTO audit_events (
        tenant_id, actor_user_id, action, target_type, target_id,
        occurred_at, correlation_id, outcome, metadata, previous_state, new_state,
        retention_class, previous_hash, event_hash, integrity_version
      )
      VALUES ($1, NULL, 'request.created', 'request', 'migration-request',
        clock_timestamp(), $2, 'success', '{}'::jsonb, NULL, '{"status":"Submitted"}'::jsonb,
        'business', NULL, $3, 1)
    `,
    values: [TENANT_ID, CORRELATION_ID, EVENT_HASH],
  });

  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000'
      && error.message.includes('REQUEST_CREATED_AUDIT_ROWS_REQUIRE_REVIEW'),
  );

  await removeAuditRow(pool);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);

  await assert.rejects(
    pool.query({
      text: `
        INSERT INTO audit_events (
          tenant_id, actor_user_id, action, target_type, target_id,
          occurred_at, correlation_id, outcome, metadata, previous_state, new_state,
          retention_class, previous_hash, event_hash, integrity_version
        )
        VALUES ($1, NULL, 'request.created', 'request', 'migration-request',
          clock_timestamp(), $2, 'success', '{}'::jsonb, NULL, NULL,
          'business', NULL, $3, 1)
      `,
      values: [TENANT_ID, CORRELATION_ID, EVENT_HASH],
    }),
    (error) => error.code === '23514',
  );

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
