import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { createPostgresTenantBulkTransferRepository } from '../src/persistence/postgres/tenant-bulk-transfer-repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const RECEIPT = '44444444-4444-4444-8444-444444444444';

test('Equipment receipt migration preserves Tenant/actor constraints and blocks rollback after use', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  assert.equal(await rollbackLatest(pool), true); // Empty schema 043
  assert.equal(await rollbackLatest(pool), true); // Unused Equipment schema 042
  await migrateUp(pool);
  await pool.query("INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Equipment Tenant', 'active')", [TENANT]);
  await pool.query('INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)', [TENANT, USER, 'Manager']);
  const repository = createPostgresTenantBulkTransferRepository(pool);
  const input = { tenantId: TENANT, id: RECEIPT, actorUserId: USER, aggregate: 'catalogue',
    documentType: 'equipment', sourceRevision: 1, payloadSha256: 'a'.repeat(64),
    createdAt: new Date('2026-10-03T08:00:00Z'), expiresAt: new Date('2026-10-03T08:30:00Z'), correlationId: RECEIPT };
  assert.equal((await repository.create(input)).documentType, 'equipment');
  assert.equal((await repository.load({ tenantId: TENANT, id: RECEIPT })).actorUserId, USER);
  assert.equal(await repository.load({ tenantId: FOREIGN, id: RECEIPT }), null);
  await assert.rejects(repository.create({ ...input, id: FOREIGN, actorUserId: FOREIGN }),
    (error) => error.code === '23503');
  assert.equal(await rollbackLatest(pool), true); // Schema 043 is still empty
  await assert.rejects(rollbackLatest(pool), /EQUIPMENT_BULK_RECEIPTS_REQUIRE_REVIEW/);
  assert.equal((await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')).rows[0].version, 42);
  assert.equal((await repository.load({ tenantId: TENANT, id: RECEIPT })).documentType, 'equipment');
});
