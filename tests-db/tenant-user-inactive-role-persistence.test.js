import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantUserAdminRepository } from '../src/persistence/postgres/tenant-user-admin-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_ID = '91919191-9191-4191-8191-919191919191';
const ADMIN_ID = '92929292-9292-4292-8292-929292929292';
const TARGET_ID = '93939393-9393-4393-8393-939393939393';
const CORRELATION_ID = '94949494-9494-4494-8494-949494949494';
const AUDIT_KEY = 'inactive-role-revocation-audit-key-at-least-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function cleanup(pool) {
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

function auditEventFor({ previousElevatedRoles, nextElevatedRoles }) {
  const state = (roles) => ({
    conferenceManager: roles.includes('conference_manager'),
    tenantAdmin: roles.includes('tenant_admin'),
  });
  return {
    tenantId: TENANT_ID,
    actorUserId: ADMIN_ID,
    action: 'tenant.user_permissions.changed',
    targetType: 'user',
    targetId: TARGET_ID,
    previousState: state(previousElevatedRoles),
    newState: state(nextElevatedRoles),
    occurredAt: '2026-08-24T16:30:00.000Z',
    correlationId: CORRELATION_ID,
    outcome: 'success',
    metadata: { operation: 'inactive_revoke_test' },
    retentionClass: 'administrative',
  };
}

test('inactive users may lose existing elevated roles but cannot receive a new elevated role', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const repository = createPostgresTenantUserAdminRepository(pool, { auditRepository });

  t.after(async () => {
    await cleanup(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await cleanup(pool);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Inactive Role Tenant', 'active'],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, active)
     VALUES ($1, $2, 'Active Admin', true), ($1, $3, 'Inactive Target', false)`,
    [TENANT_ID, ADMIN_ID, TARGET_ID],
  );
  await pool.query(
    `INSERT INTO tenant_user_roles (tenant_id, user_id, role)
     VALUES
       ($1, $2, 'tenant_admin'),
       ($1, $3, 'conference_manager'),
       ($1, $3, 'tenant_admin')`,
    [TENANT_ID, ADMIN_ID, TARGET_ID],
  );

  const revoked = await repository.setElevatedRoles({
    tenantId: TENANT_ID,
    targetUserId: TARGET_ID,
    elevatedRoles: ['tenant_admin'],
    changedAt: new Date('2026-08-24T16:30:00.000Z'),
    auditEventFor,
  });
  assert.equal(revoked.status, 'updated');
  assert.deepEqual(revoked.user.elevatedRoles, ['tenant_admin']);

  const blocked = await repository.setElevatedRoles({
    tenantId: TENANT_ID,
    targetUserId: TARGET_ID,
    elevatedRoles: ['conference_manager', 'tenant_admin'],
    changedAt: new Date('2026-08-24T16:31:00.000Z'),
    auditEventFor,
  });
  assert.equal(blocked.status, 'user_inactive');

  const persisted = await pool.query(
    'SELECT role FROM tenant_user_roles WHERE tenant_id = $1 AND user_id = $2 ORDER BY role',
    [TENANT_ID, TARGET_ID],
  );
  assert.deepEqual(persisted.rows.map((row) => row.role), ['tenant_admin']);
  assert.equal(await auditRepository.verifyTenantChain(TENANT_ID), true);
});
