import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantUserLifecycleService } from '../src/application/tenant-user-lifecycle-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresJitUserRepository } from '../src/persistence/postgres/jit-user-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  createPostgresTenantUserLifecycleRepository,
} from '../src/persistence/postgres/tenant-user-lifecycle-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

// Keep this integration fixture namespace distinct because node:test executes
// database suites concurrently against the same PostgreSQL service.
const TENANT_A = 'd1111111-1111-4111-8111-111111111111';
const TENANT_B = 'd2222222-2222-4222-8222-222222222222';
const ADMIN_A = 'd3333333-3333-4333-8333-333333333333';
const USER_A = 'd4444444-4444-4444-8444-444444444444';
const USER_B = 'd5555555-5555-4555-8555-555555555555';
const BINDING_A = 'd6666666-6666-4666-8666-666666666666';
const CORRELATION_ID = 'd7777777-7777-4777-8777-777777777777';
const PROVIDER_TENANT_A = 'd8888888-8888-4888-8888-888888888888';
const PROVIDER_USER_A = 'd9999999-9999-4999-8999-999999999999';
const SESSION_ID = 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUDIT_KEY = 'tenant-user-lifecycle-persistence-audit-key-32-bytes';
const TENANT_IDS = [TENANT_A, TENANT_B];

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function principal() {
  return {
    userId: ADMIN_A,
    tenantId: TENANT_A,
    roles: ['employee', 'tenant_admin'],
    permissions: [
      'request:read',
      'request:cancel',
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
  };
}

async function clean(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, TENANT_IDS);
  await pool.query('DELETE FROM sessions WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM user_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
}

async function seed(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status) VALUES
      ($1, 'Tenant A', 'active'),
      ($2, 'Tenant B', 'active')`,
    [TENANT_A, TENANT_B],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, active, created_at, updated_at) VALUES
      ($1, $2, 'Tenant Admin', true, $6, $6),
      ($1, $3, 'Managed User', true, $6, $6),
      ($4, $5, 'Other Tenant User', true, $6, $6)`,
    [TENANT_A, ADMIN_A, USER_A, TENANT_B, USER_B, '2026-08-27T08:00:00.000Z'],
  );
  await pool.query(
    `INSERT INTO tenant_user_roles (tenant_id, user_id, role, created_at, updated_at) VALUES
      ($1, $2, 'tenant_admin', $4, $4),
      ($1, $3, 'tenant_admin', $4, $4)`,
    [TENANT_A, ADMIN_A, USER_A, '2026-08-27T08:00:00.000Z'],
  );
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
      id, tenant_id, provider, provider_tenant_reference, status, created_at, updated_at
    ) VALUES ($1, $2, 'microsoft_entra', $3, 'active', $4, $4)`,
    [BINDING_A, TENANT_A, PROVIDER_TENANT_A, '2026-08-27T08:00:00.000Z'],
  );
  await pool.query(
    `INSERT INTO user_identity_bindings (
      tenant_id, provider, provider_tenant_reference, provider_user_reference,
      user_id, created_at, updated_at
    ) VALUES ($1, 'microsoft_entra', $2, $3, $4, $5, $5)`,
    [TENANT_A, PROVIDER_TENANT_A, PROVIDER_USER_A, USER_A, '2026-08-27T08:05:00.000Z'],
  );
  await pool.query(
    `INSERT INTO sessions (
      id, tenant_id, user_id, token_hash, provider, provider_identity_reference,
      roles, permissions, principal_version, issued_at, expires_at
    ) VALUES ($1, $2, $3, $4, 'microsoft_entra', $5, $6, $7, 1, $8, $9)`,
    [
      SESSION_ID,
      TENANT_A,
      USER_A,
      'a'.repeat(64),
      PROVIDER_USER_A,
      ['employee', 'tenant_admin'],
      ['request:read', 'request:cancel', 'tenant:users:manage'],
      '2026-08-27T08:30:00.000Z',
      '2026-08-27T18:30:00.000Z',
    ],
  );
  await pool.query(
    `INSERT INTO requests (
      tenant_id, id, requester_user_id, status, starts_at, ends_at,
      created_at, updated_at, status_changed_at
    ) VALUES ($1, 'REQ-LIFECYCLE', $2, 'Submitted', $3, $4, $5, $5, $5)`,
    [
      TENANT_A,
      USER_A,
      '2026-08-28T10:00:00.000Z',
      '2026-08-28T11:00:00.000Z',
      '2026-08-27T08:00:00.000Z',
    ],
  );
}

test('Tenant User disable is isolated, audit-atomic and fails Entra JIT access closed', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seed(pool);

  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const repository = createPostgresTenantUserLifecycleRepository(pool, { auditRepository });
  const service = createTenantUserLifecycleService({
    repository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse('2026-08-27T09:00:00.000Z'),
  });

  const page = await service.listUsers({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A, status: 'active' },
    correlationId: CORRELATION_ID,
    search: 'Managed',
    status: 'active',
    role: 'tenant_admin',
    providerLink: 'linked',
  });
  assert.equal(page.users.length, 1);
  assert.equal(page.users[0].id, USER_A);
  assert.equal(page.users[0].lastSignInAt, '2026-08-27T08:30:00.000Z');
  assert.equal(page.users[0].requestOwnership.openRequestCount, 1);

  const disabled = await service.setAccess({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A, status: 'active' },
    targetUserId: USER_A,
    active: false,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  });
  assert.equal(disabled.active, false);
  assert.equal(disabled.lifecycle.version, 2);

  const persisted = await pool.query(
    'SELECT active, security_version, lifecycle_revision FROM users WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, USER_A],
  );
  assert.equal(persisted.rows[0].active, false);
  assert.equal(Number(persisted.rows[0].security_version), 2);
  assert.equal(Number(persisted.rows[0].lifecycle_revision), 2);
  const session = await pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [SESSION_ID]);
  assert.equal(session.rows[0].revoked_at.toISOString(), '2026-08-27T09:00:00.000Z');
  const request = await pool.query(
    'SELECT requester_user_id, status FROM requests WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, 'REQ-LIFECYCLE'],
  );
  assert.equal(request.rows[0].requester_user_id, USER_A);
  assert.equal(request.rows[0].status, 'Submitted');

  const jit = createPostgresJitUserRepository(pool, { auditRepository });
  const resolved = await jit.resolveOrProvision({
    tenantId: TENANT_A,
    provider: 'microsoft_entra',
    providerTenantReference: PROVIDER_TENANT_A,
    providerUserReference: PROVIDER_USER_A,
    displayName: 'Managed User',
    fallbackDisplayName: 'Provisioned user',
    newUserId: USER_B,
    changedAt: new Date('2026-08-27T09:05:00.000Z'),
    provisionAuditEvent: {},
    profileAuditEventFor() {
      return {};
    },
  });
  assert.deepEqual(resolved, { status: 'user_disabled' });

  const otherTenant = await repository.changeAccess({
    tenantId: TENANT_A,
    targetUserId: USER_B,
    active: false,
    expectedVersion: 1,
    changedAt: new Date('2026-08-27T09:10:00.000Z'),
    auditEventFor() {
      return {};
    },
  });
  assert.equal(otherTenant.status, 'not_found');

  const lastAdmin = await repository.changeAccess({
    tenantId: TENANT_A,
    targetUserId: ADMIN_A,
    active: false,
    expectedVersion: 1,
    changedAt: new Date('2026-08-27T09:10:00.000Z'),
    auditEventFor() {
      return {};
    },
  });
  assert.equal(lastAdmin.status, 'last_tenant_admin');

  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000'
      && error.message.includes('TENANT_USER_LIFECYCLE_REVISIONS_REQUIRE_REVIEW'),
  );
  await clean(pool);
  assert.equal(await rollbackLatest(pool), true);
  const removed = await pool.query({
    text: `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'lifecycle_revision'
    `,
  });
  assert.equal(removed.rowCount, 0);
  await migrateUp(pool);
});
