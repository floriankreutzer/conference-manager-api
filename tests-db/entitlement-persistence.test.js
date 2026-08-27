import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { CAPABILITY, ROLLOUT_STATE } from '../src/entitlements/capabilities.js';
import { createEntitlementService } from '../src/entitlements/entitlement-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresEntitlementRepository } from '../src/persistence/postgres/entitlement-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '12121212-1212-4212-8212-121212121212';
const TENANT_B = '13131313-1313-4313-8313-131313131313';
const CORRELATION_A = '14141414-1414-4414-8414-141414141414';
const CORRELATION_B = '15151515-1515-4515-8515-151515151515';
const AUDIT_KEY = 'entitlement-audit-key-at-least-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seedTenant(pool, tenantId, name) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenantId, name, 'active'],
  );
}

function serviceFor(repository, auditService, rolloutState = ROLLOUT_STATE.NOT_CONTROLLED) {
  return createEntitlementService({
    repository,
    auditService,
    authorizeOperator: async () => true,
    rolloutPolicy: { stateFor: () => rolloutState },
    clock: () => Date.parse('2026-08-24T10:30:00.000Z'),
  });
}

test('PostgreSQL entitlements are tenant-scoped, constrained, and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await removeSaas2TenantAdministrationFixtures(pool, [TENANT_A, TENANT_B]);
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    try {
      await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
    }
    await pool.query('DELETE FROM tenant_entitlements WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.end();
  });
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await seedTenant(pool, TENANT_A, 'Entitlement Tenant A');
  await seedTenant(pool, TENANT_B, 'Entitlement Tenant B');

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const repository = createPostgresEntitlementRepository(pool, { auditRepository });
  const service = serviceFor(repository, auditService);

  await t.test('same capability is isolated across tenants and absent means disabled', async () => {
    assert.equal(await repository.findByTenantIdAndCapabilityId(TENANT_A, CAPABILITY.MICROSOFT_DIRECTORY), null);
    await service.setEntitlement({
      operatorContext: { kind: 'platform-operator' },
      tenantId: TENANT_A,
      capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
      enabled: true,
      correlationId: CORRELATION_A,
    });
    assert.equal((await repository.findByTenantIdAndCapabilityId(TENANT_A, CAPABILITY.MICROSOFT_DIRECTORY)).enabled, true);
    assert.equal(await repository.findByTenantIdAndCapabilityId(TENANT_B, CAPABILITY.MICROSOFT_DIRECTORY), null);

    await service.setEntitlement({
      operatorContext: { kind: 'platform-operator' },
      tenantId: TENANT_B,
      capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
      enabled: true,
      correlationId: CORRELATION_B,
    });
    assert.equal((await repository.findByTenantIdAndCapabilityId(TENANT_B, CAPABILITY.MICROSOFT_DIRECTORY)).enabled, true);
  });

  await t.test('database rejects unknown capability identifiers', async () => {
    await assert.rejects(
      pool.query(
        'INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled) VALUES ($1, $2, $3)',
        [TENANT_A, 'unknown.capability', true],
      ),
      (error) => error.code === '23514',
    );
  });

  await t.test('effective access cannot be granted by rollout without entitlement', async () => {
    const rolloutEnabled = serviceFor(repository, auditService, ROLLOUT_STATE.ENABLED);
    assert.equal(await rolloutEnabled.evaluateAccess({
      principal: { tenantId: TENANT_A },
      tenantContext: { tenantId: TENANT_A, status: 'active' },
      capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
      authorized: true,
    }), false);

    await rolloutEnabled.setEntitlement({
      operatorContext: { kind: 'platform-operator' },
      tenantId: TENANT_A,
      capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
      enabled: true,
      correlationId: CORRELATION_A,
    });
    assert.equal(await rolloutEnabled.evaluateAccess({
      principal: { tenantId: TENANT_A },
      tenantContext: { tenantId: TENANT_A, status: 'active' },
      capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
      authorized: true,
    }), true);

    const rolloutDisabled = serviceFor(repository, auditService, ROLLOUT_STATE.DISABLED);
    assert.equal(await rolloutDisabled.evaluateAccess({
      principal: { tenantId: TENANT_A },
      tenantContext: { tenantId: TENANT_A, status: 'active' },
      capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
      authorized: true,
    }), false);
  });

  await t.test('entitlement mutation and audit event commit atomically', async () => {
    const events = await auditRepository.listByTenantId(TENANT_A, { limit: 100 });
    const change = events.find((entry) => entry.action === 'tenant.entitlement.changed');
    assert.ok(change);
    assert.equal(change.actorUserId, null);
    assert.equal(change.targetType, 'entitlement');
    assert.deepEqual(change.metadata, { actorType: 'platform_operator' });

    const failingAuditRepository = {
      async appendWithClient() {
        throw new Error('EXPECTED_AUDIT_FAILURE');
      },
    };
    const failingRepository = createPostgresEntitlementRepository(pool, {
      auditRepository: failingAuditRepository,
    });
    const failingService = serviceFor(failingRepository, auditService);
    await assert.rejects(
      failingService.setEntitlement({
        operatorContext: { kind: 'platform-operator' },
        tenantId: TENANT_B,
        capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
        enabled: true,
        correlationId: CORRELATION_B,
      }),
      /EXPECTED_AUDIT_FAILURE/,
    );
    assert.equal(await repository.findByTenantIdAndCapabilityId(TENANT_B, CAPABILITY.MICROSOFT_CALENDAR), null);
  });
});
