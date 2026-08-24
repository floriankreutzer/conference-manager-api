import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantUserAdministrationService } from '../src/application/tenant-user-administration-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../src/audit/event.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createJitUserService } from '../src/identity/jit-user-service.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresJitUserRepository } from '../src/persistence/postgres/jit-user-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import {
  createPostgresTenantOnboardingRepository,
} from '../src/persistence/postgres/tenant-onboarding-repository.js';
import {
  createPostgresTenantUserAdminRepository,
} from '../src/persistence/postgres/tenant-user-admin-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '10101010-1010-4010-8010-101010101010';
const TENANT_B = '20202020-2020-4020-8020-202020202020';
const ADMIN_A = '30303030-3030-4030-8030-303030303030';
const USER_A = '40404040-4040-4040-8040-404040404040';
const USER_B = '50505050-5050-4050-8050-505050505050';
const REPEAT_CANDIDATE_ID = '87878787-8787-4787-8787-878787878787';
const BIND_A = '60606060-6060-4060-8060-606060606060';
const BIND_B = '70707070-7070-4070-8070-707070707070';
const CORR_A = '80808080-8080-4080-8080-808080808080';
const CORR_B = '81818181-8181-4181-8181-818181818181';
const PROVIDER_TENANT_A = '82828282-8282-4282-8282-828282828282';
const PROVIDER_TENANT_B = '83838383-8383-4383-8383-838383838383';
const CLAIMANT_REFERENCE = '84848484-8484-4484-8484-848484848484';
const USER_REFERENCE = '85858585-8585-4585-8585-858585858585';
const AUDIT_KEY = 'tenant-role-persistence-audit-key-at-least-32-bytes';
const CSRF_KEY = 'tenant-role-persistence-csrf-key-at-least-32-bytes';
const SESSION_ID = '86868686-8686-4686-8686-868686868686';
const SESSION_TOKEN = 'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS';
const TENANT_IDS = [TENANT_A, TENANT_B];

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function external(tenantReference, userReference, displayName) {
  return {
    provider: 'microsoft_entra',
    tenantReference,
    userReference,
    displayName,
  };
}

async function clean(pool) {
  await pool.query('DELETE FROM sessions WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM user_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
}

async function seedBinding(pool, {
  tenantId,
  bindingId,
  providerTenantReference,
  claimantProviderUserReference,
}) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, 'onboarding'],
  );
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
      id,
      tenant_id,
      provider,
      provider_tenant_reference,
      claimant_provider_user_reference,
      status,
      created_at,
      updated_at
    ) VALUES ($1, $2, 'microsoft_entra', $3, $4, 'active', $5, $5)`,
    [
      bindingId,
      tenantId,
      providerTenantReference,
      claimantProviderUserReference,
      '2026-08-24T15:00:00.000Z',
    ],
  );
}

function cookie(setCookie) {
  return setCookie.split(';', 1)[0];
}

test('tenant roles are claimant-bootstrapped, isolated, concurrent-safe and invalidate stale sessions', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const onboardingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  const jitRepository = createPostgresJitUserRepository(pool, { auditRepository });
  const roleRepository = createPostgresTenantUserAdminRepository(pool, { auditRepository });

  t.after(async () => {
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await clean(pool);
  await seedBinding(pool, {
    tenantId: TENANT_A,
    bindingId: BIND_A,
    providerTenantReference: PROVIDER_TENANT_A,
    claimantProviderUserReference: CLAIMANT_REFERENCE,
  });
  await seedBinding(pool, {
    tenantId: TENANT_B,
    bindingId: BIND_B,
    providerTenantReference: PROVIDER_TENANT_B,
    claimantProviderUserReference: null,
  });

  const ids = [ADMIN_A, USER_A, USER_B, REPEAT_CANDIDATE_ID];
  const jit = createJitUserService({
    bindingRepository: onboardingRepository,
    userRepository: jitRepository,
    auditService,
    clock: () => Date.parse('2026-08-24T15:30:00.000Z'),
    idFactory: () => ids.shift(),
  });
  const admin = await jit.resolve(
    external(PROVIDER_TENANT_A, CLAIMANT_REFERENCE, 'Customer Admin'),
    { correlationId: CORR_A },
  );
  assert.deepEqual(admin.trustedIdentity.roles, ['employee', 'tenant_admin']);
  assert.equal(admin.trustedIdentity.permissions.includes('tenant:users:manage'), true);

  const employee = await jit.resolve(
    external(PROVIDER_TENANT_A, USER_REFERENCE, 'Employee A'),
    { correlationId: CORR_A },
  );
  assert.deepEqual(employee.trustedIdentity.roles, ['employee']);

  const otherTenant = await jit.resolve(
    external(PROVIDER_TENANT_B, USER_REFERENCE, 'Employee B'),
    { correlationId: CORR_B },
  );
  assert.equal(otherTenant.trustedIdentity.tenantId, TENANT_B);
  assert.notEqual(otherTenant.trustedIdentity.userId, USER_A);

  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  const sessionService = createSessionService({
    repository: sessionRepository,
    auditService,
    publicOrigin: 'https://conference.example',
    csrfSecret: CSRF_KEY,
    clock: () => Date.parse('2026-08-24T15:35:00.000Z'),
    tokenFactory: () => SESSION_TOKEN,
    idFactory: () => SESSION_ID,
  });
  const issuedEmployee = await sessionService.issue(employee.trustedIdentity, { correlationId: CORR_A });
  const staleRequest = { headers: { cookie: cookie(issuedEmployee.setCookie) } };
  assert.ok(await sessionService.resolvePrincipal(staleRequest));

  const adminService = createTenantUserAdministrationService({
    repository: roleRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse('2026-08-24T15:40:00.000Z'),
  });
  const tenantContextA = { tenantId: TENANT_A, status: 'onboarding' };
  const promoted = await adminService.setRoles({
    principal: admin.trustedIdentity,
    tenantContext: tenantContextA,
    targetUserId: USER_A,
    roles: ['conference_manager', 'tenant_admin'],
    correlationId: CORR_A,
  });
  assert.deepEqual(promoted.roles, ['employee', 'conference_manager', 'tenant_admin']);
  assert.equal(await sessionService.resolvePrincipal(staleRequest), null);

  const repeated = await jit.resolve(
    external(PROVIDER_TENANT_A, USER_REFERENCE, 'Employee A'),
    { correlationId: CORR_A },
  );
  assert.deepEqual(repeated.trustedIdentity.roles, ['employee', 'conference_manager', 'tenant_admin']);
  assert.equal(repeated.trustedIdentity.permissions.includes('request:manage'), true);
  assert.equal(repeated.trustedIdentity.permissions.includes('tenant:users:manage'), true);

  const listed = await adminService.listUsers({
    principal: admin.trustedIdentity,
    tenantContext: tenantContextA,
    correlationId: CORR_A,
    limit: 100,
  });
  assert.equal(listed.some((user) => user.id === ADMIN_A), true);
  assert.equal(listed.some((user) => user.id === USER_A), true);
  assert.equal(listed.some((user) => user.id === USER_B), false);

  const crossTenant = await roleRepository.setElevatedRoles({
    tenantId: TENANT_A,
    targetUserId: USER_B,
    elevatedRoles: ['conference_manager'],
    changedAt: new Date('2026-08-24T15:45:00.000Z'),
    auditEventFor() {
      throw new Error('AUDIT_MUST_NOT_RUN_FOR_CROSS_TENANT_TARGET');
    },
  });
  assert.equal(crossTenant.status, 'not_found');

  const roleAuditEventFor = (targetId) => ({ previousElevatedRoles, nextElevatedRoles }) => {
    const state = (roles) => ({
      conferenceManager: roles.includes('conference_manager'),
      tenantAdmin: roles.includes('tenant_admin'),
    });
    return auditService.createActorEvent({
      tenantId: TENANT_A,
      actorUserId: ADMIN_A,
      correlationId: CORR_A,
      action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
      targetType: 'user',
      targetId,
      previousState: state(previousElevatedRoles),
      newState: state(nextElevatedRoles),
      outcome: AUDIT_OUTCOME.SUCCESS,
      metadata: { operation: 'concurrency_test' },
      retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
      occurredAt: '2026-08-24T15:50:00.000Z',
    });
  };

  const race = await Promise.all([
    roleRepository.setElevatedRoles({
      tenantId: TENANT_A,
      targetUserId: ADMIN_A,
      elevatedRoles: [],
      changedAt: new Date('2026-08-24T15:50:00.000Z'),
      auditEventFor: roleAuditEventFor(ADMIN_A),
    }),
    roleRepository.setElevatedRoles({
      tenantId: TENANT_A,
      targetUserId: USER_A,
      elevatedRoles: ['conference_manager'],
      changedAt: new Date('2026-08-24T15:50:00.000Z'),
      auditEventFor: roleAuditEventFor(USER_A),
    }),
  ]);
  assert.deepEqual(
    race.map((entry) => entry.status).sort(),
    ['last_tenant_admin', 'updated'],
  );

  const activeAdmins = await pool.query(
    `SELECT count(*)::int AS count
     FROM tenant_user_roles r
     JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
     WHERE r.tenant_id = $1 AND r.role = 'tenant_admin' AND u.active = true`,
    [TENANT_A],
  );
  assert.equal(activeAdmins.rows[0].count, 1);
  assert.equal(await auditRepository.verifyTenantChain(TENANT_A), true);

  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');
  assert.equal(await isPostgresSchemaReady(pool), true);
});
