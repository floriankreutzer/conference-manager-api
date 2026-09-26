import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  createPostgresMicrosoft365CalendarAuthorityGuard,
} from '../src/persistence/postgres/calendar-authority-guard.js';
import {
  createPostgresBookingReferenceRepository,
} from '../src/persistence/postgres/booking-reference-repository.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '11111111-aaaa-4111-8111-111111111111';
const TENANT_B = '22222222-bbbb-4222-8222-222222222222';
const USER_A = '33333333-aaaa-4333-8333-333333333333';
const USER_B = '44444444-bbbb-4444-8444-444444444444';
const REQUEST_A1 = 'race-a-1';
const REQUEST_A2 = 'race-a-2';
const REQUEST_B = 'race-b-1';
const ROOM_ID = 'shared-room';
const SITE_ID = 'site-a';
const CHANGED_AT = new Date('2026-08-25T17:00:00.000Z');
const INTEGRATION_A = '55555555-aaaa-4555-8555-555555555555';
const INTEGRATION_B = '66666666-bbbb-4666-8666-666666666666';
const BINDING_A = '77777777-aaaa-4777-8777-777777777777';
const BINDING_B = '88888888-bbbb-4888-8888-888888888888';
const PROVIDER_TENANT_A = '99999999-aaaa-4999-8999-999999999999';
const PROVIDER_TENANT_B = 'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa';
const RESOURCE_A = 'room-a@example.invalid';
const RESOURCE_B = 'room-b@example.invalid';
const BOOKING_CHANGE_A2 = 'bbbbbbbb-cccc-4bbb-8bbb-bbbbbbbbbbbb';
const CORRELATION_CONFIRM = 'cccccccc-dddd-4ccc-8ccc-ccccccccccc1';
const CORRELATION_CLEANUP = 'cccccccc-dddd-4ccc-8ccc-ccccccccccc2';
const CORRELATION_TRANSITION = 'cccccccc-dddd-4ccc-8ccc-ccccccccccc3';
const CORRELATION_BOOKING_CHANGE = 'cccccccc-dddd-4ccc-8ccc-ccccccccccc4';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, [TENANT_A, TENANT_B]);
  await pool.query('DELETE FROM booking_change_requests WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM microsoft365_room_mappings WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
}

async function seedTenant(pool, tenantId, userId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, 'active'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, 'Manager'],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [tenantId, SITE_ID, 'Main Site'],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, ROOM_ID, SITE_ID, 'Shared Room', 12],
  );
  const tenantA = tenantId === TENANT_A;
  const integrationId = tenantA ? INTEGRATION_A : INTEGRATION_B;
  const bindingId = tenantA ? BINDING_A : BINDING_B;
  const providerTenantReference = tenantA ? PROVIDER_TENANT_A : PROVIDER_TENANT_B;
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
       id, tenant_id, provider, provider_tenant_reference,
       claimant_provider_user_reference, status, created_at, updated_at
     ) VALUES ($1, $2, 'microsoft_entra', $3, $4, 'active', $5, $5)`,
    [bindingId, tenantId, providerTenantReference, userId, CHANGED_AT],
  );
  await pool.query(
    `INSERT INTO integrations (
       tenant_id, id, provider, provider_reference, status, connection_version,
       last_verified_at, places_permission_status, calendars_permission_status,
       created_at, updated_at
     ) VALUES ($1, $2, 'microsoft365', $3, 'connected', 1, $4, 'granted', 'granted', $4, $4)`,
    [tenantId, integrationId, providerTenantReference, CHANGED_AT],
  );
  await pool.query(
    `INSERT INTO microsoft365_room_mappings (
       tenant_id, room_id, integration_id, external_room_id, resource_address,
       provider_display_name, provider_capacity, provider_status,
       last_seen_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 12, 'active', $7, $7, $7)`,
    [
      tenantId,
      ROOM_ID,
      integrationId,
      `external-${tenantId.slice(0, 8)}`,
      tenantA ? RESOURCE_A : RESOURCE_B,
      'Shared Room',
      CHANGED_AT,
    ],
  );
}

async function seedRequest(pool, tenantId, requestId, userId, { activeReference = true } = {}) {
  await pool.query(
    `INSERT INTO requests (
      tenant_id, id, requester_user_id, room_id, status,
      starts_at, ends_at, internal_participants, external_participants,
      status_changed_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 4, 0, $8, $8, $8)`,
    [
      tenantId,
      requestId,
      userId,
      ROOM_ID,
      REQUEST_STATUS.IN_REVIEW,
      '2026-09-10T10:00:00.000Z',
      '2026-09-10T11:00:00.000Z',
      '2026-08-25T16:00:00.000Z',
    ],
  );
  if (!activeReference) return;
  const tenantA = tenantId === TENANT_A;
  await pool.query(
    `INSERT INTO booking_provider_references (
       tenant_id, request_id, integration_id, attempt_number, provider_reference,
       provider_connection_reference, provider_resource_reference, idempotency_key,
       state, created_correlation_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'active', $8, $9, $9)`,
    [
      tenantId,
      requestId,
      tenantA ? INTEGRATION_A : INTEGRATION_B,
      `event-${tenantId}-${requestId}`,
      tenantA ? PROVIDER_TENANT_A : PROVIDER_TENANT_B,
      tenantA ? RESOURCE_A : RESOURCE_B,
      createHash('sha256').update(`${tenantId}:${requestId}`).digest('hex'),
      tenantA ? BINDING_A : BINDING_B,
      CHANGED_AT,
    ],
  );
}

function repository(pool, auditRepository = {
  async appendWithClient() {
    return { id: 'test-audit' };
  },
}) {
  return createPostgresRequestRepository(pool, {
    auditRepository,
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return Object.freeze({ promise, resolve });
}

async function within(promise, label, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function poolWithQueryHooks(pool, { before = {}, after = {} } = {}) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        async query(...args) {
          const name = typeof args[0] === 'object' ? args[0].name : null;
          if (before[name]) await before[name]();
          const result = await client.query(...args);
          if (after[name]) await after[name]();
          return result;
        },
        release(error) {
          client.release(error);
        },
      };
    },
  };
}

function bookingReferenceRepository(pool) {
  return createPostgresBookingReferenceRepository(pool, {
    auditRepository: {
      async appendWithClient() {
        return { id: 'test-booking-audit' };
      },
    },
  });
}

function advisoryAuditRepository() {
  return Object.freeze({
    async appendWithClient(client) {
      await client.query({
        name: 'audit-lock-tenant-chain',
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        values: [TENANT_A],
      });
      return Object.freeze({ id: 'test-advisory-audit' });
    },
  });
}

function confirm(repo, tenantId, requestId, {
  calendarWriteEnabled = true,
  expectedVersion = 1,
  calendarCleanup = null,
  auditEvent = null,
} = {}) {
  const tenantA = tenantId === TENANT_A;
  const effectiveAuditEvent = auditEvent ?? {
    actorUserId: tenantA ? USER_A : USER_B,
    correlationId: tenantA ? CORRELATION_CONFIRM : BINDING_B,
    test: true,
  };
  return repo.confirmIfRoomAvailable({
    tenantId,
    requestId,
    expectedStatus: REQUEST_STATUS.IN_REVIEW,
    expectedVersion,
    calendarAuthority: {
      integrationId: tenantA ? INTEGRATION_A : INTEGRATION_B,
      integrationProvider: 'microsoft365',
      identityProvider: 'microsoft_entra',
      providerConnectionReference: tenantA ? PROVIDER_TENANT_A : PROVIDER_TENANT_B,
      roomId: ROOM_ID,
      providerResourceReference: tenantA ? RESOURCE_A : RESOURCE_B,
      calendarWriteEnabled,
    },
    calendarCleanup,
    changedAt: CHANGED_AT,
    auditEvent: effectiveAuditEvent,
  });
}

function cleanupReference(requestId = REQUEST_A1) {
  return Object.freeze({
    integrationId: INTEGRATION_A,
    providerReference: `event-${TENANT_A}-${requestId}`,
    providerConnectionReference: PROVIDER_TENANT_A,
    providerResourceReference: RESOURCE_A,
  });
}

function calendarCleanup(requestId = REQUEST_A1, auditEvent = { test: 'calendar-cleanup' }) {
  return Object.freeze({
    reference: cleanupReference(requestId),
    auditEvent,
  });
}

function beginCompensation(repo) {
  return repo.beginCompensatingProviderReference({
    tenantId: TENANT_A,
    requestId: REQUEST_A1,
    integrationId: INTEGRATION_A,
    providerReference: `event-${TENANT_A}-${REQUEST_A1}`,
    expectedRequestVersion: 1,
    changedAt: new Date('2026-08-25T17:10:00.000Z'),
    auditEvent: { test: true },
  });
}

async function seedOptionalAuditLockRace(pool) {
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A2, USER_A);
  await pool.query(
    `UPDATE booking_provider_references
     SET state = 'compensated'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A],
  );
  await pool.query(
    `UPDATE requests
     SET status = 'Confirmed',
       starts_at = '2026-09-10T12:00:00.000Z',
       ends_at = '2026-09-10T13:00:00.000Z'
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, REQUEST_A2],
  );
  await pool.query(
    `INSERT INTO booking_change_requests (
       tenant_id, id, request_id, initiator_user_id, initiator_role_at_action,
       status, room_id, starts_at, ends_at, internal_participants,
       external_participants, base_request_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'employee', 'pending', $5, $6, $7, 4, 0, $8, $9, $9)`,
    [
      TENANT_A,
      BOOKING_CHANGE_A2,
      REQUEST_A2,
      USER_A,
      ROOM_ID,
      '2026-09-10T12:00:00.000Z',
      '2026-09-10T13:00:00.000Z',
      '2026-08-25T16:00:00.000Z',
      CHANGED_AT,
    ],
  );
}

function confirmAfterCleanup(repo) {
  return confirm(repo, TENANT_A, REQUEST_A1, {
    calendarWriteEnabled: false,
    calendarCleanup: calendarCleanup(REQUEST_A1, {
      actorUserId: USER_A,
      correlationId: CORRELATION_CLEANUP,
      test: 'calendar-cleanup',
    }),
    auditEvent: {
      actorUserId: USER_A,
      correlationId: CORRELATION_CONFIRM,
      test: 'request-transition',
    },
  });
}

function supersedePendingChange(repo) {
  return repo.transitionByTenantIdAndId({
    tenantId: TENANT_A,
    requestId: REQUEST_A2,
    actorUserId: USER_A,
    actorRoleAtAction: 'conference_manager',
    expectedStatus: REQUEST_STATUS.CONFIRMED,
    expectedVersion: 1,
    nextStatus: REQUEST_STATUS.CANCELLED,
    reason: null,
    changedAt: CHANGED_AT,
    auditEvent: {
      actorUserId: USER_A,
      correlationId: CORRELATION_TRANSITION,
      test: 'request-transition',
    },
    bookingChangeAuditEvent: {
      actorUserId: USER_A,
      correlationId: CORRELATION_BOOKING_CHANGE,
      test: 'booking-change-superseded',
    },
  });
}

async function assertOptionalAuditLockRace(pool, operation) {
  const revisionAttempted = deferred();
  const operationPool = poolWithQueryHooks(pool, {
    before: {
      'request-revision-watermark-lock'() {
        revisionAttempted.resolve();
      },
    },
  });
  const operationRepository = repository(operationPool, advisoryAuditRepository());
  const revisionOwner = await pool.connect();
  let mutationOutcome;
  let mutationResult;
  let mutationError;
  let ownerError;
  let ownerCommitted = false;
  let auditLockAcquired = false;
  try {
    await revisionOwner.query('BEGIN');
    await revisionOwner.query({
      name: 'test-hold-request-revision-watermark',
      text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      values: [`request-revision-watermark:${TENANT_A}`],
    });
    const mutation = operation === 'cleanup'
      ? confirmAfterCleanup(operationRepository)
      : supersedePendingChange(operationRepository);
    mutationOutcome = mutation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await within(revisionAttempted.promise, 'OPTIONAL_AUDIT_REVISION_ATTEMPT');
    const auditLock = await revisionOwner.query({
      name: 'test-try-tenant-audit-lock',
      text: 'SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS acquired',
      values: [TENANT_A],
    });
    auditLockAcquired = auditLock.rows[0]?.acquired === true;
    await revisionOwner.query('COMMIT');
    ownerCommitted = true;
  } catch (error) {
    ownerError = error;
  } finally {
    if (!ownerCommitted) await revisionOwner.query('ROLLBACK').catch(() => {});
    revisionOwner.release();
  }
  if (mutationOutcome) {
    try {
      const outcome = await within(mutationOutcome, 'OPTIONAL_AUDIT_MUTATION');
      if (outcome.error) mutationError = outcome.error;
      else mutationResult = outcome.value;
    } catch (error) {
      mutationError = error;
    }
  }
  if (ownerError) throw ownerError;
  if (mutationError) throw mutationError;
  assert.equal(auditLockAcquired, true);
  assert.equal(
    mutationResult.status,
    operation === 'cleanup' ? 'confirmed' : REQUEST_STATUS.CANCELLED,
  );
}

test('room-locked final confirmation permits exactly one overlapping winner per Tenant', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedTenant(pool, TENANT_B, USER_B);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A2, USER_A);
  await seedRequest(pool, TENANT_B, REQUEST_B, USER_B);

  const repo = repository(pool);
  const [first, second] = await Promise.all([
    confirm(repo, TENANT_A, REQUEST_A1),
    confirm(repo, TENANT_A, REQUEST_A2),
  ]);
  assert.deepEqual(
    [first.status, second.status].sort(),
    ['confirmed', 'room_conflict'],
  );

  const tenantA = await pool.query(
    `SELECT id, status FROM requests WHERE tenant_id = $1 ORDER BY id`,
    [TENANT_A],
  );
  assert.equal(tenantA.rows.filter((row) => row.status === REQUEST_STATUS.CONFIRMED).length, 1);
  assert.equal(tenantA.rows.filter((row) => row.status === REQUEST_STATUS.IN_REVIEW).length, 1);

  const tenantB = await confirm(repo, TENANT_B, REQUEST_B);
  assert.equal(tenantB.status, 'confirmed');
  assert.equal(tenantB.request.tenantId, TENANT_B);

  const retryWinnerId = first.status === 'confirmed' ? REQUEST_A1 : REQUEST_A2;
  const retry = await confirm(repo, TENANT_A, retryWinnerId);
  assert.equal(retry.status, 'state_conflict');
  assert.equal(retry.request.status, REQUEST_STATUS.CONFIRMED);
});

test('final confirmation revalidates request state and room ownership inside the transaction', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  const repo = repository(pool);

  const wrongTenant = await confirm(repo, TENANT_B, REQUEST_A1);
  assert.equal(wrongTenant.status, 'state_conflict');
  assert.equal(wrongTenant.request, null);

  await pool.query(
    'UPDATE requests SET status = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUEST_A1, REQUEST_STATUS.CANCELLED],
  );
  const stale = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(stale.status, 'state_conflict');
  assert.equal(stale.request.status, REQUEST_STATUS.CANCELLED);
});

test('final confirmation rejects a same-status stale version without audit or revision effects', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await pool.query(
    `UPDATE requests
     SET request_version = 2
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  let auditAppends = 0;
  const repo = createPostgresRequestRepository(pool, {
    auditRepository: {
      async appendWithClient() {
        auditAppends += 1;
        return { id: 'unexpected-audit' };
      },
    },
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });

  const stale = await confirm(repo, TENANT_A, REQUEST_A1, { expectedVersion: 1 });
  assert.equal(stale.status, 'state_conflict');
  assert.equal(stale.request.status, REQUEST_STATUS.IN_REVIEW);
  assert.equal(stale.request.version, 2);
  assert.equal(auditAppends, 0);

  const persisted = await pool.query(
    `SELECT status, request_version::integer AS request_version,
       (SELECT count(*)::integer
        FROM request_revisions
        WHERE tenant_id = $1 AND request_id = $2) AS revision_count
     FROM requests
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  assert.deepEqual(persisted.rows[0], {
    status: REQUEST_STATUS.IN_REVIEW,
    request_version: 2,
    revision_count: 0,
  });
});

test('final confirmation fails closed when the commit-time calendar authority is no longer exact', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedTenant(pool, TENANT_B, USER_B);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  const repo = repository(pool);

  for (const status of ['disconnected', 'revoked']) {
    await pool.query(
      `UPDATE integrations
       SET status = $3,
           connection_version = connection_version + 1,
           last_verified_at = $4,
           updated_at = $5
       WHERE tenant_id = $1 AND id = $2`,
      [
        TENANT_A,
        INTEGRATION_A,
        status,
        status === 'disconnected' ? null : CHANGED_AT,
        CHANGED_AT,
      ],
    );
    const unavailable = await confirm(repo, TENANT_A, REQUEST_A1);
    assert.equal(unavailable.status, 'provider_authority_conflict');
    assert.equal(unavailable.request.status, REQUEST_STATUS.IN_REVIEW);
  }
  await pool.query(
    `UPDATE integrations
     SET status = 'connected', connection_version = connection_version + 1
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, INTEGRATION_A],
  );

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'unbound', updated_at = $3
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, BINDING_A, new Date('2026-08-25T17:01:00.000Z')],
  );
  const unbound = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(unbound.status, 'provider_authority_conflict');
  assert.equal(unbound.request.status, REQUEST_STATUS.IN_REVIEW);

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'active', provider_tenant_reference = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [
      TENANT_A,
      BINDING_A,
      'bbbbbbbb-aaaa-4bbb-8bbb-bbbbbbbbbbbb',
      new Date('2026-08-25T17:02:00.000Z'),
    ],
  );
  const mismatched = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(mismatched.status, 'provider_authority_conflict');
  assert.equal(mismatched.request.status, REQUEST_STATUS.IN_REVIEW);

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET provider_tenant_reference = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, BINDING_A, PROVIDER_TENANT_A, new Date('2026-08-25T17:03:00.000Z')],
  );
  await pool.query(
    `UPDATE microsoft365_room_mappings
     SET resource_address = $4, updated_at = $5, last_seen_at = $5
     WHERE tenant_id = $1 AND room_id = $2 AND integration_id = $3`,
    [
      TENANT_A,
      ROOM_ID,
      INTEGRATION_A,
      'room-remapped@example.invalid',
      new Date('2026-08-25T17:04:00.000Z'),
    ],
  );
  const remapped = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(remapped.status, 'provider_authority_conflict');
  assert.equal(remapped.request.status, REQUEST_STATUS.IN_REVIEW);

  const crossTenantAuthority = await repo.confirmIfRoomAvailable({
    tenantId: TENANT_A,
    requestId: REQUEST_A1,
    expectedStatus: REQUEST_STATUS.IN_REVIEW,
    expectedVersion: 1,
    calendarAuthority: {
      integrationId: INTEGRATION_B,
      integrationProvider: 'microsoft365',
      identityProvider: 'microsoft_entra',
      providerConnectionReference: PROVIDER_TENANT_B,
      roomId: ROOM_ID,
      providerResourceReference: RESOURCE_B,
      calendarWriteEnabled: true,
    },
    changedAt: CHANGED_AT,
    auditEvent: { test: true },
  });
  assert.equal(crossTenantAuthority.status, 'provider_authority_conflict');
  assert.equal(crossTenantAuthority.request.status, REQUEST_STATUS.IN_REVIEW);

  const persisted = await pool.query(
    'SELECT status FROM requests WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUEST_A1],
  );
  assert.equal(persisted.rows[0].status, REQUEST_STATUS.IN_REVIEW);
});

test('write-enabled final confirmation requires the exact active booking reference', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A, { activeReference: false });
  const repo = repository(pool);

  const assertBlocked = async () => {
    const result = await confirm(repo, TENANT_A, REQUEST_A1);
    assert.equal(result.status, 'provider_authority_conflict');
    assert.equal(result.request.status, REQUEST_STATUS.IN_REVIEW);
  };
  await assertBlocked();

  await pool.query(
    `INSERT INTO booking_provider_references (
       tenant_id, request_id, integration_id, attempt_number, provider_reference,
       provider_connection_reference, provider_resource_reference, idempotency_key,
       state, created_correlation_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, NULL, $4, $5, $6, 'pending', $7, $8, $8)`,
    [
      TENANT_A,
      REQUEST_A1,
      INTEGRATION_A,
      PROVIDER_TENANT_A,
      RESOURCE_A,
      createHash('sha256').update(`${TENANT_A}:${REQUEST_A1}`).digest('hex'),
      BINDING_A,
      CHANGED_AT,
    ],
  );
  await assertBlocked();

  for (const state of ['compensating', 'compensated', 'cancelled']) {
    await pool.query(
      `UPDATE booking_provider_references
       SET provider_reference = 'event-fenced', state = $4
       WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
      [TENANT_A, REQUEST_A1, INTEGRATION_A, state],
    );
    await assertBlocked();
  }

  await pool.query(
    `UPDATE booking_provider_references
     SET state = 'active', provider_connection_reference = 'wrong-provider-tenant'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A],
  );
  await assertBlocked();
  await pool.query(
    `UPDATE booking_provider_references
     SET provider_connection_reference = $4, provider_resource_reference = 'wrong-room@example.invalid'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A, PROVIDER_TENANT_A],
  );
  await assertBlocked();

  await pool.query(
    `UPDATE booking_provider_references
     SET provider_resource_reference = $4
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A, RESOURCE_A],
  );
  const confirmed = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.request.status, REQUEST_STATUS.CONFIRMED);
});

test('confirm-first lock order retains the active event and denies queued pre-confirm cleanup', { timeout: 10_000 }, async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);

  const referenceLocked = deferred();
  const releaseConfirmation = deferred();
  const compensationOwnerQueryStarted = deferred();
  const confirmPool = poolWithQueryHooks(pool, {
    after: {
      async 'calendar-authority-lock-active-booking-reference'() {
        referenceLocked.resolve();
        await releaseConfirmation.promise;
      },
    },
  });
  const compensationPool = poolWithQueryHooks(pool, {
    before: {
      'booking-reference-lock-compensatable-request'() {
        compensationOwnerQueryStarted.resolve();
      },
    },
  });
  const confirmRepository = repository(confirmPool);
  const compensationRepository = bookingReferenceRepository(compensationPool);

  const confirming = confirm(confirmRepository, TENANT_A, REQUEST_A1);
  await referenceLocked.promise;
  const compensating = beginCompensation(compensationRepository);
  await compensationOwnerQueryStarted.promise;
  releaseConfirmation.resolve();

  const confirmed = await confirming;
  const compensation = await compensating;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.request.status, REQUEST_STATUS.CONFIRMED);
  assert.equal(compensation, null);
  const persisted = await pool.query(
    `SELECT target_request.status, booking.state
     FROM requests target_request
     JOIN booking_provider_references booking
       ON booking.tenant_id = target_request.tenant_id AND booking.request_id = target_request.id
     WHERE target_request.tenant_id = $1 AND target_request.id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  assert.deepEqual(persisted.rows, [{ status: REQUEST_STATUS.CONFIRMED, state: 'active' }]);
});

test('pre-confirm cleanup-first lock order owns the event before stale write-enabled confirmation', { timeout: 10_000 }, async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);

  const compensationOwnerLocked = deferred();
  const releaseCompensation = deferred();
  const confirmRequestQueryStarted = deferred();
  const compensationPool = poolWithQueryHooks(pool, {
    after: {
      async 'booking-reference-lock-compensatable-request'() {
        compensationOwnerLocked.resolve();
        await releaseCompensation.promise;
      },
    },
  });
  const confirmPool = poolWithQueryHooks(pool, {
    before: {
      'request-final-confirm-lock-request'() {
        confirmRequestQueryStarted.resolve();
      },
    },
  });
  const compensationRepository = bookingReferenceRepository(compensationPool);
  const confirmRepository = repository(confirmPool);

  const compensating = beginCompensation(compensationRepository);
  await compensationOwnerLocked.promise;
  const confirming = confirm(confirmRepository, TENANT_A, REQUEST_A1);
  await confirmRequestQueryStarted.promise;
  releaseCompensation.resolve();

  const compensation = await compensating;
  const confirmation = await confirming;
  assert.equal(compensation.state, 'compensating');
  assert.equal(confirmation.status, 'provider_authority_conflict');
  assert.equal(confirmation.request.status, REQUEST_STATUS.IN_REVIEW);
  const persisted = await pool.query(
    `SELECT target_request.status, booking.state
     FROM requests target_request
     JOIN booking_provider_references booking
       ON booking.tenant_id = target_request.tenant_id AND booking.request_id = target_request.id
     WHERE target_request.tenant_id = $1 AND target_request.id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  assert.deepEqual(persisted.rows, [{ status: REQUEST_STATUS.IN_REVIEW, state: 'compensating' }]);
});

test('pre-confirm cleanup waits for the Request revision lock before taking the tenant audit lock', { timeout: 15_000 }, async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedOptionalAuditLockRace(pool);

  await assertOptionalAuditLockRace(pool, 'cleanup');
});

test('pending-change supersede waits for the Request revision lock before taking the tenant audit lock', { timeout: 15_000 }, async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedOptionalAuditLockRace(pool);

  await assertOptionalAuditLockRace(pool, 'supersede');
});

test('write-disabled final confirmation cannot commit while a nonterminal calendar reference remains', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A, { activeReference: false });
  await pool.query(
    `INSERT INTO booking_provider_references (
       tenant_id, request_id, integration_id, attempt_number, provider_reference,
       provider_connection_reference, provider_resource_reference, idempotency_key,
       state, created_correlation_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, NULL, $4, $5, $6, 'pending', $7, $8, $8)`,
    [
      TENANT_A,
      REQUEST_A1,
      INTEGRATION_A,
      PROVIDER_TENANT_A,
      RESOURCE_A,
      'd'.repeat(64),
      BINDING_A,
      CHANGED_AT,
    ],
  );
  const repo = repository(pool);
  const blocked = await confirm(repo, TENANT_A, REQUEST_A1, { calendarWriteEnabled: false });
  assert.equal(blocked.status, 'provider_authority_conflict');
  assert.equal(blocked.request.status, REQUEST_STATUS.IN_REVIEW);

  await pool.query(
    `UPDATE booking_provider_references
     SET provider_reference = 'event-cleaned', state = 'cancelled', updated_at = $4
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A, new Date('2026-08-25T17:05:00.000Z')],
  );
  const confirmed = await confirm(repo, TENANT_A, REQUEST_A1, { calendarWriteEnabled: false });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.request.status, REQUEST_STATUS.CONFIRMED);
});

test('write-disabled confirmation atomically terminalizes exactly one compensated reference', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await pool.query(
    `UPDATE booking_provider_references
     SET state = 'compensated'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A],
  );
  const audits = [];
  const lockOrder = [];
  const orderedPool = poolWithQueryHooks(pool, {
    after: {
      'calendar-authority-complete-pre-confirmation-cleanup'() {
        lockOrder.push('cleanup-finalized');
      },
      'request-revision-watermark-lock'() {
        lockOrder.push('revision-locked');
      },
    },
  });
  const repo = repository(orderedPool, {
    async appendWithClient(_client, event) {
      audits.push(event);
      lockOrder.push(event.test === 'calendar-cleanup' ? 'cleanup-audited' : 'request-audited');
      return { id: `audit-${audits.length}` };
    },
  });

  const missingDescriptor = await confirm(repo, TENANT_A, REQUEST_A1, {
    calendarWriteEnabled: false,
  });
  assert.equal(missingDescriptor.status, 'provider_authority_conflict');
  const wrongDescriptor = await confirm(repo, TENANT_A, REQUEST_A1, {
    calendarWriteEnabled: false,
    calendarCleanup: {
      ...calendarCleanup(),
      reference: { ...cleanupReference(), providerReference: 'wrong-event' },
    },
  });
  assert.equal(wrongDescriptor.status, 'provider_authority_conflict');

  const extraIntegrationId = 'abababab-abab-4bab-8bab-abababababab';
  await pool.query(
    `INSERT INTO integrations (tenant_id, id, provider, provider_reference, status)
     VALUES ($1, $2, 'calendar_test', 'extra-connection', 'connected')`,
    [TENANT_A, extraIntegrationId],
  );
  await pool.query(
    `INSERT INTO booking_provider_references (
       tenant_id, request_id, integration_id, attempt_number, provider_reference,
       provider_connection_reference, provider_resource_reference, idempotency_key,
       state, created_correlation_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 'extra-event', 'extra-connection', $4, $5,
       'compensated', $6, $7, $7)`,
    [TENANT_A, REQUEST_A1, extraIntegrationId, RESOURCE_A, 'e'.repeat(64), BINDING_A, CHANGED_AT],
  );
  const ambiguous = await confirm(repo, TENANT_A, REQUEST_A1, {
    calendarWriteEnabled: false,
    calendarCleanup: calendarCleanup(),
  });
  assert.equal(ambiguous.status, 'provider_authority_conflict');
  await pool.query(
    'DELETE FROM booking_provider_references WHERE tenant_id = $1 AND integration_id = $2',
    [TENANT_A, extraIntegrationId],
  );
  await pool.query(
    'DELETE FROM integrations WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, extraIntegrationId],
  );

  const confirmed = await confirm(repo, TENANT_A, REQUEST_A1, {
    calendarWriteEnabled: false,
    calendarCleanup: calendarCleanup(),
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.request.status, REQUEST_STATUS.CONFIRMED);
  const persisted = await pool.query(
    `SELECT target_request.status, booking.state
     FROM requests target_request
     JOIN booking_provider_references booking
       ON booking.tenant_id = target_request.tenant_id AND booking.request_id = target_request.id
     WHERE target_request.tenant_id = $1 AND target_request.id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  assert.deepEqual(persisted.rows, [{ status: REQUEST_STATUS.CONFIRMED, state: 'cancelled' }]);
  assert.deepEqual(audits, [
    { test: 'calendar-cleanup' },
    { actorUserId: USER_A, correlationId: CORRELATION_CONFIRM, test: true },
  ]);
  assert.deepEqual(lockOrder, [
    'cleanup-finalized',
    'revision-locked',
    'cleanup-audited',
    'request-audited',
  ]);
});

test('write-disabled room conflict retains compensated cleanup for a later write retry', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A2, USER_A);
  await pool.query(
    `UPDATE booking_provider_references
     SET state = 'compensated'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A],
  );
  await pool.query(
    `UPDATE requests SET status = 'Confirmed'
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, REQUEST_A2],
  );
  const audits = [];
  const result = await confirm(repository(pool, {
    async appendWithClient(_client, event) {
      audits.push(event);
      return { id: 'unexpected-audit' };
    },
  }), TENANT_A, REQUEST_A1, {
    calendarWriteEnabled: false,
    calendarCleanup: calendarCleanup(),
  });
  assert.equal(result.status, 'room_conflict');
  const persisted = await pool.query(
    `SELECT target_request.status, booking.state
     FROM requests target_request
     JOIN booking_provider_references booking
       ON booking.tenant_id = target_request.tenant_id AND booking.request_id = target_request.id
     WHERE target_request.tenant_id = $1 AND target_request.id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  assert.deepEqual(persisted.rows, [{ status: REQUEST_STATUS.IN_REVIEW, state: 'compensated' }]);
  assert.deepEqual(audits, []);
});

test('calendar cleanup audit failure rolls back both confirmation and terminalization', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await pool.query(
    `UPDATE booking_provider_references
     SET state = 'compensated'
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A],
  );
  const repo = repository(pool, {
    async appendWithClient(_client, event) {
      if (event.test === 'calendar-cleanup') throw new Error('AUDIT_APPEND_FAILED');
      return { id: 'test-audit' };
    },
  });
  await assert.rejects(
    confirm(repo, TENANT_A, REQUEST_A1, {
      calendarWriteEnabled: false,
      calendarCleanup: calendarCleanup(),
    }),
    /AUDIT_APPEND_FAILED/,
  );
  const persisted = await pool.query(
    `SELECT target_request.status, booking.state
     FROM requests target_request
     JOIN booking_provider_references booking
       ON booking.tenant_id = target_request.tenant_id AND booking.request_id = target_request.id
     WHERE target_request.tenant_id = $1 AND target_request.id = $2`,
    [TENANT_A, REQUEST_A1],
  );
  assert.deepEqual(persisted.rows, [{ status: REQUEST_STATUS.IN_REVIEW, state: 'compensated' }]);
});
