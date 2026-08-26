import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { CAPABILITY } from '../src/entitlements/capabilities.js';
import { createEntitlementService } from '../src/entitlements/entitlement-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresEntitlementRepository } from '../src/persistence/postgres/entitlement-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CORRELATION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const AUDIT_KEY = 'entitlement-migration-audit-key-at-least-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('entitlement migration rollback fails closed when state or evidence exists', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    try {
      await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [TENANT_ID]);
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
    }
    await pool.query('DELETE FROM tenant_entitlements WHERE tenant_id = $1', [TENANT_ID]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await pool.end();
  });

  await migrateUp(pool);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Entitlement Rollback Tenant', 'active'],
  );

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const repository = createPostgresEntitlementRepository(pool, { auditRepository });
  const service = createEntitlementService({
    repository,
    auditService,
    authorizeOperator: async () => true,
    clock: () => Date.parse('2026-08-24T10:45:00.000Z'),
  });

  await service.setEntitlement({
    operatorContext: { kind: 'platform-operator' },
    tenantId: TENANT_ID,
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    enabled: true,
    correlationId: CORRELATION_ID,
  });

  for (let version = 16; version >= 6; version -= 1) {
    assert.equal(await rollbackLatest(pool), true);
    assert.equal(await isPostgresSchemaReady(pool), false);
  }
  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');
  assert.equal(await isPostgresSchemaReady(pool), false);
  const stored = await repository.findByTenantIdAndCapabilityId(
    TENANT_ID,
    CAPABILITY.MICROSOFT_DIRECTORY,
  );
  assert.equal(stored.enabled, true);

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
