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
const ADMIN_A_OTHER = '15151515-1515-4515-8515-151515151516';
const INTEGRATION_A = '16161616-1616-4616-8616-161616161616';
const UNUSED_INTEGRATION = '17171717-1717-4717-8717-171717171717';
const TRANSACTION_A = '18181818-1818-4818-8818-181818181818';
const TRANSACTION_B = '19191919-1919-4919-8919-191919191919';
const TRANSACTION_C = '29292929-2929-4929-8929-292929292929';
const TRANSACTION_D = '30303030-3030-4030-8030-303030303030';
const PROVIDER_TENANT_A = '20202020-2020-4020-8020-202020202020';
const PROVIDER_TENANT_B = '21212121-2121-4121-8121-212121212121';
const PROVIDER_TENANT_REBOUND = '23232323-2323-4323-8323-232323232323';
const BINDING_A = '24242424-2424-4424-8424-242424242424';
const BINDING_B = '25252525-2525-4525-8525-252525252525';
const BINDING_REBOUND = '26262626-2626-4626-8626-262626262626';
const CORRELATION_A = '22222222-2222-4222-8222-222222222222';
const CORRELATION_B = '27272727-2727-4727-8727-272727272727';
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
  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
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

async function seed(pool, tenantId, userId, providerTenantReference, bindingId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, 'onboarding'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, `Admin ${userId.slice(0, 4)}`],
  );
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
       id, tenant_id, provider, provider_tenant_reference, status, created_at, updated_at
     ) VALUES ($1, $2, 'microsoft_entra', $3, 'active', $4, $4)`,
    [bindingId, tenantId, providerTenantReference, CREATED_AT],
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

function rejectionAuditFactory({
  occurredAt,
  tenantId = TENANT_A,
  actorUserId = ADMIN_A,
  correlationId = CORRELATION_A,
} = {}) {
  return ({ integrationId, previousStatus, reasonCode }) => normalizeAuditEvent({
    tenantId,
    actorUserId,
    action: AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED,
    targetType: 'integration',
    targetId: integrationId ?? 'microsoft365',
    previousState: previousStatus ? { provider: 'microsoft365', status: previousStatus } : null,
    newState: previousStatus ? { provider: 'microsoft365', status: previousStatus } : null,
    occurredAt: occurredAt.toISOString(),
    correlationId,
    outcome: AUDIT_OUTCOME.FAILURE,
    metadata: { operation: 'admin_consent_callback_rejected', reasonCode },
    retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
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
  await seed(pool, TENANT_A, ADMIN_A, PROVIDER_TENANT_A, BINDING_A);
  await seed(pool, TENANT_B, ADMIN_B, PROVIDER_TENANT_B, BINDING_B);
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [TENANT_A, ADMIN_A_OTHER, 'Other Admin A'],
  );

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
  assert.deepEqual(mismatch, { status: 'binding_unavailable' });

  assert.deepEqual(await repository.consumeConsent({
    tenantId: TENANT_B,
    actorUserId: ADMIN_B,
    stateHash: 'a'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_A,
    now: new Date('2026-08-25T07:02:00.000Z'),
    rejectionAuditEventFor: rejectionAuditFactory({
      tenantId: TENANT_B,
      actorUserId: ADMIN_B,
      correlationId: CORRELATION_B,
      occurredAt: new Date('2026-08-25T07:02:00.000Z'),
    }),
  }), { status: 'rejected', reason: 'consent_unavailable' });

  assert.deepEqual(await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A_OTHER,
    stateHash: 'a'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_A,
    now: new Date('2026-08-25T07:02:00.000Z'),
    rejectionAuditEventFor: rejectionAuditFactory({
      actorUserId: ADMIN_A_OTHER,
      correlationId: CORRELATION_B,
      occurredAt: new Date('2026-08-25T07:02:00.000Z'),
    }),
  }), { status: 'rejected', reason: 'consent_unavailable' });

  const consumed = await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'a'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_A,
    now: new Date('2026-08-25T07:02:00.000Z'),
    rejectionAuditEventFor: rejectionAuditFactory({
      occurredAt: new Date('2026-08-25T07:02:00.000Z'),
    }),
  });
  assert.deepEqual(consumed, {
    status: 'consumed',
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_A,
    connectionVersion: 1,
    connectionStatus: 'pending',
    lastVerifiedAt: null,
    connectionReason: null,
    placesPermission: 'unknown',
    calendarsPermission: 'unknown',
  });

  const bindingRaceAt = new Date('2026-08-25T07:03:00.000Z');
  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'unbound', updated_at = $2
     WHERE id = $1`,
    [BINDING_A, bindingRaceAt],
  );
  assert.deepEqual(await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_A,
    connectionVersion: 1,
    status: 'connected',
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    reason: null,
    lastVerifiedAt: bindingRaceAt,
    changedAt: bindingRaceAt,
    auditEvents: [],
    bindingUnavailableAuditEvent: rejectionAuditFactory({
      occurredAt: bindingRaceAt,
    })({
      integrationId: INTEGRATION_A,
      previousStatus: 'pending',
      reasonCode: 'provider_binding_changed',
    }),
  }), { status: 'binding_unavailable' });
  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'active', updated_at = $2
     WHERE id = $1`,
    [BINDING_A, new Date('2026-08-25T07:04:00.000Z')],
  );

  await pool.query(
    `UPDATE integrations
     SET provider_reference = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, INTEGRATION_A, PROVIDER_TENANT_REBOUND, new Date('2026-08-25T07:04:01.000Z')],
  );
  assert.deepEqual(await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_A,
    connectionVersion: 1,
    status: 'connected',
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    reason: null,
    lastVerifiedAt: new Date('2026-08-25T07:04:02.000Z'),
    changedAt: new Date('2026-08-25T07:04:02.000Z'),
    auditEvents: [],
  }), { status: 'stale' });
  await pool.query(
    `UPDATE integrations
     SET provider_reference = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, INTEGRATION_A, PROVIDER_TENANT_A, new Date('2026-08-25T07:04:03.000Z')],
  );

  assert.deepEqual(await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'a'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_A,
    now: new Date('2026-08-25T07:02:01.000Z'),
    rejectionAuditEventFor: rejectionAuditFactory({
      occurredAt: new Date('2026-08-25T07:02:01.000Z'),
    }),
  }), { status: 'rejected', reason: 'consent_unavailable' });

  const finalized = await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_A,
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
  const preservedDuringReconnect = await repository.findByTenantId(TENANT_A);
  assert.equal(preservedDuringReconnect.status, 'connected');
  assert.equal(preservedDuringReconnect.lastVerifiedAt, VERIFIED_AT.toISOString());
  assert.equal(preservedDuringReconnect.placesPermission, 'granted');

  const stale = await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_A,
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
      providerTenantReference: PROVIDER_TENANT_A,
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
      providerTenantReference: PROVIDER_TENANT_A,
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
  assert.deepEqual(await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'c'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_A,
    now: raceAt,
    rejectionAuditEventFor: rejectionAuditFactory({ occurredAt: raceAt }),
  }), { status: 'rejected', reason: 'consent_unavailable' });

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

  await pool.query(
    `INSERT INTO microsoft365_capability_health (
       tenant_id, integration_id, capability, status, reason, last_checked_at, last_success_at
     ) VALUES ($1, $2, 'free_busy', 'healthy', NULL, $3, $3)`,
    [TENANT_A, INTEGRATION_A, DISCONNECTED_AT],
  );

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'unbound', updated_at = $2
     WHERE id = $1`,
    [BINDING_A, new Date('2026-08-25T07:10:00.000Z')],
  );
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
       id, tenant_id, provider, provider_tenant_reference, status, created_at, updated_at
     ) VALUES ($1, $2, 'microsoft_entra', $3, 'active', $4, $4)`,
    [BINDING_REBOUND, TENANT_A, PROVIDER_TENANT_REBOUND, new Date('2026-08-25T07:10:00.000Z')],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [TENANT_A, 'site-rebind', 'Rebind Site'],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
    [TENANT_A, 'room-rebind', 'site-rebind', 'Rebind Room', 8],
  );
  await pool.query(
    `INSERT INTO requests (
       tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at, internal_participants
     ) VALUES ($1, $2, $3, $4, 'In Review', $5, $6, 1)`,
    [
      TENANT_A,
      'request-rebind',
      ADMIN_A,
      'room-rebind',
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
    ],
  );
  await pool.query(
    `INSERT INTO booking_provider_references (
       tenant_id, request_id, integration_id, provider_reference,
       provider_connection_reference, provider_resource_reference, idempotency_key,
       attempt_number, state, created_correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'active', $8)`,
    [
      TENANT_A,
      'request-rebind',
      INTEGRATION_A,
      'event-rebind',
      PROVIDER_TENANT_A,
      'room-rebind@example.invalid',
      'f'.repeat(64),
      CORRELATION_A,
    ],
  );
  const reboundAt = new Date('2026-08-25T07:11:00.000Z');
  const blockedActive = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_C,
    providerTenantReference: PROVIDER_TENANT_REBOUND,
    stateHash: 'd'.repeat(64),
    createdAt: reboundAt,
    expiresAt: new Date('2026-08-25T07:21:00.000Z'),
    auditEventFor() { throw new Error('AUDIT_MUST_NOT_RUN_FOR_BLOCKED_REBIND'); },
  });
  assert.deepEqual(blockedActive, { status: 'booking_reconciliation_required' });
  await pool.query(
    `UPDATE booking_provider_references
     SET provider_reference = NULL, state = 'pending'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, 'request-rebind', INTEGRATION_A],
  );
  const blockedPending = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_C,
    providerTenantReference: PROVIDER_TENANT_REBOUND,
    stateHash: 'd'.repeat(64),
    createdAt: reboundAt,
    expiresAt: new Date('2026-08-25T07:21:00.000Z'),
    auditEventFor() { throw new Error('AUDIT_MUST_NOT_RUN_FOR_BLOCKED_REBIND'); },
  });
  assert.deepEqual(blockedPending, { status: 'booking_reconciliation_required' });
  await pool.query(
    `UPDATE booking_provider_references
     SET provider_reference = $4, state = 'compensated'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, 'request-rebind', INTEGRATION_A, 'event-rebind'],
  );
  const blockedCompensated = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_C,
    providerTenantReference: PROVIDER_TENANT_REBOUND,
    stateHash: 'd'.repeat(64),
    createdAt: reboundAt,
    expiresAt: new Date('2026-08-25T07:21:00.000Z'),
    auditEventFor() { throw new Error('AUDIT_MUST_NOT_RUN_FOR_BLOCKED_REBIND'); },
  });
  assert.deepEqual(blockedCompensated, { status: 'booking_reconciliation_required' });
  await pool.query(
    'DELETE FROM booking_provider_references WHERE tenant_id = $1 AND request_id = $2',
    [TENANT_A, 'request-rebind'],
  );
  const rebound = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_C,
    providerTenantReference: PROVIDER_TENANT_REBOUND,
    stateHash: 'd'.repeat(64),
    createdAt: reboundAt,
    expiresAt: new Date('2026-08-25T07:21:00.000Z'),
    auditEventFor: consentAuditFactory(reboundAt),
  });
  assert.deepEqual(rebound, {
    status: 'pending',
    integrationId: INTEGRATION_A,
    connectionVersion: 6,
  });
  const reboundPending = await repository.findByTenantId(TENANT_A);
  assert.equal(reboundPending.providerTenantReference, PROVIDER_TENANT_REBOUND);
  assert.equal(reboundPending.status, 'pending');
  const reboundHealth = await pool.query(
    `SELECT count(*)::int AS count
     FROM microsoft365_capability_health
     WHERE tenant_id = $1 AND integration_id = $2`,
    [TENANT_A, INTEGRATION_A],
  );
  assert.equal(reboundHealth.rows[0].count, 0);

  const reboundConsumed = await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'd'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_REBOUND,
    now: new Date('2026-08-25T07:12:00.000Z'),
    rejectionAuditEventFor: rejectionAuditFactory({
      occurredAt: new Date('2026-08-25T07:12:00.000Z'),
    }),
  });
  assert.equal(reboundConsumed.status, 'consumed');
  assert.equal(reboundConsumed.connectionStatus, 'pending');
  const reboundVerifiedAt = new Date('2026-08-25T07:13:00.000Z');
  const reboundFinalized = await repository.finalizeConsent({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    providerTenantReference: PROVIDER_TENANT_REBOUND,
    connectionVersion: 6,
    status: 'connected',
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    reason: null,
    lastVerifiedAt: reboundVerifiedAt,
    changedAt: reboundVerifiedAt,
    auditEvents: [auditEvent({
      action: AUDIT_ACTION.INTEGRATION_CONNECTED,
      previousStatus: 'pending',
      nextStatus: 'connected',
      occurredAt: reboundVerifiedAt,
      operation: 'connect',
    })],
  });
  assert.equal(reboundFinalized.connection.status, 'connected');
  assert.equal(reboundFinalized.connection.providerTenantReference, PROVIDER_TENANT_REBOUND);

  const expiringReconnectAt = new Date('2026-08-25T07:14:00.000Z');
  const expiringReconnect = await repository.startConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: UNUSED_INTEGRATION,
    transactionId: TRANSACTION_D,
    providerTenantReference: PROVIDER_TENANT_REBOUND,
    stateHash: 'e'.repeat(64),
    createdAt: expiringReconnectAt,
    expiresAt: new Date('2026-08-25T07:16:00.000Z'),
    auditEventFor: consentAuditFactory(expiringReconnectAt),
  });
  assert.equal(expiringReconnect.connectionVersion, 8);
  assert.equal((await repository.findByTenantId(TENANT_A)).status, 'connected');
  const expired = await repository.consumeConsent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    stateHash: 'e'.repeat(64),
    callbackProviderTenantReference: PROVIDER_TENANT_REBOUND,
    now: new Date('2026-08-25T07:17:00.000Z'),
    rejectionAuditEventFor: rejectionAuditFactory({
      occurredAt: new Date('2026-08-25T07:17:00.000Z'),
    }),
  });
  assert.deepEqual(expired, { status: 'rejected', reason: 'consent_expired' });
  assert.equal((await repository.findByTenantId(TENANT_A)).status, 'connected');

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
      'integration.admin_consent.changed',
      'integration.connected',
      'integration.admin_consent.changed',
      'integration.verified',
      'integration.disconnected',
      'integration.admin_consent.changed',
      'integration.connected',
      'integration.admin_consent.changed',
      'integration.admin_consent.changed',
    ],
  );

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
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
