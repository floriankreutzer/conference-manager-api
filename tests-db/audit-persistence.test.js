import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CORRELATION_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CORRELATION_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const AUDIT_SECRET = 'audit-integration-secret-at-least-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seedTenant(pool, tenantId, userId, name) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenantId, name, 'active'],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, `${name} User`],
  );
}

function event({ tenantId, userId, correlationId, targetId, action = AUDIT_ACTION.REQUEST_TRANSITION }) {
  return {
    tenantId,
    actorUserId: userId,
    action,
    targetType: 'request',
    targetId,
    previousState: { status: 'Submitted' },
    newState: { status: 'Confirmed' },
    occurredAt: '2026-08-24T09:00:00.000Z',
    correlationId,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { transition: 'confirm' },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  };
}

test('PostgreSQL audit chain is append-only, tenant-isolated, and tamper-evident', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await seedTenant(pool, TENANT_A, USER_A, 'Audit A');
  await seedTenant(pool, TENANT_B, USER_B, 'Audit B');
  const repository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_SECRET });

  const firstA = await repository.append(event({
    tenantId: TENANT_A,
    userId: USER_A,
    correlationId: CORRELATION_A,
    targetId: 'AUDIT-A-1',
  }));
  const secondA = await repository.append(event({
    tenantId: TENANT_A,
    userId: USER_A,
    correlationId: CORRELATION_A,
    targetId: 'AUDIT-A-2',
    action: AUDIT_ACTION.REQUEST_TRANSITION_FAILED,
  }));
  const firstB = await repository.append(event({
    tenantId: TENANT_B,
    userId: USER_B,
    correlationId: CORRELATION_B,
    targetId: 'AUDIT-B-1',
  }));

  assert.equal(firstA.previousHash, null);
  assert.equal(secondA.previousHash, firstA.eventHash);
  assert.equal(firstB.previousHash, null);
  assert.equal(await repository.verifyTenantChain(TENANT_A), true);
  assert.equal(await repository.verifyTenantChain(TENANT_B), true);

  const tenantAEvents = await repository.listByTenantId(TENANT_A, { limit: 10 });
  assert.deepEqual(tenantAEvents.map((entry) => entry.targetId), ['AUDIT-A-2', 'AUDIT-A-1']);
  assert.ok(tenantAEvents.every((entry) => entry.tenantId === TENANT_A));

  await assert.rejects(
    pool.query(
      'UPDATE audit_events SET outcome = $3 WHERE tenant_id = $1 AND id = $2',
      [TENANT_A, firstA.id, AUDIT_OUTCOME.FAILURE],
    ),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    pool.query('DELETE FROM audit_events WHERE tenant_id = $1 AND id = $2', [TENANT_A, firstA.id]),
    (error) => error.code === '55000',
  );

  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query(
      `UPDATE audit_events
       SET metadata = jsonb_set(metadata, '{tampered}', 'true'::jsonb)
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, firstA.id],
    );
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  assert.equal(await repository.verifyTenantChain(TENANT_A), false);
  assert.equal(await repository.verifyTenantChain(TENANT_B), true);
});
