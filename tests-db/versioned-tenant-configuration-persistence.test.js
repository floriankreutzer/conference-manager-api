import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import { TenantConfigurationConflictError } from '../src/domain/tenant-configuration/protocol.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresConfigurationRevisionStore } from '../src/persistence/postgres/configuration-revision-store.js';
import { createPostgresOrganizationConfigurationRepository } from '../src/persistence/postgres/organization-configuration-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '14141414-1414-4141-8141-141414141414';
const TENANT_B = '25252525-2525-4252-8252-252525252525';
const USER_A = '36363636-3636-4363-8363-363636363636';
const USER_B = '47474747-4747-4474-8474-474747474747';
const CORRELATION_ID = '58585858-5858-4585-8585-585858585858';
const AUDIT_SECRET = 'tenant-configuration-audit-secret-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function organization(displayName) {
  return {
    organization: {
      displayName,
      defaultLocale: 'de',
      currency: 'EUR',
      theme: { accent: 'bordeaux', logoAssetId: null },
    },
  };
}

function auditEvent({ tenantId, userId, previousRevision, nextRevision, occurredAt }) {
  return normalizeAuditEvent({
    tenantId,
    actorUserId: userId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_configuration',
    targetId: 'organization',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    occurredAt: occurredAt.toISOString(),
    correlationId: CORRELATION_ID,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { domain: 'organization', changeKind: 'update' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });
}

async function seed(pool) {
  await pool.query(
    `INSERT INTO tenants (id,display_name,status) VALUES
      ($1,'Tenant A','active'),($2,'Tenant B','active')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pool.query(
    `INSERT INTO users (tenant_id,id,display_name) VALUES
      ($1,$2,'Admin A'),($3,$4,'Admin B')
     ON CONFLICT (tenant_id,id) DO NOTHING`,
    [TENANT_A, USER_A, TENANT_B, USER_B],
  );
}

async function clean(pool) {
  await pool.query('ALTER TABLE tenant_configuration_revisions DISABLE TRIGGER tenant_configuration_revisions_immutable');
  await pool.query('DELETE FROM tenant_configuration_heads WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM tenant_configuration_revisions WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('ALTER TABLE tenant_configuration_revisions ENABLE TRIGGER tenant_configuration_revisions_immutable');
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
}

test('versioned configuration is atomic, tenant-isolated, immutable, and rollback-safe', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await seed(pool);

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_SECRET });
  const store = createPostgresConfigurationRevisionStore(pool, { auditRepository });
  const repository = createPostgresOrganizationConfigurationRepository(store);

  const initialA = await repository.current(TENANT_A);
  const initialB = await repository.current(TENANT_B);
  assert.equal(initialA.revision, 1);
  assert.equal(initialA.configuration.organization.displayName, 'Tenant A');
  assert.equal(initialB.configuration.organization.displayName, 'Tenant B');

  const changedAt = new Date('2026-08-26T20:30:00.000Z');
  const concurrentUpdates = await Promise.allSettled([
    repository.update({
      tenantId: TENANT_A,
      expectedRevision: 1,
      configuration: organization('Tenant A Updated Alpha'),
      actorUserId: USER_A,
      changedAt,
      auditEvent: auditEvent({ tenantId: TENANT_A, userId: USER_A, previousRevision: 1, nextRevision: 2, occurredAt: changedAt }),
    }),
    repository.update({
      tenantId: TENANT_A,
      expectedRevision: 1,
      configuration: organization('Tenant A Updated Beta'),
      actorUserId: USER_A,
      changedAt,
      auditEvent: auditEvent({ tenantId: TENANT_A, userId: USER_A, previousRevision: 1, nextRevision: 2, occurredAt: changedAt }),
    }),
  ]);
  const fulfilled = concurrentUpdates.filter((entry) => entry.status === 'fulfilled');
  const rejected = concurrentUpdates.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason instanceof TenantConfigurationConflictError, true);
  const updated = fulfilled[0].value;
  assert.equal(updated.revision, 2);
  assert.match(updated.configuration.organization.displayName, /^Tenant A Updated (Alpha|Beta)$/);
  assert.equal((await repository.current(TENANT_B)).revision, 1);

  await assert.rejects(
    pool.query(
      `UPDATE tenant_configuration_revisions SET payload = '{}'::jsonb
        WHERE tenant_id = $1 AND domain = 'organization' AND revision = 1`,
      [TENANT_A],
    ),
    (error) => error.code === '55000',
  );

  const rollbackAt = new Date('2026-08-26T20:31:00.000Z');
  const rolledBack = await repository.rollback({
    tenantId: TENANT_A,
    expectedRevision: 2,
    sourceRevision: 1,
    actorUserId: USER_A,
    changedAt: rollbackAt,
    auditEvent: auditEvent({ tenantId: TENANT_A, userId: USER_A, previousRevision: 2, nextRevision: 3, occurredAt: rollbackAt }),
  });
  assert.equal(rolledBack.revision, 3);
  assert.equal(rolledBack.sourceRevision, 1);
  assert.equal(rolledBack.configuration.organization.displayName, 'Tenant A');
  assert.equal((await auditRepository.listByTenantId(TENANT_A, { limit: 10 })).length, 2);

  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000' && error.message.includes('TENANT_CONFIGURATION_REVISIONS_REQUIRE_REVIEW'),
  );
  await clean(pool);
  assert.equal(await rollbackLatest(pool), true);
  const missing = await pool.query("SELECT to_regclass('public.tenant_configuration_revisions') AS relation");
  assert.equal(missing.rows[0].relation, null);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
