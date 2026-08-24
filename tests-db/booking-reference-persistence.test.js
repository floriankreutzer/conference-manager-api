import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../src/audit/event.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresBookingReferenceRepository } from '../src/persistence/postgres/booking-reference-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = '61616161-6161-4616-8616-616161616161';
const TENANT_B = '62626262-6262-4626-8626-626262626262';
const USER_A = '71717171-7171-4717-8717-717171717171';
const USER_B = '72727272-7272-4727-8727-727272727272';
const INTEGRATION_A = '81818181-8181-4818-8818-818181818181';
const INTEGRATION_B = '82828282-8282-4828-8828-828282828282';
const CORRELATION_A = '91919191-9191-4919-8919-919191919191';
const CORRELATION_B = '92929292-9292-4929-8929-929292929292';
const AUDIT_KEY = 'booking-reference-audit-key-at-least-32-bytes';
const IDEMPOTENCY_A = 'a'.repeat(64);
const IDEMPOTENCY_B = 'b'.repeat(64);

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seedTenant(pool, tenantId, userId, integrationId, label) {
  await pool.query('INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)', [tenantId, label, 'active']);
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, `${label} User`],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [tenantId, 'site-1', `${label} Site`],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, 'room-1', 'site-1', `${label} Room`, 20],
  );
  await pool.query(
    `INSERT INTO integrations (tenant_id, id, provider, provider_reference, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, integrationId, 'calendar_test', `connection-${label}`, 'connected'],
  );
  await pool.query(
    `INSERT INTO requests (
      tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at, internal_participants
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      'request-1',
      userId,
      'room-1',
      'Submitted',
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
      1,
    ],
  );
}

function auditEvent(auditService, tenantId, userId, correlationId, disposition = 'created') {
  return auditService.createEvent({
    principal: { tenantId, userId },
    tenantContext: { tenantId },
    correlationId,
    action: AUDIT_ACTION.CALENDAR_OPERATION,
    targetType: 'request',
    targetId: 'request-1',
    newState: { calendarState: 'active' },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'create', phase: 'provisional', disposition },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
    occurredAt: '2026-08-24T10:00:00.000Z',
  });
}

test('PostgreSQL booking references are tenant-scoped, idempotent, and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    try {
      await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
    }
    await pool.query(
      'DELETE FROM booking_provider_references WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
    await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.query('DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await seedTenant(pool, TENANT_A, USER_A, INTEGRATION_A, 'Booking A');
  await seedTenant(pool, TENANT_B, USER_B, INTEGRATION_B, 'Booking B');

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy(),
  });
  const repository = createPostgresBookingReferenceRepository(pool, { auditRepository });

  await t.test('same opaque provider reference can exist independently across tenants', async () => {
    const first = await repository.createProviderReference({
      tenantId: TENANT_A,
      requestId: 'request-1',
      integrationId: INTEGRATION_A,
      providerReference: 'opaque-event-1',
      idempotencyKey: IDEMPOTENCY_A,
      correlationId: CORRELATION_A,
      changedAt: new Date('2026-08-24T10:00:00.000Z'),
      auditEvent: auditEvent(auditService, TENANT_A, USER_A, CORRELATION_A),
    });
    assert.equal(first.created, true);

    const second = await repository.createProviderReference({
      tenantId: TENANT_B,
      requestId: 'request-1',
      integrationId: INTEGRATION_B,
      providerReference: 'opaque-event-1',
      idempotencyKey: IDEMPOTENCY_B,
      correlationId: CORRELATION_B,
      changedAt: new Date('2026-08-24T10:00:00.000Z'),
      auditEvent: auditEvent(auditService, TENANT_B, USER_B, CORRELATION_B),
    });
    assert.equal(second.created, true);
    assert.equal(
      (await repository.findProviderReferenceByRequest(TENANT_A, 'request-1', INTEGRATION_A)).tenantId,
      TENANT_A,
    );
    assert.equal(
      (await repository.findProviderReferenceByRequest(TENANT_B, 'request-1', INTEGRATION_B)).tenantId,
      TENANT_B,
    );
  });

  await t.test('repeated create with the same idempotency contract does not append duplicate evidence', async () => {
    const before = await auditRepository.listByTenantId(TENANT_A, { limit: 100 });
    const repeated = await repository.createProviderReference({
      tenantId: TENANT_A,
      requestId: 'request-1',
      integrationId: INTEGRATION_A,
      providerReference: 'opaque-event-1',
      idempotencyKey: IDEMPOTENCY_A,
      correlationId: CORRELATION_A,
      changedAt: new Date('2026-08-24T10:01:00.000Z'),
      auditEvent: auditEvent(auditService, TENANT_A, USER_A, CORRELATION_A, 'existing'),
    });
    assert.equal(repeated.created, false);
    const after = await auditRepository.listByTenantId(TENANT_A, { limit: 100 });
    assert.equal(after.length, before.length);
  });

  await t.test('cross-tenant integration references fail at the database boundary', async () => {
    await assert.rejects(
      repository.createProviderReference({
        tenantId: TENANT_A,
        requestId: 'request-1',
        integrationId: INTEGRATION_B,
        providerReference: 'cross-tenant-event',
        idempotencyKey: 'c'.repeat(64),
        correlationId: CORRELATION_A,
        changedAt: new Date('2026-08-24T10:02:00.000Z'),
        auditEvent: auditEvent(auditService, TENANT_A, USER_A, CORRELATION_A),
      }),
      (error) => error.code === '23503',
    );
  });

  await t.test('room conflict lookup matches active baseline statuses and remains tenant-scoped', async () => {
    await pool.query(
      `INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at, internal_participants
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        TENANT_A,
        'request-conflict',
        USER_A,
        'room-1',
        'In Review',
        '2026-09-01T10:30:00.000Z',
        '2026-09-01T11:30:00.000Z',
        1,
      ],
    );
    assert.equal(await repository.hasConflictingRequest({
      tenantId: TENANT_A,
      roomId: 'room-1',
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z',
      excludeRequestId: 'request-1',
    }), true);
    assert.equal(await repository.hasConflictingRequest({
      tenantId: TENANT_B,
      roomId: 'room-1',
      startsAt: '2026-09-01T11:00:00.000Z',
      endsAt: '2026-09-01T12:00:00.000Z',
      excludeRequestId: 'request-1',
    }), false);
  });

  await t.test('provider-reference mutation rolls back when required audit append fails', async () => {
    await pool.query(
      `INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at, internal_participants
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        TENANT_A,
        'request-audit-failure',
        USER_A,
        'room-1',
        'Submitted',
        '2026-09-02T10:00:00.000Z',
        '2026-09-02T11:00:00.000Z',
        1,
      ],
    );
    const failingRepository = createPostgresBookingReferenceRepository(pool, {
      auditRepository: {
        async appendWithClient() {
          throw new Error('EXPECTED_AUDIT_FAILURE');
        },
      },
    });
    await assert.rejects(
      failingRepository.createProviderReference({
        tenantId: TENANT_A,
        requestId: 'request-audit-failure',
        integrationId: INTEGRATION_A,
        providerReference: 'event-audit-failure',
        idempotencyKey: 'd'.repeat(64),
        correlationId: CORRELATION_A,
        changedAt: new Date('2026-08-24T10:03:00.000Z'),
        auditEvent: auditEvent(auditService, TENANT_A, USER_A, CORRELATION_A),
      }),
      /EXPECTED_AUDIT_FAILURE/,
    );
    assert.equal(
      await repository.findProviderReferenceByRequest(TENANT_A, 'request-audit-failure', INTEGRATION_A),
      null,
    );
  });
});
