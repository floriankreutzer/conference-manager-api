import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../src/audit/event.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createJitUserService } from '../src/identity/jit-user-service.js';
import { createSessionService, SessionServiceError } from '../src/identity/session-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresJitUserRepository } from '../src/persistence/postgres/jit-user-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import {
  createPostgresTenantOnboardingRepository,
} from '../src/persistence/postgres/tenant-onboarding-repository.js';
import {
  createPostgresTenantUserAdminRepository,
} from '../src/persistence/postgres/tenant-user-admin-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_ID = '91919191-9191-4191-8191-919191919191';
const USER_ID = '92929292-9292-4292-8292-929292929292';
const BINDING_ID = '93939393-9393-4393-8393-939393939393';
const CORRELATION_INITIAL = '94949494-9494-4494-8494-949494949494';
const CORRELATION_GRANT = '95959595-9595-4595-8595-959595959595';
const CORRELATION_STALE = '96969696-9696-4696-8696-969696969696';
const CORRELATION_REVOKE = '97979797-9797-4797-8797-979797979797';
const CORRELATION_FRESH = '98989898-9898-4898-8898-989898989898';
const PROVIDER_TENANT_REFERENCE = '99999999-9999-4999-8999-999999999998';
const PROVIDER_USER_REFERENCE = '99999999-9999-4999-8999-999999999997';
const CANDIDATE_TWO = '99999999-9999-4999-8999-999999999996';
const CANDIDATE_THREE = '99999999-9999-4999-8999-999999999995';
const STALE_SESSION_ID = '99999999-9999-4999-8999-999999999994';
const FRESH_SESSION_ID = '99999999-9999-4999-8999-999999999993';
const STALE_TOKEN = 'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR';
const FRESH_TOKEN = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
const AUDIT_KEY = 'session-role-race-audit-key-at-least-32-bytes';
const CSRF_KEY = 'session-role-race-csrf-key-at-least-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM sessions WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM user_identity_bindings WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function seedTenantBinding(pool) {
  const createdAt = '2026-08-24T16:00:00.000Z';
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Session Race Tenant', 'active'],
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
    ) VALUES ($1, $2, 'microsoft_entra', $3, NULL, 'active', $4, $4)`,
    [BINDING_ID, TENANT_ID, PROVIDER_TENANT_REFERENCE, createdAt],
  );
}

function externalIdentity() {
  return {
    provider: 'microsoft_entra',
    tenantReference: PROVIDER_TENANT_REFERENCE,
    userReference: PROVIDER_USER_REFERENCE,
    displayName: 'Race Test User',
  };
}

function roleState(roles) {
  return {
    conferenceManager: roles.includes('conference_manager'),
    tenantAdmin: roles.includes('tenant_admin'),
  };
}

function roleAuditEventFor(auditService, correlationId, occurredAt) {
  return ({ previousElevatedRoles, nextElevatedRoles }) => auditService.createActorEvent({
    tenantId: TENANT_ID,
    actorUserId: USER_ID,
    correlationId,
    action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
    targetType: 'user',
    targetId: USER_ID,
    previousState: roleState(previousElevatedRoles),
    newState: roleState(nextElevatedRoles),
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'session_snapshot_race_test' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt,
  });
}

test('role changes between JIT resolution and session issuance reject stale privilege snapshots', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });

  t.after(async () => {
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await clean(pool);
  await seedTenantBinding(pool);

  const onboardingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  const jitRepository = createPostgresJitUserRepository(pool, { auditRepository });
  const roleRepository = createPostgresTenantUserAdminRepository(pool, { auditRepository });
  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  const candidateIds = [USER_ID, CANDIDATE_TWO, CANDIDATE_THREE];
  const jitService = createJitUserService({
    bindingRepository: onboardingRepository,
    userRepository: jitRepository,
    auditService,
    clock: () => Date.parse('2026-08-24T16:05:00.000Z'),
    idFactory: () => candidateIds.shift(),
  });

  const initial = await jitService.resolve(externalIdentity(), {
    correlationId: CORRELATION_INITIAL,
  });
  assert.deepEqual(initial.trustedIdentity.roles, ['employee']);
  assert.equal(initial.trustedIdentity.securityVersion, 1);

  const granted = await roleRepository.setElevatedRoles({
    tenantId: TENANT_ID,
    targetUserId: USER_ID,
    elevatedRoles: ['conference_manager'],
    changedAt: new Date('2026-08-24T16:10:00.000Z'),
    auditEventFor: roleAuditEventFor(
      auditService,
      CORRELATION_GRANT,
      '2026-08-24T16:10:00.000Z',
    ),
  });
  assert.equal(granted.status, 'updated');
  assert.equal(granted.user.securityVersion, 2);

  const staleResolution = await jitService.resolve(externalIdentity(), {
    correlationId: CORRELATION_STALE,
  });
  assert.deepEqual(staleResolution.trustedIdentity.roles, ['employee', 'conference_manager']);
  assert.equal(staleResolution.trustedIdentity.securityVersion, 2);

  const revoked = await roleRepository.setElevatedRoles({
    tenantId: TENANT_ID,
    targetUserId: USER_ID,
    elevatedRoles: [],
    changedAt: new Date('2026-08-24T16:15:00.000Z'),
    auditEventFor: roleAuditEventFor(
      auditService,
      CORRELATION_REVOKE,
      '2026-08-24T16:15:00.000Z',
    ),
  });
  assert.equal(revoked.status, 'updated');
  assert.equal(revoked.user.securityVersion, 3);

  const sessionIds = [STALE_SESSION_ID, FRESH_SESSION_ID];
  const sessionTokens = [STALE_TOKEN, FRESH_TOKEN];
  const sessionService = createSessionService({
    repository: sessionRepository,
    auditService,
    publicOrigin: 'https://conference.example',
    csrfSecret: CSRF_KEY,
    clock: () => Date.parse('2026-08-24T16:20:00.000Z'),
    idFactory: () => sessionIds.shift(),
    tokenFactory: () => sessionTokens.shift(),
  });

  await assert.rejects(
    sessionService.issue(staleResolution.trustedIdentity, {
      correlationId: CORRELATION_STALE,
    }),
    (error) => (
      error instanceof SessionServiceError
      && error.code === 'IDENTITY_NOT_PROVISIONED'
    ),
  );
  const staleSessions = await pool.query(
    'SELECT count(*)::int AS count FROM sessions WHERE tenant_id = $1',
    [TENANT_ID],
  );
  assert.equal(staleSessions.rows[0].count, 0);
  const staleAudit = await pool.query(
    `SELECT count(*)::int AS count
     FROM audit_events
     WHERE tenant_id = $1
       AND action = $2
       AND correlation_id = $3`,
    [TENANT_ID, AUDIT_ACTION.SESSION_ISSUED, CORRELATION_STALE],
  );
  assert.equal(staleAudit.rows[0].count, 0);

  const freshResolution = await jitService.resolve(externalIdentity(), {
    correlationId: CORRELATION_FRESH,
  });
  assert.deepEqual(freshResolution.trustedIdentity.roles, ['employee']);
  assert.equal(freshResolution.trustedIdentity.securityVersion, 3);

  const issued = await sessionService.issue(freshResolution.trustedIdentity, {
    correlationId: CORRELATION_FRESH,
  });
  assert.deepEqual(issued.principal.roles, ['employee']);
  assert.equal(issued.principal.session.securityVersion, 3);

  const persisted = await pool.query(
    `SELECT principal_version, roles, permissions
     FROM sessions
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, FRESH_SESSION_ID],
  );
  assert.equal(persisted.rowCount, 1);
  assert.equal(Number(persisted.rows[0].principal_version), 3);
  assert.deepEqual(persisted.rows[0].roles, ['employee']);
  assert.deepEqual(persisted.rows[0].permissions, ['request:read', 'request:cancel']);
  assert.equal(await auditRepository.verifyTenantChain(TENANT_ID), true);
});
