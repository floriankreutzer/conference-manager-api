import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { AuditIntegrityError } from '../src/audit/errors.js';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../src/audit/event.js';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  createPostgresTenantAuditQueryRepository,
} from '../src/persistence/postgres/tenant-audit-query-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '12121212-1212-4212-8212-121212121212';
const TENANT_B = '23232323-2323-4232-8232-232323232323';
const USER_A = '34343434-3434-4434-8434-343434343434';
const USER_B = '45454545-4545-4454-8454-454545454545';
const CORRELATION_A = '56565656-5656-4656-8656-565656565656';
const CORRELATION_B = '67676767-6767-4676-8676-676767676767';
const AUDIT_KEY = 'tenant-audit-query-persistence-key-at-least-32-bytes';
const TENANT_IDS = [TENANT_A, TENANT_B];
const NOW = Date.parse('2026-08-27T11:00:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, TENANT_IDS);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
}

function event({
  tenantId,
  actorUserId,
  correlationId,
  action,
  occurredAt,
  outcome,
  targetType = action.startsWith('integration.') ? 'integration' : 'user',
  targetId = action.startsWith('integration.') ? 'microsoft365' : actorUserId,
  previousState = null,
  newState = { status: outcome === 'success' ? 'connected' : 'denied' },
  metadata = {},
  retentionClass = AUDIT_RETENTION_CLASS.SECURITY,
}) {
  return {
    tenantId,
    actorUserId,
    correlationId,
    action,
    targetType,
    targetId,
    previousState,
    newState,
    occurredAt,
    outcome,
    metadata,
    retentionClass,
  };
}

test('bounded audit query SQL preserves Tenant, actor, time, action and cursor scope', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await pool.query(
    `INSERT INTO tenants (id, display_name, status) VALUES
      ($1, 'Audit Tenant A', 'active'),
      ($2, 'Audit Tenant B', 'active')`,
    [TENANT_A, TENANT_B],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, active) VALUES
      ($1, $2, 'Auditor A', true),
      ($3, $4, 'Auditor B', true)`,
    [TENANT_A, USER_A, TENANT_B, USER_B],
  );
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy,
    clock: () => NOW,
    correlationFactory: () => CORRELATION_A,
  });
  await auditRepository.append(event({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    correlationId: CORRELATION_A,
    action: AUDIT_ACTION.INTEGRATION_CONNECTED,
    occurredAt: '2026-08-27T09:00:00.000Z',
    outcome: AUDIT_OUTCOME.SUCCESS,
  }));
  await auditRepository.append(event({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    correlationId: CORRELATION_A,
    action: AUDIT_ACTION.AUTHORIZATION_DENIED,
    occurredAt: '2026-08-27T10:00:00.000Z',
    outcome: AUDIT_OUTCOME.DENIED,
  }));
  const configurationEvent = await auditRepository.append(event({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    correlationId: CORRELATION_A,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'catalogue',
    targetId: 'tenant-catalogue',
    previousState: { revision: 3 },
    newState: { revision: 4 },
    occurredAt: '2026-08-27T10:30:00.000Z',
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      activeServiceCount: 3,
      internalReason: 'must-not-pass',
      operation: 'update',
      serviceCount: 4,
    },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  }));
  await auditRepository.append(event({
    tenantId: TENANT_B,
    actorUserId: USER_B,
    correlationId: CORRELATION_B,
    action: AUDIT_ACTION.INTEGRATION_CONNECTED,
    occurredAt: '2026-08-27T09:30:00.000Z',
    outcome: AUDIT_OUTCOME.SUCCESS,
  }));

  const query = createPostgresTenantAuditQueryRepository(pool);
  const rows = await query.listByTenantId({
    tenantId: TENANT_A,
    limit: 10,
    categoryActions: [AUDIT_ACTION.INTEGRATION_CONNECTED],
    outcome: AUDIT_OUTCOME.SUCCESS,
    actorUserId: USER_A,
    from: '2026-08-27T08:00:00.000Z',
    to: '2026-08-27T11:00:00.000Z',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, TENANT_A);
  assert.equal(rows[0].action, AUDIT_ACTION.INTEGRATION_CONNECTED);

  const before = await query.listByTenantId({
    tenantId: TENANT_A,
    limit: 10,
    beforeId: rows[0].id,
    categoryActions: null,
    outcome: null,
    actorUserId: null,
    from: '2026-08-27T08:00:00.000Z',
    to: '2026-08-27T11:00:00.000Z',
  });
  assert.equal(before.length, 0);

  const queryService = createTenantAuditQueryService({
    queryRepository: query,
    integrityRepository: auditRepository,
    authorizationPolicy,
    auditService,
    clock: () => NOW,
  });
  const listValues = {
    principal: {
      userId: USER_A,
      tenantId: TENANT_A,
      roles: ['tenant_admin'],
      permissions: ['tenant:audit:read'],
    },
    tenantContext: { tenantId: TENANT_A, status: 'active' },
    correlationId: CORRELATION_A,
    category: 'configuration',
    from: '2026-08-27T08:00:00.000Z',
    to: '2026-08-27T11:00:00.000Z',
  };
  const page = await queryService.listEvents(listValues);
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0].change, {
    before: { revision: 3 },
    after: { revision: 4 },
    summary: { activeServiceCount: 3, serviceCount: 4 },
  });
  assert.equal(Object.hasOwn(page.events[0], 'metadata'), false);
  assert.equal(Object.hasOwn(page.events[0], 'eventHash'), false);
  assert.equal(JSON.stringify(page.events[0]).includes('must-not-pass'), false);

  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query(
      'UPDATE audit_events SET metadata = $1::jsonb WHERE tenant_id = $2 AND id = $3',
      [JSON.stringify({ serviceCount: 999 }), TENANT_A, configurationEvent.id],
    );
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  assert.equal(await auditRepository.verifyTenantChain(TENANT_A), false);
  await assert.rejects(queryService.listEvents(listValues), AuditIntegrityError);
});
