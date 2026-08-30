import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { changeTenantStatusWithClient } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { migrateUp } from './support/db-migrations.js';

const TENANT_ID = 'e1111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'e2222222-2222-4222-8222-222222222222';
const USER_ID = 'e3333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = 'e4444444-4444-4444-8444-444444444444';
const SESSION_ID = 'e5555555-5555-4555-8555-555555555555';
const OTHER_SESSION_ID = 'e6666666-6666-4666-8666-666666666666';
const SUSPENDED_AT = '2026-08-30T12:00:00.000Z';
const REACTIVATED_AT = '2026-08-30T12:05:00.000Z';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seed(pool) {
  await pool.query({
    text: `INSERT INTO tenants (id, display_name, status, created_at, updated_at) VALUES
      ($1, 'Recovery lifecycle Tenant', 'active', $3, $3),
      ($2, 'Other lifecycle Tenant', 'active', $3, $3)`,
    values: [TENANT_ID, OTHER_TENANT_ID, '2026-08-30T11:00:00.000Z'],
  });
  await pool.query({
    text: `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at) VALUES
      ($1, $2, 'Recovery lifecycle User', $5, $5),
      ($3, $4, 'Other lifecycle User', $5, $5)`,
    values: [
      TENANT_ID,
      USER_ID,
      OTHER_TENANT_ID,
      OTHER_USER_ID,
      '2026-08-30T11:00:00.000Z',
    ],
  });
  await pool.query({
    text: `INSERT INTO sessions (
      id, tenant_id, user_id, token_hash, provider, provider_identity_reference,
      roles, permissions, principal_version, issued_at, expires_at
    ) VALUES
      ($1, $2, $3, $4, 'microsoft_entra', 'recovery-user',
       ARRAY['employee'], ARRAY['request:read'], 1, $7, $8),
      ($5, $6, $9, $10, 'microsoft_entra', 'other-user',
       ARRAY['employee'], ARRAY['request:read'], 1, $7, $8)`,
    values: [
      SESSION_ID,
      TENANT_ID,
      USER_ID,
      '1'.repeat(64),
      OTHER_SESSION_ID,
      OTHER_TENANT_ID,
      '2026-08-30T11:00:00.000Z',
      '2026-08-31T11:00:00.000Z',
      OTHER_USER_ID,
      '2'.repeat(64),
    ],
  });
}

test('canonical Tenant lifecycle persistence revokes only suspended-Tenant sessions', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(() => pool.end());
  await migrateUp(pool);
  await seed(pool);

  const suspended = await withPostgresTransaction(pool, (client) => changeTenantStatusWithClient(client, {
    tenantId: TENANT_ID,
    expectedStatus: 'active',
    expectedRevision: 1,
    targetStatus: 'suspended',
    changedAt: new Date(SUSPENDED_AT),
  }));
  assert.equal(suspended.outcome, 'updated');
  assert.equal(suspended.revision, 2);
  assert.equal(suspended.customerSessionRevision, 2);
  assert.equal(suspended.revokedSessionCount, 1);

  const afterSuspension = await pool.query({
    text: `SELECT tenant.status, tenant.lifecycle_revision::int, tenant.customer_session_revision::int,
             session.revoked_at, other_session.revoked_at AS other_revoked_at
           FROM tenants tenant
           JOIN sessions session ON session.tenant_id = tenant.id AND session.id = $2
           JOIN sessions other_session ON other_session.id = $3
           WHERE tenant.id = $1`,
    values: [TENANT_ID, SESSION_ID, OTHER_SESSION_ID],
  });
  assert.deepEqual(afterSuspension.rows[0], {
    status: 'suspended',
    lifecycle_revision: 2,
    customer_session_revision: 2,
    revoked_at: new Date(SUSPENDED_AT),
    other_revoked_at: null,
  });
  const otherTenant = await pool.query({
    text: `SELECT status, lifecycle_revision::int, customer_session_revision::int
           FROM tenants WHERE id = $1`,
    values: [OTHER_TENANT_ID],
  });
  assert.deepEqual(otherTenant.rows[0], {
    status: 'active',
    lifecycle_revision: 1,
    customer_session_revision: 1,
  });

  const reactivated = await withPostgresTransaction(pool, (client) => changeTenantStatusWithClient(client, {
    tenantId: TENANT_ID,
    expectedStatus: 'suspended',
    expectedRevision: 2,
    targetStatus: 'active',
    changedAt: new Date(REACTIVATED_AT),
  }));
  assert.equal(reactivated.outcome, 'updated');
  assert.equal(reactivated.revision, 3);
  assert.equal(reactivated.customerSessionRevision, 2);
  assert.equal(reactivated.revokedSessionCount, 0);

  const stale = await withPostgresTransaction(pool, (client) => changeTenantStatusWithClient(client, {
    tenantId: TENANT_ID,
    expectedStatus: 'active',
    expectedRevision: 2,
    targetStatus: 'suspended',
    changedAt: new Date('2026-08-30T12:10:00.000Z'),
  }));
  assert.deepEqual(stale, { outcome: 'stale' });
  const finalTenant = await pool.query({
    text: `SELECT tenant.status, tenant.lifecycle_revision::int,
             tenant.customer_session_revision::int, session.revoked_at
           FROM tenants tenant
           JOIN sessions session ON session.tenant_id = tenant.id AND session.id = $2
           WHERE tenant.id = $1`,
    values: [TENANT_ID, SESSION_ID],
  });
  assert.deepEqual(finalTenant.rows[0], {
    status: 'active',
    lifecycle_revision: 3,
    customer_session_revision: 2,
    revoked_at: new Date(SUSPENDED_AT),
  });
});
