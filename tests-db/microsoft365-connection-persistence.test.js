import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresMicrosoft365ConnectionRepository,
} from '../src/persistence/postgres/microsoft365-connection-repository.js';
import {
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '12121212-1212-4212-8212-121212121212';
const TENANT_B = '13131313-1313-4313-8313-131313131313';
const ADMIN_A = '14141414-1414-4414-8414-141414141414';
const ADMIN_B = '15151515-1515-4515-8515-151515151515';
const INTEGRATION_A = '16161616-1616-4616-8616-161616161616';
const UNUSED_INTEGRATION = '17171717-1717-4717-8717-171717171717';
const TRANSACTION_A = '18181818-1818-4818-8818-181818181818';
const TRANSACTION_B = '19191919-1919-4919-8919-191919191919';
const PROVIDER_TENANT_A = '20202020-2020-4020-8020-202020202020';
const PROVIDER_TENANT_B = '21212121-2121-4121-8121-212121212121';
const CORRELATION_A = '22222222-2222-4222-8222-222222222222';
const AUDIT_KEY = 'microsoft365-persistence-audit-key-at-least-32-bytes';
const TENANT_IDS = [TENANT_A, TENANT_B];
const CREATED_AT = new Date('2026-08-25T07:00:00.000Z');
const VERIFIED_AT = new Date('2026-08-25T07:05:00.000Z');
const DISCONNECTED_AT = new Date('2026-08-25T07:08:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query(
    'DELETE FROM microsoft365_consent_transactions WHERE tenant_id = ANY($1::uuid[])',
    [TENANT_IDS],
  );
  await pool.query(
    "DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[]) AND provider = 'microsoft365'",
    [TENANT_IDS],
  );
  await pool.query('DELETE FROM sessions WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM user_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
}

async function seed(pool, tenantId, userId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, 'onboarding'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, `Admin ${userId.slice(0, 4)}`],
  );
}

function auditEvent({
  action,
  targetId = INTEGRATION_A,
  previousStatus = null,
  nextStatus,
  occurredAt,
  outcome = AUDIT_OUTCOME.SUCCESS,
  retentionClass = AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  operation,
}) {
  return normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    action,
    targetType: 'integration',
    targetId,
    previousState: previousStatus === null
      ? null
      : { provider: 'microsoft365', status: previousStatus },
    newState: { provider: 'microsoft365', status: nextStatus },
    occurredAt: occurredAt.toISOString(),
    correlationId: CORRELATION_A,
    outcome,
    metadata: { operation },
    retentionClass,
  });
}

function consentAuditFactory(occurredAt) {
  return ({ integrationId, previousStatus, nextStatus }) => auditEvent({
    action: AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED,
    targetId: integrationId,
    previousStatus,
    nextStatus,
    occurredAt,
    retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
    operation: 'admin_consent_start',
  });
}

test('Microsoft 365 connection persistence is tenant-isolated, replay-safe and rollback-protected', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const repository = createPostgresMicrosoft365ConnectionRepository(pool, { auditRepository });

  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await clean(pool);
  await seed(pool, TENANT_A, ADMIN_A);
  await seed(pool, TENANT_B, ADMIN_B);

  const started = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: INTEGRATION_A,
    transactionId: TRANSACTION_A,
    providerTenantReference: PROVIDER_TENANT_A,
    stateHash: 'a'.repeat(64),
    createdAt: CREATED_AT,
    expiresAt: new Date('2026-08-25T07:10:00.000Z'),
    auditEventFor: consentAuditFactory(CREATED_AT),
  });
  assert.deepEqual(started, {
    status: 'pending',
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
  });
  assert.equal((await repository.findByTenantId(TENANT_A)).status, 'pending');
  assert.equal(await repository.findByTenantId(TENANT_B), null);

  const mismatch = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_B,
    providerTenantReference: PROVIDER_TENANT_B,
    stateHash: 'b'.repeat(64),
    createdAt: new Date('2026-08-25T07:01:00.000Z'),
    expiresAt: new Date('2026-08-25T07:11:00.000Z'),
    auditEventFor() {
      throw new Error('AUDIT_MUST_NOT_RUN_FOR_PROVIDER_MISMATCH');
    },
  });
  assert.deepEqual(mismatch, { status: 'provider_mismatch' });

  assert.equal(await repository.consumeConsent({
    tenantId: TENANT_B,
    actorUserId: ADMIN_B,
    stateHash: 'a'.repeat(64),
    now: new Date('2026-08-25T07:02:00.000Z'),
  }), null);
  assert.equal(await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_B,
    stateHash: 'a'.repeat(64),
    now: new Date('2026-08-25T07:02:00.000Z'),
  }), null);

  const consumed = await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'a'.repeat(64),
    now: new Date('2026-08-25T07:02:00.000Z'),
  });
  assert.deepEqual(consumed, {
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_A,
    connectionVersion: 1,
  });
  assert.equal(await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'a'.repeat(64),
    now: new Date('2026-08-25T07:02:01.000Z'),
  }), null);

  const finalized = await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    status: 'connected',
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    reason: null,
    lastVerifiedAt: VERIFIED_AT,
    changedAt: VERIFIED_AT,
    auditEvents: [auditEvent({
      action: AUDIT_ACTION.INTEGRATION_CONNECTED,
      previousStatus: 'pending',
      nextStatus: 'connected',
      occurredAt: VERIFIED_AT,
      operation: 'connect',
    })],
  });
  assert.equal(finalized.status, 'updated');
  assert.equal(finalized.connection.status, 'connected');
  assert.equal(finalized.connection.connectionVersion, 2);
  assert.equal(finalized.connection.lastVerifiedAt, VERIFIED_AT.toISOString());

  const reconnectAt = new Date('2026-08-25T07:06:00.000Z');
  const reconnect = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_B,
    providerTenantReference: PROVIDER_TENANT_A,
    stateHash: 'c'.repeat(64),
    createdAt: reconnectAt,
    expiresAt: new Date('2026-08-25T07:16:00.000Z'),
    auditEventFor: consentAuditFactory(reconnectAt),
  });
  assert.deepEqual(reconnect, {
    status: 'pending',
    integrationId: INTEGRATION_A,
    connectionVersion: 3,
  });

  const stale = await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    status: 'connected',
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    reason: null,
    lastVerifiedAt: VERIFIED_AT,
    changedAt: reconnectAt,
    auditEvents: [],
  });
  assert.deepEqual(stale, { status: 'stale' });

  const raceAt = new Date('2026-08-25T07:07:00.000Z');
  const race = await Promise.all([
    repository.finalizeConsent({
      tenantId: TENANT_A,
      integrationId: INTEGRATION_A,
      connectionVersion: 3,
      status: 'connected',
      placesPermission: 'granted',
      calendarsPermission: 'granted',
      reason: null,
      lastVerifiedAt: raceAt,
      changedAt: raceAt,
      auditEvents: [auditEvent({
        action: AUDIT_ACTION.INTEGRATION_VERIFIED,
        previousStatus: 'pending',
        nextStatus: 'connected',
        occurredAt: raceAt,
        operation: 'verify',
      })],
    }),
    repository.finalizeConsent({
      tenantId: TENANT_A,
      integrationId: INTEGRATION_A,
      connectionVersion: 3,
      status: 'degraded',
      placesPermission: 'granted',
      calendarsPermission: 'missing',
      reason: 'calendars_permission_missing',
      lastVerifiedAt: raceAt,
      changedAt: raceAt,
      auditEvents: [auditEvent({
        action: AUDIT_ACTION.INTEGRATION_VERIFIED,
        previousStatus: 'pending',
        nextStatus: 'degraded',
        occurredAt: raceAt,
        outcome: AUDIT_OUTCOME.FAILURE,
        operation: 'verify',
      })],
    }),
  ]);
  assert.deepEqual(race.map((entry) => entry.status).sort(), ['stale', 'updated']);
  assert.equal(race.find((entry) => entry.status === 'updated').connection.connectionVersion, 4);
  assert.equal(await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'c'.repeat(64),
    now: raceAt,
  }), null);

  const disconnected = await repository.disconnect({
    tenantId: TENANT_A,
    changedAt: DISCONNECTED_AT,
    auditEventFor: ({ integrationId, previousStatus, nextStatus }) => auditEvent({
      action: AUDIT_ACTION.INTEGRATION_DISCONNECTED,
      targetId: integrationId,
      previousStatus,
      nextStatus,
      occurredAt: DISCONNECTED_AT,
      operation: 'disconnect',
    }),
  });
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.connectionVersion, 5);
  assert.equal(disconnected.lastVerifiedAt, null);
  assert.equal(disconnected.placesPermission, 'unknown');
  assert.equal(disconnected.calendarsPermission, 'unknown');

  const idempotent = await repository.disconnect({
    tenantId: TENANT_A,
    changedAt: new Date('2026-08-25T07:09:00.000Z'),
    auditEventFor() {
      throw new Error('AUDIT_MUST_NOT_RUN_FOR_IDEMPOTENT_DISCONNECT');
    },
  });
  assert.equal(idempotent.connectionVersion, 5);

  const auditRows = await pool.query({
    text: `
      SELECT action
      FROM audit_events
      WHERE tenant_id = $1 AND target_id = $2
      ORDER BY id
    `,
    values: [TENANT_A, INTEGRATION_A],
  });
  assert.deepEqual(
    auditRows.rows.map((row) => row.action),
    [
      'integration.admin_consent.changed',
      'integration.connected',
      'integration.admin_consent.changed',
      'integration.verified',
      'integration.disconnected',
    ],
  );

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  await assert.rejects(
    rollbackLatest(pool),
    /MICROSOFT365_CONNECTION_ROWS_REQUIRE_REVIEW/,
  );
  assert.equal(await isPostgresSchemaReady(pool), false);

  await pool.query(
    "DELETE FROM integrations WHERE tenant_id = $1 AND provider = 'microsoft365'",
    [TENANT_A],
  );
  assert.equal(await repository.findByTenantId(TENANT_A), null);
  await assert.rejects(
    rollbackLatest(pool),
    /MICROSOFT365_CONNECTION_ROWS_REQUIRE_REVIEW/,
  );
  assert.equal(await isPostgresSchemaReady(pool), false);

  await clean(pool);
  await rollbackLatest(pool);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
