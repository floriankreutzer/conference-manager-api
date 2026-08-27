import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { AUDIT_ACTION } from '../src/audit/event.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_ID = '67676767-6767-4676-8676-676767676767';
const CORRELATION_ID = '68686868-6868-4686-8686-686868686868';
const AUDIT_KEY = 'p'.repeat(32);
const MIGRATION_VERSION = 16;

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('Tenant pilot lifecycle change is optimistic, audit-atomic, and rollback-protected', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await removeSaas2TenantAdministrationFixtures(pool, [TENANT_ID]);
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    try {
      await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [TENANT_ID]);
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'Pilot Lifecycle Tenant', 'onboarding'],
  );

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const repository = createPostgresTenantRepository(pool, { auditRepository });
  const changedAt = new Date(Date.now() + 60_000);
  const auditEvent = auditService.createActorEvent({
    tenantId: TENANT_ID,
    actorUserId: null,
    correlationId: CORRELATION_ID,
    action: AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED,
    targetType: 'tenant',
    targetId: TENANT_ID,
    previousState: { status: 'onboarding' },
    newState: { status: 'ready' },
    outcome: 'success',
    metadata: { actorType: 'platform_operator' },
    retentionClass: 'administrative',
    occurredAt: changedAt.toISOString(),
  });

  const changed = await repository.changeStatus({
    tenantId: TENANT_ID,
    expectedStatus: 'onboarding',
    targetStatus: 'ready',
    changedAt,
    auditEvent,
  });
  assert.equal(changed.status, 'ready');
  assert.equal((await auditRepository.listByTenantId(TENANT_ID))[0].action, 'tenant.lifecycle.changed');

  assert.equal(await repository.changeStatus({
    tenantId: TENANT_ID,
    expectedStatus: 'onboarding',
    targetStatus: 'active',
    changedAt,
    auditEvent,
  }), null);

  await assert.rejects(
    rollbackToVersion(pool, MIGRATION_VERSION),
    (error) => error.code === '55000'
      && error.message.includes('TENANT_LIFECYCLE_AUDIT_ROWS_REQUIRE_REVIEW'),
  );
});
