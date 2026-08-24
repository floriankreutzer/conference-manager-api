import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { ENTRA_IDENTITY_PROVIDER } from '../src/identity/entra-client.js';
import { createJitUserService } from '../src/identity/jit-user-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresJitUserRepository } from '../src/persistence/postgres/jit-user-repository.js';
import {
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import {
  createPostgresTenantOnboardingRepository,
} from '../src/persistence/postgres/tenant-onboarding-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '10101010-1010-4010-8010-101010101010';
const TENANT_B = '20202020-2020-4020-8020-202020202020';
const TENANT_C = '30303030-3030-4030-8030-303030303030';
const TENANT_D = '40404040-4040-4040-8040-404040404040';
const TENANT_E = '50505050-5050-4050-8050-505050505050';
const BIND_A = '11111111-aaaa-4111-8111-111111111111';
const BIND_B = '22222222-bbbb-4222-8222-222222222222';
const BIND_C1 = '33333333-cccc-4333-8333-333333333333';
const BIND_C2 = '34343434-cdcd-4434-8434-343434343434';
const BIND_D = '44444444-dddd-4444-8444-444444444444';
const BIND_E = '55555555-eeee-4555-8555-555555555555';
const USER_A1 = '61616161-6161-4161-8161-616161616161';
const USER_A2 = '62626262-6262-4262-8262-626262626262';
const USER_B = '63636363-6363-4363-8363-636363636363';
const USER_C1 = '64646464-6464-4464-8464-646464646464';
const USER_C2 = '65656565-6565-4565-8565-656565656565';
const USER_D = '66666666-6666-4666-8666-666666666666';
const USER_E = '67676767-6767-4767-8767-676767676767';
const CORR_A = '71717171-7171-4171-8171-717171717171';
const CORR_B = '72727272-7272-4272-8272-727272727272';
const CORR_C = '73737373-7373-4373-8373-737373737373';
const CORR_D = '74747474-7474-4474-8474-747474747474';
const CORR_E = '75757575-7575-4575-8575-757575757575';
const PROVIDER_TENANT_A = '81818181-8181-4181-8181-818181818181';
const PROVIDER_TENANT_B = '82828282-8282-4282-8282-828282828282';
const PROVIDER_TENANT_C1 = '83838383-8383-4383-8383-838383838383';
const PROVIDER_TENANT_C2 = '84848484-8484-4484-8484-848484848484';
const PROVIDER_TENANT_D = '85858585-8585-4585-8585-858585858585';
const PROVIDER_TENANT_E = '86868686-8686-4686-8686-868686868686';
const PROVIDER_USER_SHARED = '91919191-9191-4191-8191-919191919191';
const PROVIDER_USER_C = '92929292-9292-4292-8292-929292929292';
const PROVIDER_USER_D = '93939393-9393-4393-8393-939393939393';
const PROVIDER_USER_E = '94949494-9494-4494-8494-949494949494';
const AUDIT_KEY = 'jit-user-persistence-audit-key-at-least-32-bytes';
const TENANT_IDS = [TENANT_A, TENANT_B, TENANT_C, TENANT_D, TENANT_E];

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function external(tenantReference, userReference, displayName = 'Pilot User') {
  return {
    provider: ENTRA_IDENTITY_PROVIDER,
    tenantReference,
    userReference,
    displayName,
  };
}

async function seedTenantBinding(pool, {
  tenantId,
  bindingId,
  providerTenantReference,
  status = 'active',
}) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, status],
  );
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
       id, tenant_id, provider, provider_tenant_reference, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [
      bindingId,
      tenantId,
      ENTRA_IDENTITY_PROVIDER,
      providerTenantReference,
      '2026-08-24T14:00:00.000Z',
    ],
  );
}

function jitService({ repository, bindingRepository, auditService, userIds, correlationClock } = {}) {
  const ids = [...userIds];
  let idIndex = 0;
  return createJitUserService({
    bindingRepository,
    userRepository: repository,
    auditService,
    clock: () => correlationClock ?? Date.parse('2026-08-24T14:30:00.000Z'),
    idFactory: () => ids[Math.min(idIndex++, ids.length - 1)],
  });
}

async function cleanup(pool) {
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

test('JIT provisioning is tenant-isolated, deterministic, concurrent-safe and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const repository = createPostgresJitUserRepository(pool, { auditRepository });
  const bindingRepository = createPostgresTenantOnboardingRepository(pool, { auditRepository });

  t.after(async () => {
    await cleanup(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await cleanup(pool);

  await seedTenantBinding(pool, {
    tenantId: TENANT_A,
    bindingId: BIND_A,
    providerTenantReference: PROVIDER_TENANT_A,
  });
  await seedTenantBinding(pool, {
    tenantId: TENANT_B,
    bindingId: BIND_B,
    providerTenantReference: PROVIDER_TENANT_B,
  });

  const serviceA = jitService({
    repository,
    bindingRepository,
    auditService,
    userIds: [USER_A1, USER_A2, '68686868-6868-4868-8868-686868686868'],
  });
  const identityA = external(PROVIDER_TENANT_A, PROVIDER_USER_SHARED);
  const concurrent = await Promise.all([
    serviceA.resolve(identityA, { correlationId: CORR_A }),
    serviceA.resolve(identityA, { correlationId: CORR_A }),
  ]);
  assert.equal(concurrent.every((entry) => entry.status === 'authenticated'), true);
  const resolvedUserA = concurrent[0].trustedIdentity.userId;
  assert.equal(concurrent[1].trustedIdentity.userId, resolvedUserA);
  assert.equal([USER_A1, USER_A2].includes(resolvedUserA), true);
  assert.deepEqual(concurrent[0].trustedIdentity.roles, ['employee']);
  assert.deepEqual(concurrent[0].trustedIdentity.permissions, ['request:read', 'request:cancel']);

  const aRows = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM users WHERE tenant_id = $1) AS user_count,
       (SELECT count(*)::int FROM user_identity_bindings WHERE tenant_id = $1) AS binding_count`,
    [TENANT_A],
  );
  assert.equal(aRows.rows[0].user_count, 1);
  assert.equal(aRows.rows[0].binding_count, 1);

  const repeated = await serviceA.resolve(identityA, { correlationId: CORR_A });
  assert.equal(repeated.trustedIdentity.userId, resolvedUserA);
  const provisionAudit = (await auditRepository.listByTenantId(TENANT_A, { limit: 20 }))
    .filter((entry) => entry.action === 'tenant.user.provisioned');
  assert.equal(provisionAudit.length, 1);
  assert.equal(await auditRepository.verifyTenantChain(TENANT_A), true);

  const changed = await serviceA.resolve(
    external(PROVIDER_TENANT_A, PROVIDER_USER_SHARED, 'Pilot User Renamed'),
    { correlationId: CORR_A },
  );
  assert.equal(changed.trustedIdentity.userId, resolvedUserA);
  const profile = await pool.query(
    'SELECT display_name, security_version::int AS security_version FROM users WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, resolvedUserA],
  );
  assert.deepEqual(profile.rows[0], { display_name: 'Pilot User Renamed', security_version: 1 });
  const profileAudit = (await auditRepository.listByTenantId(TENANT_A, { limit: 20 }))
    .find((entry) => entry.action === 'tenant.user.profile_updated');
  assert.ok(profileAudit);
  assert.equal(JSON.stringify(profileAudit).includes('Pilot User Renamed'), false);

  const serviceB = jitService({
    repository,
    bindingRepository,
    auditService,
    userIds: [USER_B],
  });
  const resolvedB = await serviceB.resolve(
    external(PROVIDER_TENANT_B, PROVIDER_USER_SHARED),
    { correlationId: CORR_B },
  );
  assert.equal(resolvedB.status, 'authenticated');
  assert.equal(resolvedB.trustedIdentity.userId, USER_B);
  assert.equal(resolvedB.trustedIdentity.tenantId, TENANT_B);
  assert.notEqual(resolvedB.trustedIdentity.userId, resolvedUserA);

  await pool.query(
    'UPDATE users SET active = false, updated_at = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, resolvedUserA, '2026-08-24T14:40:00.000Z'],
  );
  assert.deepEqual(await serviceA.resolve(identityA, { correlationId: CORR_A }), {
    status: 'authentication_denied',
  });

  await seedTenantBinding(pool, {
    tenantId: TENANT_C,
    bindingId: BIND_C1,
    providerTenantReference: PROVIDER_TENANT_C1,
  });
  const serviceC = jitService({
    repository,
    bindingRepository,
    auditService,
    userIds: [USER_C1, USER_C2],
  });
  const firstC = await serviceC.resolve(
    external(PROVIDER_TENANT_C1, PROVIDER_USER_C),
    { correlationId: CORR_C },
  );
  assert.equal(firstC.trustedIdentity.userId, USER_C1);
  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'unbound', updated_at = $2
     WHERE id = $1`,
    [BIND_C1, '2026-08-24T14:45:00.000Z'],
  );
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
       id, tenant_id, provider, provider_tenant_reference, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [
      BIND_C2,
      TENANT_C,
      ENTRA_IDENTITY_PROVIDER,
      PROVIDER_TENANT_C2,
      '2026-08-24T14:46:00.000Z',
    ],
  );
  assert.deepEqual(await serviceC.resolve(
    external(PROVIDER_TENANT_C1, PROVIDER_USER_C),
    { correlationId: CORR_C },
  ), { status: 'onboarding_required' });
  const rebound = await serviceC.resolve(
    external(PROVIDER_TENANT_C2, PROVIDER_USER_C),
    { correlationId: CORR_C },
  );
  assert.equal(rebound.trustedIdentity.userId, USER_C2);
  assert.notEqual(rebound.trustedIdentity.userId, USER_C1);

  await seedTenantBinding(pool, {
    tenantId: TENANT_D,
    bindingId: BIND_D,
    providerTenantReference: PROVIDER_TENANT_D,
    status: 'suspended',
  });
  const serviceD = jitService({
    repository,
    bindingRepository,
    auditService,
    userIds: [USER_D],
  });
  assert.deepEqual(await serviceD.resolve(
    external(PROVIDER_TENANT_D, PROVIDER_USER_D),
    { correlationId: CORR_D },
  ), { status: 'authentication_denied' });
  const dUsers = await pool.query('SELECT count(*)::int AS count FROM users WHERE tenant_id = $1', [TENANT_D]);
  assert.equal(dUsers.rows[0].count, 0);

  await seedTenantBinding(pool, {
    tenantId: TENANT_E,
    bindingId: BIND_E,
    providerTenantReference: PROVIDER_TENANT_E,
  });
  const failingRepository = createPostgresJitUserRepository(pool, {
    auditRepository: {
      async appendWithClient() {
        throw new Error('EXPECTED_AUDIT_FAILURE');
      },
    },
  });
  const serviceE = jitService({
    repository: failingRepository,
    bindingRepository,
    auditService,
    userIds: [USER_E],
  });
  await assert.rejects(
    serviceE.resolve(external(PROVIDER_TENANT_E, PROVIDER_USER_E), { correlationId: CORR_E }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  const rollbackRows = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM users WHERE tenant_id = $1) AS user_count,
       (SELECT count(*)::int FROM user_identity_bindings WHERE tenant_id = $1) AS binding_count`,
    [TENANT_E],
  );
  assert.deepEqual(rollbackRows.rows[0], { user_count: 0, binding_count: 0 });

  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');
  await cleanup(pool);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  const dropped = await pool.query("SELECT to_regclass('public.user_identity_bindings') AS relation");
  assert.equal(dropped.rows[0].relation, null);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});