import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { ENTRA_IDENTITY_PROVIDER } from '../src/identity/entra-client.js';
import { readTenantClaimCookie } from '../src/onboarding/claim-cookie.js';
import { OnboardingDeniedError } from '../src/onboarding/errors.js';
import { createTenantOnboardingService } from '../src/onboarding/tenant-onboarding-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantOnboardingRepository } from '../src/persistence/postgres/tenant-onboarding-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0';
const TENANT_B = 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0';
const TENANT_C = 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0';
const TENANT_D = 'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0';
const TENANT_E = 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0';
const TENANT_F = 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0';
const INV_A = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const INV_B = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1';
const INV_C = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
const INV_D = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1';
const INV_E = 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
const INV_F = 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
const BIND_A = 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2';
const BIND_B = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const BIND_E1 = 'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2';
const BIND_E2 = 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3';
const BIND_F = 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2';
const CORR_A = '01010101-0101-4101-8101-010101010101';
const CORR_B = '02020202-0202-4202-8202-020202020202';
const CORR_C = '03030303-0303-4303-8303-030303030303';
const CORR_D = '04040404-0404-4404-8404-040404040404';
const CORR_E = '05050505-0505-4505-8505-050505050505';
const CORR_F = '06060606-0606-4606-8606-060606060606';
const PROVIDER_TENANT_A = '11111111-1111-4111-8111-111111111111';
const PROVIDER_TENANT_B = '22222222-2222-4222-8222-222222222222';
const PROVIDER_TENANT_E1 = '33333333-3333-4333-8333-333333333333';
const PROVIDER_TENANT_E2 = '44444444-4444-4444-8444-444444444444';
const PROVIDER_TENANT_F = '55555555-5555-4555-8555-555555555555';
const PROVIDER_USER = '66666666-6666-4666-8666-666666666666';
const AUDIT_KEY = 'tenant-onboarding-persistence-audit-key-at-least-32-bytes';
const SECRET = 'tenant-onboarding-persistence-secret-at-least-32-bytes';
let nowMs = Date.parse('2026-08-24T12:00:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function externalIdentity(tenantReference, displayName = 'Customer Admin') {
  return {
    provider: ENTRA_IDENTITY_PROVIDER,
    tenantReference,
    userReference: PROVIDER_USER,
    displayName,
  };
}

function onboardingService({
  repository,
  auditService,
  tenantId,
  invitationId,
  bindingIds,
  tokens,
}) {
  const ids = [tenantId, invitationId, ...bindingIds];
  const tokenValues = [...tokens];
  return createTenantOnboardingService({
    repository,
    auditService,
    authorizeOperator: async () => true,
    transactionSecret: SECRET,
    publicOrigin: 'https://app.example.com',
    clock: () => nowMs,
    randomId: () => ids.shift(),
    randomToken: () => tokenValues.shift(),
  });
}

async function cleanup(pool) {
  const tenantIds = [TENANT_A, TENANT_B, TENANT_C, TENANT_D, TENANT_E, TENANT_F];
  await pool.query('DELETE FROM tenant_claim_transactions');
  await pool.query('DELETE FROM oidc_auth_transactions');
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await pool.query('DELETE FROM tenant_onboarding_invitations WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
}

async function createAndClaim({
  service,
  displayName,
  correlationId,
  providerTenantReference,
  invitationToken,
}) {
  const invitation = await service.createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName,
    correlationId,
  });
  assert.equal(invitation.invitationToken, invitationToken);
  const started = await service.beginInvitation({ invitationToken });
  const prepared = await service.prepareClaim({
    invitationId: started.invitationId,
    externalIdentity: externalIdentity(providerTenantReference),
    correlationId,
  });
  const claimToken = readTenantClaimCookie({ cookie: prepared.setCookie });
  const status = await service.claimStatus({ claimToken });
  const confirmed = await service.confirmClaim({
    claimToken,
    csrfToken: status.csrfToken,
    correlationId,
  });
  return { invitation, claimToken, confirmed };
}

test('tenant onboarding is isolated, single-use, conflict-safe, concurrent and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const repository = createPostgresTenantOnboardingRepository(pool, { auditRepository });
  t.after(async () => {
    await cleanup(pool);
    await pool.end();
  });
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await cleanup(pool);

  const serviceA = onboardingService({
    repository,
    auditService,
    tenantId: TENANT_A,
    invitationId: INV_A,
    bindingIds: [BIND_A],
    tokens: ['A'.repeat(43), 'a'.repeat(43)],
  });
  const serviceB = onboardingService({
    repository,
    auditService,
    tenantId: TENANT_B,
    invitationId: INV_B,
    bindingIds: [BIND_B],
    tokens: ['B'.repeat(43), 'b'.repeat(43)],
  });

  const claimedA = await createAndClaim({
    service: serviceA,
    displayName: 'Tenant A',
    correlationId: CORR_A,
    providerTenantReference: PROVIDER_TENANT_A,
    invitationToken: 'A'.repeat(43),
  });
  const claimedB = await createAndClaim({
    service: serviceB,
    displayName: 'Tenant B',
    correlationId: CORR_B,
    providerTenantReference: PROVIDER_TENANT_B,
    invitationToken: 'B'.repeat(43),
  });
  assert.equal(claimedA.confirmed.tenantId, TENANT_A);
  assert.equal(claimedB.confirmed.tenantId, TENANT_B);

  const tenants = await pool.query(
    'SELECT id, status FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY id',
    [[TENANT_A, TENANT_B]],
  );
  assert.deepEqual(tenants.rows, [
    { id: TENANT_A, status: 'onboarding' },
    { id: TENANT_B, status: 'onboarding' },
  ]);
  const bindings = await pool.query(
    `SELECT tenant_id, provider_tenant_reference, status
     FROM tenant_identity_bindings
     WHERE tenant_id = ANY($1::uuid[])
     ORDER BY tenant_id`,
    [[TENANT_A, TENANT_B]],
  );
  assert.deepEqual(bindings.rows, [
    {
      tenant_id: TENANT_A,
      provider_tenant_reference: PROVIDER_TENANT_A,
      status: 'active',
    },
    {
      tenant_id: TENANT_B,
      provider_tenant_reference: PROVIDER_TENANT_B,
      status: 'active',
    },
  ]);
  assert.equal(await auditRepository.verifyTenantChain(TENANT_A), true);
  assert.equal(await auditRepository.verifyTenantChain(TENANT_B), true);
  const auditA = await auditRepository.listByTenantId(TENANT_A, { limit: 10 });
  assert.deepEqual(auditA.map((entry) => entry.action).sort(), [
    'tenant.identity.claimed',
    'tenant.onboarding.invited',
  ]);
  assert.equal(JSON.stringify(auditA).includes(PROVIDER_TENANT_A), false);

  await assert.rejects(
    serviceA.beginInvitation({ invitationToken: 'A'.repeat(43) }),
    (error) => error instanceof OnboardingDeniedError,
  );
  await assert.rejects(
    serviceA.confirmClaim({
      claimToken: claimedA.claimToken,
      csrfToken: 'S'.repeat(43),
      correlationId: CORR_A,
    }),
    (error) => error instanceof OnboardingDeniedError,
  );

  const serviceC = onboardingService({
    repository,
    auditService,
    tenantId: TENANT_C,
    invitationId: INV_C,
    bindingIds: [],
    tokens: ['D'.repeat(43), 'd'.repeat(43)],
  });
  await serviceC.createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName: 'Tenant C',
    correlationId: CORR_C,
  });
  const inviteC = await serviceC.beginInvitation({ invitationToken: 'D'.repeat(43) });
  await assert.rejects(
    serviceC.prepareClaim({
      invitationId: inviteC.invitationId,
      externalIdentity: externalIdentity(PROVIDER_TENANT_A),
      correlationId: CORR_C,
    }),
    (error) => error instanceof OnboardingDeniedError,
  );

  const serviceD = onboardingService({
    repository,
    auditService,
    tenantId: TENANT_D,
    invitationId: INV_D,
    bindingIds: [],
    tokens: ['E'.repeat(43)],
  });
  await serviceD.createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName: 'Tenant D',
    correlationId: CORR_D,
  });
  await pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [TENANT_D, 'suspended']);
  await assert.rejects(
    serviceD.beginInvitation({ invitationToken: 'E'.repeat(43) }),
    (error) => error instanceof OnboardingDeniedError,
  );

  const serviceE = onboardingService({
    repository,
    auditService,
    tenantId: TENANT_E,
    invitationId: INV_E,
    bindingIds: [BIND_E1, BIND_E2],
    tokens: ['F'.repeat(43), 'f'.repeat(43), 'G'.repeat(43)],
  });
  await serviceE.createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName: 'Tenant E',
    correlationId: CORR_E,
  });
  const inviteE = await serviceE.beginInvitation({ invitationToken: 'F'.repeat(43) });
  const preparedE1 = await serviceE.prepareClaim({
    invitationId: inviteE.invitationId,
    externalIdentity: externalIdentity(PROVIDER_TENANT_E1, 'Admin E1'),
    correlationId: CORR_E,
  });
  const preparedE2 = await serviceE.prepareClaim({
    invitationId: inviteE.invitationId,
    externalIdentity: externalIdentity(PROVIDER_TENANT_E2, 'Admin E2'),
    correlationId: CORR_E,
  });
  const claimE1 = readTenantClaimCookie({ cookie: preparedE1.setCookie });
  const claimE2 = readTenantClaimCookie({ cookie: preparedE2.setCookie });
  const statusE1 = await serviceE.claimStatus({ claimToken: claimE1 });
  const statusE2 = await serviceE.claimStatus({ claimToken: claimE2 });
  const concurrent = await Promise.allSettled([
    serviceE.confirmClaim({ claimToken: claimE1, csrfToken: statusE1.csrfToken, correlationId: CORR_E }),
    serviceE.confirmClaim({ claimToken: claimE2, csrfToken: statusE2.csrfToken, correlationId: CORR_E }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
  const activeE = await pool.query(
    "SELECT count(*)::int AS count FROM tenant_identity_bindings WHERE tenant_id = $1 AND status = 'active'",
    [TENANT_E],
  );
  assert.equal(activeE.rows[0].count, 1);

  const serviceF = onboardingService({
    repository,
    auditService,
    tenantId: TENANT_F,
    invitationId: INV_F,
    bindingIds: [],
    tokens: ['H'.repeat(43), 'h'.repeat(43)],
  });
  await serviceF.createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName: 'Tenant F',
    correlationId: CORR_F,
  });
  const inviteF = await serviceF.beginInvitation({ invitationToken: 'H'.repeat(43) });
  const preparedF = await serviceF.prepareClaim({
    invitationId: inviteF.invitationId,
    externalIdentity: externalIdentity(PROVIDER_TENANT_F),
    correlationId: CORR_F,
  });
  const claimF = readTenantClaimCookie({ cookie: preparedF.setCookie });
  const statusF = await serviceF.claimStatus({ claimToken: claimF });
  const failingRepository = createPostgresTenantOnboardingRepository(pool, {
    auditRepository: {
      async appendWithClient() {
        throw new Error('EXPECTED_AUDIT_FAILURE');
      },
    },
  });
  const failingService = createTenantOnboardingService({
    repository: failingRepository,
    auditService,
    authorizeOperator: async () => true,
    transactionSecret: SECRET,
    publicOrigin: 'https://app.example.com',
    clock: () => nowMs,
    randomId: () => BIND_F,
  });
  await assert.rejects(
    failingService.confirmClaim({ claimToken: claimF, csrfToken: statusF.csrfToken, correlationId: CORR_F }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  const rollbackF = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM tenant_claim_transactions WHERE invitation_id = $1) AS claim_count,
       (SELECT count(*)::int FROM tenant_identity_bindings WHERE tenant_id = $2) AS binding_count,
       (SELECT consumed_at FROM tenant_onboarding_invitations WHERE id = $1) AS consumed_at,
       (SELECT status FROM tenants WHERE id = $2) AS tenant_status`,
    [INV_F, TENANT_F],
  );
  assert.equal(rollbackF.rows[0].claim_count, 1);
  assert.equal(rollbackF.rows[0].binding_count, 0);
  assert.equal(rollbackF.rows[0].consumed_at, null);
  assert.equal(rollbackF.rows[0].tenant_status, 'pending');
});
